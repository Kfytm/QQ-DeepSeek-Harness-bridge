// 插件加载冒烟测试：在**不启动 DSH、不连 SnowLuma** 的前提下，
// 把「启动期才会暴露、而且往往静默失败」的几类错误一次性抓出来。
//
// 为什么需要它：这轮改造里，用户被迫重启了 6 次，每次才发现一个新的启动期错误：
//   · require 在 ESM 里不存在（函数体内，调用时才炸）
//   · 访问未 inject 的服务（cannot get property without inject）
//   · 服务名拼错
// 这些全都能在本地静态检查出来，没有一条需要真的重启 DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-agent-host');
const ENTRY = path.join(PLUGIN_DIR, 'index.js');
const ADAPTER = path.join(PLUGIN_DIR, 'lib', 'adapter.js');

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const read = (p) => fs.readFileSync(p, 'utf8');

// DSH 的 cordis 服务名全集（本机能查到的那些包声明的 Context 成员）。
// 这里只用于「访问了 ctx.x 就必须 inject x」的校验，不要求穷举。
const CTX_NON_SERVICE = new Set(['on', 'effect', 'inject', 'dispose', 'scope', 'get', 'set', 'plugin', 'root', 'logger']);

await test('模块能加载，导出 name / inject / Config / apply', async () => {
  const mod = await import(pathToFileURL(ENTRY).href);
  assert.equal(mod.name, 'qq-agent-host');
  assert.ok(Array.isArray(mod.inject) && mod.inject.length > 0, 'inject 必须是非空数组');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(mod.Config, '必须导出 Config（schemastery schema）');
});

await test('源码里没有 require（ESM 模块里它在函数体内也照样炸）', () => {
  for (const [label, file] of [['index.js', ENTRY], ['adapter.js', ADAPTER]]) {
    const src = read(file);
    // 排除注释里的 require 字样
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /\brequire\s*\(/, `${label} 里出现了 require(`);
  }
});

await test('所有 ctx.<service> 访问都在 inject 里声明', async () => {
  const mod = await import(pathToFileURL(ENTRY).href);
  const injected = new Set(mod.inject);
  const problems = [];
  for (const [label, file] of [['index.js', ENTRY], ['adapter.js', ADAPTER]]) {
    const src = read(file);
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of codeOnly.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)) {
      const name = m[1];
      if (CTX_NON_SERVICE.has(name)) continue;
      if (!injected.has(name)) problems.push(`${label}: ctx.${name}`);
    }
  }
  assert.deepEqual(problems, [],
    `这些服务被访问但没写进 inject ⇒ cordis 会抛 "cannot get property ... without inject"：\n  ${problems.join('\n  ')}`);
});

await test('inject 里没有重复项（重复声明会让 cordis 行为不确定）', async () => {
  const mod = await import(pathToFileURL(ENTRY).href);
  const dup = mod.inject.filter((v, i) => mod.inject.indexOf(v) !== i);
  assert.deepEqual(dup, [], `inject 有重复：${dup.join(', ')}`);
});

await test('Config 默认值合理（enabled 默认 false，不会自己抢号）', async () => {
  const mod = await import(pathToFileURL(ENTRY).href);
  const cfg = mod.Config({});
  assert.equal(cfg.enabled, false, 'enabled 必须默认 false —— 否则插件一被装载就去抢 QQ 号');
  assert.equal(typeof cfg.bridgeRoot, 'string');
  assert.equal(cfg.agentPreset, 'qq-chat-v2');
});

