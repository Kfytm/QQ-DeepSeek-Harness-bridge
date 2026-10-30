// qq-agent-host —— 把 QQ 会话做成第一等的 DSH agent。
//
// 和旧的 qq-bridge 的本质区别：
//   · 旧：独立 Node 进程 → HTTP `session/prompt` → DSH 会话里塞一大段「唤醒提示」
//     （时间/角色卡/状态/快照全在 user message 里，永久留在历史里）
//   · 新：本插件在 DSH 进程内 → `ctx.agents.create()` → `agent.followup()`
//     prompt 的静态部分走 `systemPrompt.section`，动态部分走 `systemPrompt.context`，
//     工具面走 `systemPrompt.tools` / `agentCtx.tools.register`
//
// 装载方式：cordis.patch.yml 插入一行，`enabled` 默认 false。
// 关着的时候插件只被加载、不启动任何东西，不会和正在跑的 bridge 抢 QQ 号。
import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'qq-agent-host';
// 需要的服务：
//   agents        —— 建/取 agent（会话的归宿）
//   systemPrompt  —— 装配静态规则与动态状态（后续阶段用）
//   tools         —— 注册工具
//   settings      —— 读 qq-mode（当前模式决定挂哪个 preset）；读不到会让模式永远停在默认的 chat
//   agentPresets  —— 校验 preset 是否存在；返回空会让每个会话都被拒绝创建
//   sessionTitle  —— 给会话起可读名字（否则 GUI 里是截断的 prompt 开头）
//   workspaceRegistry —— 拿真实 Workspace 实体，给工作区设标题（否则显示「未命名」）
//
// 注意：**凡是代码里访问的服务，都必须写进 inject**。cordis 里访问未声明的服务会
// 直接抛 `cannot get property "x" without inject`（不是返回 undefined），所以 ?. 救不了。
export const inject = ['agents', 'systemPrompt', 'tools', 'settings', 'agentPresets', 'sessionTitle', 'workspaceRegistry', 'webServer'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ★ 每个字段都必须带 volatile 标记，否则**整个插件不会出现在 DSH 的设置页**。
//
// 机制在 dsh-settings 里：`describe()` 用 `volatileForm(schema)` 过滤，
// 它只保留 `meta.volatile` 为真的字段；一个都没有时返回 undefined，这个 entry 就被跳过
// —— 表现是「插件在跑，但设置页里找不到它，也就没法关掉」。
//
// 注意写法：DSH 内部用的是 `z.xxx().volatile()`，但那是**客户端**给 Schema.prototype 打的
// 补丁（见 dsh-client-connection/lib/client.js），插件侧这份 schemastery 没有这个方法。
// 所以这里直接往 meta 上写 —— 实测 `schema.meta.volatile = true` 就是 describe 读的那个位置。
const markVolatile = (schema) => {
  schema.meta.volatile = true;
  return schema;
};

export const Config = z.object({
  /** 总开关。默认关：装载但不启动，避免和独立运行的 bridge 抢同一个 QQ 号。 */
  enabled: markVolatile(z.boolean().default(false)),
  /** bridge 副本的根目录（含 config.json 与 src/）。留空 = 相对本插件的 ../../ */
  bridgeRoot: markVolatile(z.string().default('')),
  /** 建 agent 时用哪个 DSH 预设 */
  agentPreset: markVolatile(z.string().default('qq-chat-v2')),

  // ── 以下字段会覆盖 config.json 里的同名项（只覆盖这里填了值的）────────────────
  // 这些是日常要改的东西：换 SnowLuma 地址、换 token、加白名单群。
  // 注意它们是**内存覆盖**，不写回 config.json —— 磁盘那份仍是权威，出问题可对照。

  /** SnowLuma 的 OneBot WebSocket 地址，如 ws://127.0.0.1:3001 */
  snowlumaWsUrl: markVolatile(z.string().default('')),
  /** SnowLuma 的 OneBot HTTP API 地址，如 http://127.0.0.1:3000（别填 WS 端口） */
  snowlumaHttpUrl: markVolatile(z.string().default('')),
  /** SnowLuma access token（换号或重装后要更新） */
  snowlumaToken: markVolatile(z.string().default('')),
  /** 本地控制台 token（她调 qq_* 工具时用；改了会让正在跑的回合失效） */
  consoleToken: markVolatile(z.string().default('')),
  /** 管理员 QQ 号（只有这个人能下指令） */
  ownerQQ: markVolatile(z.string().default('')),
  /** 允许接管的私聊 QQ 号列表 */
  allowPrivate: markVolatile(z.array(z.string()).default([])),
  /** 允许接管的群号列表 */
  allowGroups: markVolatile(z.array(z.string()).default([])),
  /** 当前副卡名（roles/ 下的文件名，不含 .md）；留空 = 不改桥接当前绑定 */
  currentRole: markVolatile(z.string().default(''))
});

/**
 * 清理上一次运行留下的 qq- 会话。
 *
 * 只删前缀为 `qq-` 的会话目录与其投影缓存 —— 那是本插件自己建的会话，
 * 对应的 agent 已随 DSH 重启消失，留着只会让 GUI 里的会话列表越来越长。
 * 用户自己开的会话、子代理会话一律不碰。
 * @returns 删掉的会话目录数
 */
/**
 * 把已经删掉的会话从所有工作区的 sessionIds 里摘掉。
 *
 * 为什么需要：清理只删了会话目录和投影缓存，但 workspaces.sessionIds 里还留着
 * 那些 id 的引用 —— GUI 会话列表里就会出现「点不开的条目」。
 */
async function detachStaleFromWorkspaces(ctx, removedIds, log) {
  if (!removedIds.length) return;
  const registry = ctx.workspaceRegistry;
  if (!registry?.list) return;
  const wanted = new Set(removedIds);
  let detached = 0;
  try {
    for (const ws of registry.list() ?? []) {
      const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      for (const sid of ids) {
        if (!wanted.has(sid)) continue;
        try { await ws.detachSession?.(sid); detached += 1; } catch {}
      }
    }
  } catch (error) {
    log(`从工作区摘除旧会话失败：${error?.message ?? error}`);
  }
  if (detached > 0) log(`已从工作区摘除 ${detached} 条失效会话引用`);
}

function cleanupStaleQqSessions(log) {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const sessionsDir = path.join(base, 'sessions');
  const projDir = path.join(base, 'storages', 'session_projcache', 'sessions');
  let removed = 0;
  /** 被删掉的会话 id，供工作区 detach 用。 */
  const removedIds = [];
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const group of fs.readdirSync(sessionsDir)) {
        const groupPath = path.join(sessionsDir, group);
        let isDir = false;
        try { isDir = fs.statSync(groupPath).isDirectory(); } catch { continue; }
        if (!isDir) continue;
        for (const name of fs.readdirSync(groupPath)) {
          if (!name.startsWith('qq-')) continue;
          try { fs.rmSync(path.join(groupPath, name), { recursive: true, force: true }); removed += 1; removedIds.push(name); } catch {}
        }
      }
    }
    if (fs.existsSync(projDir)) {
      for (const name of fs.readdirSync(projDir)) {
        if (!name.startsWith('qq-')) continue;
        try { fs.rmSync(path.join(projDir, name), { force: true }); } catch {}
      }
    }
  } catch (error) {
    log(`清理旧 qq- 会话失败：${error?.message ?? error}`);
  }
  return { removed, removedIds };
}

