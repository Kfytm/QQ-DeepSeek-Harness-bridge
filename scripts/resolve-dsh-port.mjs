// 探测本机回环上真正的 DSH web 端口，并写回 config.json 的 dsh.baseUrl。
//
// 为什么需要这个：DSH 桌面版由 dsh-desktop-host 以 `--port 0` 启动，每次随机分配端口，
// 没有配置项可以固定（见 @deepseek-ai/dsh-desktop-host/lib/index.js 的 args）。
// 所以 baseUrl 不能写死，启动桥接前探测一次、写回即可。
//
// 识别依据：DSH 的 /api/remote.mux 在未鉴权时返回 401，响应体恰好是纯文本
// `unauthorized`。同机的 memos viewer 返回 JSON（unauthenticated），SnowLuma
// 返回 {status:"failed",retcode:1401}，据此可区分。
//
// 用法：
//   node scripts/resolve-dsh-port.mjs           探测并写回 config.json
//   node scripts/resolve-dsh-port.mjs --check   只打印，不写回
//   node scripts/resolve-dsh-port.mjs --quiet   仅输出一行结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.join(root, 'config.json');
const checkOnly = process.argv.includes('--check');
const quiet = process.argv.includes('--quiet');

const log = (msg) => {
  if (!quiet) console.log(`[resolve-dsh-port] ${msg}`);
};

/** netstat -ano 里 127.0.0.1 上的 LISTENING 端口。 */
function listeningLoopbackPorts() {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano'], { encoding: 'latin1', timeout: 10000 });
  } catch {
    return [];
  }
  const ports = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\b/i);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

/** 该端口是否是 DSH 的 web 入口。 */
async function isDshPort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/remote.mux`, { signal: controller.signal });
    if (res.status !== 401) return false;
    const body = (await res.text()).trim();
    return body === 'unauthorized';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 读 config.json 当前 baseUrl（解析失败返回 null）。 */
function readCurrentBaseUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof cfg?.dsh?.baseUrl === 'string' ? cfg.dsh.baseUrl : null;
  } catch {
    return null;
  }
}

/** 把 baseUrl 写回 config.json，保持两空格缩进。 */
function writeBaseUrl(baseUrl) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

const candidates = listeningLoopbackPorts();
log(`回环监听端口 ${candidates.length} 个：${candidates.join(', ') || '(无)'}`);

const matches = [];
for (const port of candidates) {
  if (await isDshPort(port)) matches.push(port);
}

if (matches.length === 0) {
  // 探测不到就保留原配置：DSH 可能还没启动，桥接会按原值重连。
  const current = readCurrentBaseUrl();
  console.error('[resolve-dsh-port] 未发现 DSH（/api/remote.mux 无 401+unauthorized 响应），保留现有 baseUrl：' + (current ?? '(读取失败)'));
  process.exit(1);
}

const current = readCurrentBaseUrl();
const currentPort = current ? Number(new URL(current).port) : null;
// 多个命中时优先保持当前配置的那个，避免桥接状态无谓漂移。
const picked = matches.includes(currentPort) ? currentPort : matches[0];

if (matches.length > 1) {
  log(`命中多个候选 ${matches.join(', ')}，选用 ${picked}`);
}

const baseUrl = `http://127.0.0.1:${picked}`;
if (checkOnly) {
  console.log(baseUrl);
  process.exit(0);
}

if (current !== baseUrl) {
  writeBaseUrl(baseUrl);
  log(`已写回 config.json：${current ?? '(无)'} -> ${baseUrl}`);
} else {
  log(`baseUrl 无变化：${baseUrl}`);
}
console.log(`[resolve-dsh-port] DSH=${baseUrl}`);