await test('设置接口对 enabled 双向处理（读返回 + 写回 settings）', async () => {
  const src = read(ENTRY);
  // GET /config 必须把 enabled 放进返回值，否则界面拿到 undefined → 开关永远显示关闭
  assert.match(src, /enabled:\s*\(\(\)\s*=>/, 'GET /config 的返回值里缺少 enabled');
  // POST /config 必须把 enabled 写回 ctx.settings，否则保存被静默忽略
  assert.match(src, /settingsPatch\.enabled\s*=\s*patch\.enabled/, 'POST /config 没有处理 enabled');
});

await test('Config 有 volatile 字段（否则插件不出现在设置页、也没法开关）', async () => {
  const mod = await import(pathToFileURL(ENTRY).href);
  // 复刻 dsh-settings 的过滤逻辑：只保留 meta.volatile 为真的字段，
  // 一个都没有时返回 undefined，那个 entry 就被 describe() 跳过了。
  function volatileForm(schema) {
    if (schema.meta?.volatile) return 'PLAIN';
    if (schema.type === 'object') {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([k, c]) => {
        const field = volatileForm(c);
        return field === undefined ? [] : [[k, field]];
      }));
      return Object.keys(dict).length === 0 ? undefined : 'OBJECT';
    }
    return undefined;
  }
  assert.notEqual(volatileForm(mod.Config), undefined,
    'Config 里至少要有一个字段标了 volatile，否则插件不会出现在 DSH 设置页（不报错）');
  assert.equal(mod.Config({}).enabled, false, 'enabled 默认必须是 false —— 否则装载就抢号');
});

await test('适配层导出的工厂与 userMessage 形状正确', async () => {
  const mod = await import(pathToFileURL(ADAPTER).href);
  assert.equal(typeof mod.createDshAdapter, 'function');
  assert.equal(typeof mod.userMessage, 'function');
  const msg = mod.userMessage('测试');
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.source, { kind: 'user' });
  assert.deepEqual(msg.content, [{ type: 'text', text: '测试' }]);
});

await test('适配层的每个 api 方法都返回 { result: { ok, value } } 包装', async () => {
  // bridge.js 用 unwrap() 拆这层包装；形状错了会在运行期静默变成 undefined。
  const { createDshAdapter } = await import(pathToFileURL(ADAPTER).href);
  const calls = { created: [], followup: [], dispose: [] };
  const ctx = {
    agents: {
      create: async ({ sessionId, setup }) => {
        calls.created.push(sessionId);
        const agent = { session: { rename() {} }, followup: (m) => calls.followup.push(m), steer() {}, cancel() {}, options: {} };
        // setup 是 async（里面要 await agentPresets.mount），必须 await。
        // 不 await 的话断言会在挂载完成前执行 —— 那样「没挂上」和「挂了」看起来一样。
        await setup?.({ systemPrompt: { section: () => () => {} }, tools: {} }, agent);
        return { agent, dispose: async () => calls.dispose.push(sessionId) };
      }
    },
    settings: { describe: () => [], update: async () => {} },
    agentPresets: { list: async () => [{ id: 'qq-chat-v2' }], mount: async (_ctx, id) => { calls.mounted = id; return { id }; } },
    sessionTitle: { rename() {} },
    workspaceRegistry: { create: async () => ({ id: 'w1', attachSession: async () => {}, setTitle: async () => {} }), get: () => undefined }
  };
  const a = createDshAdapter({ ctx, log: () => {} });
  const check = (label, value) => {
    assert.ok(value && typeof value === 'object', `${label} 必须返回对象`);
    assert.equal(value.result?.ok, true, `${label} 必须带 result.ok=true`);
    assert.ok('value' in (value.result ?? {}), `${label} 必须带 result.value`);
  };
  check('workspace.create', await a.api.workspace.create({ path: 'D:/tmp/qq-agent-host-smoke' }));
  check('sessions.create', await a.api.sessions.create({ targetKey: 'group:1', agentPreset: 'qq-chat-v2' }));
  // ★ 建 agent 时必须调 agentPresets.mount(agentCtx, id)：
  //   只传 meta.agentPreset 不会触发装配，system prompt 里会没有主人格/安全规则。
  assert.equal(calls.mounted, 'qq-chat-v2', 'sessions.create 必须真正挂载 preset（meta.agentPreset 只是标签）');
  check('settings.describe', await a.api.settings.describe({}));
  check('agentPresets.list', await a.api.agentPresets.list({}));
  check('workspace.rename', await a.api.workspace.rename({ workspaceId: 'w1', title: 'QQ 聊天' }));
  assert.equal(calls.created.length, 1, 'sessions.create 应该真的建了 agent');
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