export async function apply(ctx, config) {
  const log = (msg) => console.log(`[qq-agent-host] ${msg}`);
  // ⚠️ 设置接口必须注册在 enabled 检查**之前**：
  // 否则 enabled=false 时插件直接 return，路由不存在，用户就没法从界面把它打开，
  // 只能回去改 YAML 重启 —— 那正是这个界面要解决的问题。

  // ── 设置页的 HTTP 接口 ──────────────────────────────────────────────────
  // 设置页（client.js）跑在浏览器里，拿不到 cordis ctx，只能回源到插件。
  // DSH 会把 /api/qq-agent-host/* 原样交给这个 handler。
  const ENTRY_ID = 'qq-agent-host';
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
  const sendJson = (res, code, body) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/qq-agent-host',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          if (req.method === 'GET' && url.pathname === '/api/qq-agent-host/config') {
            // 读 config.json 的真实值（这才是生效的配置）。
            const cfgPath = path.join(config?.bridgeRoot || path.resolve(__dirname, '..', '..'), 'config.json');
            let raw = {};
            try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { raw = {}; }
            const allow = raw.allow ?? {};
            const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(String).map((s) => s.trim()).filter(Boolean);
            const flat = {
              // enabled 不在 config.json 里，它是插件的 Config（DSH settings）
              enabled: (() => {
                try {
                  const row = (ctx.settings.describe() ?? []).find((r) => r.ns === ENTRY_ID);
                  return Boolean(row?.value?.enabled);
                } catch { return false; }
              })(),
              snowlumaWsUrl: raw.snowluma?.wsUrl ?? '',
              snowlumaHttpUrl: raw.snowluma?.httpUrl ?? '',
              snowlumaToken: raw.snowluma?.accessToken ?? '',
              consoleToken: raw.consoleToken ?? '',
              ownerQQ: String(raw.ownerQQ ?? ''),
              allowPrivate: asList(allow.private),
              allowGroups: asList(allow.groups),
              agentPreset: config?.agentPreset ?? 'qq-chat-v2',
              currentRole: (() => {
                try {
                  const rp = path.join(config?.bridgeRoot || path.resolve(__dirname, '..', '..'), 'state', 'current-role.json');
                  return JSON.parse(fs.readFileSync(rp, 'utf8')).role ?? '';
                } catch { return ''; }
              })(),
            };
            return sendJson(res, 200, { ok: true, value: flat, source: 'config.json', path: cfgPath });
          }
          if (req.method === 'POST' && url.pathname === '/api/qq-agent-host/config') {
            const body = await readJsonBody(req);
            const patch = body.patch ?? {};
            const cfgPath = path.join(config?.bridgeRoot || path.resolve(__dirname, '..', '..'), 'config.json');
            let raw = {};
            try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { raw = {}; }
            // 先备份，改坏了能回退
            try { fs.copyFileSync(cfgPath, `${cfgPath}.bak-${Date.now()}`); } catch {}
            raw.snowluma = raw.snowluma ?? {};
            raw.allow = raw.allow ?? {};
            const setIfPresent = (k) => { if (typeof patch[k] === 'string') return patch[k]; return null; };
            for (const [k, key] of [['snowlumaWsUrl', 'wsUrl'], ['snowlumaHttpUrl', 'httpUrl'], ['snowlumaToken', 'accessToken']]) {
              const v = setIfPresent(k);
              if (v !== null) raw.snowluma[key] = v;
            }
            if (typeof patch.consoleToken === 'string') raw.consoleToken = patch.consoleToken;
            if (typeof patch.ownerQQ === 'string') raw.ownerQQ = patch.ownerQQ;
            // ⚠️ 必须写成**数组**：桥接的 normalizeIdList() 只认数组，字符串会直接返回空，
            // 于是白名单判定为空、整个桥接不响应任何消息（实测踩过）。
            if (Array.isArray(patch.allowPrivate)) raw.allow.private = patch.allowPrivate.map(String).filter(Boolean);
            if (Array.isArray(patch.allowGroups)) raw.allow.groups = patch.allowGroups.map(String).filter(Boolean);
            fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
            // enabled / agentPreset 属于 DSH 层配置（插件的 Config），走 settings
            const settingsPatch = {};
            if (typeof patch.enabled === 'boolean') settingsPatch.enabled = patch.enabled;
            if (typeof patch.agentPreset === 'string' && patch.agentPreset) settingsPatch.agentPreset = patch.agentPreset;
            if (Object.keys(settingsPatch).length) {
              try {
                const row = (ctx.settings.describe() ?? []).find((r) => r.ns === ENTRY_ID);
                if (row) await ctx.settings.update(ENTRY_ID, settingsPatch, row.revision);
              } catch (error) {
                log(`写 settings 失败：${error?.message ?? error}`);
              }
            }
            return sendJson(res, 200, { ok: true, note: '已写入 config.json（备份在同目录 *.bak-时间戳）。桥接配置需要重启 DSH 才生效。', path: cfgPath });
          }
          if (req.method === 'GET' && url.pathname === '/api/qq-agent-host/roles') {
            // 只读：列出 roles/ 下的卡。注意 root 在 enabled 检查之后才定义，
            // 这里自己算一次（路由注册在检查之前，拿不到那个变量）。
            const roleRoot = config?.bridgeRoot || path.resolve(__dirname, '..', '..');
            const rolesDir = path.join(roleRoot, 'roles');
            let roles = [];
            try {
              roles = fs.readdirSync(rolesDir)
                .filter((n) => n.endsWith('.md') && n !== 'README.md')
                .map((n) => {
                  const full = path.join(rolesDir, n);
                  let title = n.replace(/\.md$/, '');
                  let size = 0;
                  try {
                    size = fs.statSync(full).size;
                    // 取第一行标题（`# 角色卡：xxx` → xxx）
                    const head = fs.readFileSync(full, 'utf8').split('\n').slice(0, 5).join('\n');
                    const m = /^#\s*(.+)$/m.exec(head);
                    if (m) title = m[1].replace(/^角色卡[:：]?\s*/, '').trim();
                  } catch { /* 读不到就用文件名 */ }
                  return { name: n.replace(/\.md$/, ''), title, size };
                });
            } catch (error) {
              return sendJson(res, 200, { ok: true, roles: [], note: `读不到 roles/ 目录：${error?.message ?? error}` });
            }
            // 当前绑定：优先 config 里配的，否则读桥接的状态文件
            let current = config?.currentRole || null;
            if (!current) {
              try {
                const stateFile = path.join(roleRoot, 'state', 'current-role.json');
                current = JSON.parse(fs.readFileSync(stateFile, 'utf8')).role ?? null;
              } catch { /* 没有就是没绑过 */ }
            }
            return sendJson(res, 200, { ok: true, roles, current });
          }
          if (req.method === 'GET' && url.pathname === '/api/qq-agent-host/status') {
            return sendJson(res, 200, {
              ok: true,
              enabled: Boolean(config?.enabled),
              sessions: [...(adapter?.live?.keys?.() ?? [])],
            });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    }), 'qq-agent-host: /api/qq-agent-host 设置接口');
  } catch (error) {
    log(`设置接口没挂上：${error?.message ?? error}`);
  }

  if (!config?.enabled) {
    log('未启用（enabled=false），不启动');
    return;
  }
  const root = config.bridgeRoot || path.resolve(__dirname, '..', '..');
  const bridgeEntry = path.join(root, 'src', 'bridge.js');
  if (!fs.existsSync(bridgeEntry)) {
    log(`找不到桥接副本：${bridgeEntry}（检查 config.bridgeRoot）`);
    return;
  }

  // 动态 import：只有真正启用时才加载 1.3 万行的桥接代码。
  const { startBridge } = await import(new URL(`file://${bridgeEntry.replace(/\\/g, '/')}`).href);
  const { createDshAdapter } = await import('./lib/adapter.js');

  // hooks 是**可变容器**：startBridge 启动时往里填生成器，而 agent 是在它
  // 启动过程中才建的 —— 所以只能先传空对象，不能等返回值。
  const hooks = {};

  const adapter = createDshAdapter({
    ctx,
    config,
    log,
    hooks,
    onAgentCreated: ({ agentCtx, agent, targetKey }) => {
      // 这里注册的东西只影响这一个 agent —— 这就是「per-agent persona」的正确位置。
      // 具体装哪些段由 bridge 侧根据当前 mode / 角色卡决定，通过 adapter 暴露的钩子回填。
      log(`agent 装配 ${targetKey}`);
    }
  });

  // 把 DSH 的 session 事件转成 bridge.js 认的帧（它内部用 pumpMux 消费）。
  // 只转发本插件管辖的会话：别的会话（用户自己开的、子代理）一律不进桥接。
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id ?? session?.sessionId;
    if (!sessionId || !adapter.live.has(sessionId)) return;
    adapter.publish(sessionId, event);
  });

  // bridge.js 的启动入口：把适配层交进去，它就不再自建 NodeApiClient。
  // 注意 startBridge 内部已经把 pumpMux 改成不阻塞，所以这里 await 会正常返回。
  // 先清掉上一次运行遗留的 qq- 会话（agent 已随 DSH 重启消失，留着只会在 GUI 里堆积）。
  // 删文件之后还要从工作区 detach，否则 sessionIds 里会留下打不开的僵尸引用。
  const stale = cleanupStaleQqSessions(log);
  if (stale.removed > 0) {
    log(`已清理 ${stale.removed} 个上一次运行遗留的 QQ 会话`);
    await detachStaleFromWorkspaces(ctx, stale.removedIds, log);
  }

  // 把 Config 里填了值的字段整理成桥接的配置覆盖（点分路径）。
  // 空字符串/空数组一律跳过 —— 否则「没填」会把 config.json 里的真实值冲掉。
  const configOverrides = {};
  if (config.snowlumaWsUrl) configOverrides['snowluma.wsUrl'] = config.snowlumaWsUrl;
  if (config.snowlumaHttpUrl) configOverrides['snowluma.httpUrl'] = config.snowlumaHttpUrl;
  if (config.snowlumaToken) configOverrides['snowluma.accessToken'] = config.snowlumaToken;
  if (config.consoleToken) configOverrides.consoleToken = config.consoleToken;
  if (config.ownerQQ) configOverrides.ownerQQ = config.ownerQQ;
  if (Array.isArray(config.allowPrivate) && config.allowPrivate.length) {
    // ⚠️ 保持数组：loadConfig 会原样覆盖到 cfg.allow.private，
    // 而 normalizeIdList() 只认数组 —— join(',') 会让白名单变成空（静默失效）。
    configOverrides['allow.private'] = config.allowPrivate.map(String);
  }
  if (Array.isArray(config.allowGroups) && config.allowGroups.length) {
    configOverrides['allow.groups'] = config.allowGroups.map(String);
  }
  if (Object.keys(configOverrides).length) {
    log(`配置覆盖：${Object.keys(configOverrides).join(
)}`);
  }

  const handle = await startBridge({ api: adapter.api, config, adapter, log, hooksOut: hooks, configOverrides });
  log('桥接已在内嵌模式启动');

  // 插件卸载时释放：先让桥接收尾，再释放 agent。
  ctx.on('dispose', async () => {
    try { await handle?.stop?.(); } catch (error) { log(`停止桥接失败：${error?.message ?? error}`); }
    for (const { handle: agentHandle } of adapter.live.values()) {
      try { await agentHandle.dispose(); } catch {}
    }
    adapter.live.clear();
  });
}
