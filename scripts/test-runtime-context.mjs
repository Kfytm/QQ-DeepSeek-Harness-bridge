// 运行时面板搬进 systemPrompt.context() 的断言。
//
// 要钉住：
//   1. adapter 在 agent 作用域注册了 `qq:runtime` context
//   2. 它的 text 是函数（每轮重新求值，不是拍快照）
//   3. 内嵌模式（有 injectedApi）唤醒提示里**不再有**这四段
//   4. 独立模式（没有 injectedApi）仍然拼回提示（回退行为不变）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'plugins', 'qq-agent-host', 'lib', 'adapter.js');

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function makeCtx(hooks, collected) {
  return {
    agents: {
      create: async ({ setup }) => {
        const agentCtx = {
          systemPrompt: {
            section: (s) => { collected.sections.push(s); return () => {}; },
            context: (c) => { collected.contexts.push(c); return () => {}; }
          }
        };
        const agent = { session: { rename() {} }, followup() {}, steer() {}, cancel() {}, options: {} };
        // setup 是 async（里面要 await mount），必须 await。
        await setup?.(agentCtx, agent);
        return { agent, dispose: async () => {} };
      }
    },
    agentPresets: { list: async () => [], mount: async () => ({ id: 'qq-chat-v2' }) },
    settings: { describe: () => [], update: async () => {} },
    sessionTitle: { rename() {} },
    workspaceRegistry: { create: async () => null, get: () => undefined }
  };
}

const { createDshAdapter } = await import(pathToFileURL(ADAPTER).href);

await test('adapter 注册 qq:runtime context，text 是函数', async () => {
  const collected = { sections: [], contexts: [] };
  let panelCalls = 0;
  const hooks = { runtimePanel: () => { panelCalls += 1; return 'PANEL_TEXT'; } };
  const a = createDshAdapter({ ctx: makeCtx(hooks, collected), hooks, log: () => {} });
  await a.api.sessions.create({ targetKey: 'group:1', agentPreset: 'qq-chat-v2' });

  const entry = collected.contexts.find((c) => c.name === 'qq:runtime');
  assert.ok(entry, `没注册 qq:runtime，实际注册了：${collected.contexts.map((c) => c.name).join(', ') || '(无)'}`);
  assert.equal(typeof entry.text, 'function', 'text 必须是函数（每轮求值），否则状态不会刷新');
  assert.equal(typeof entry.order, 'number', 'order 必须是数字');
  assert.equal(entry.text(), 'PANEL_TEXT', 'text 应该调用 hooks.runtimePanel');
  assert.equal(panelCalls, 1, `runtimePanel 应被调用一次，实际 ${panelCalls}`);
});

await test('没有 hooks 时不注册 context（独立模式不崩）', async () => {
  const collected = { sections: [], contexts: [] };
  const a = createDshAdapter({ ctx: makeCtx(null, collected), log: () => {} });
  await a.api.sessions.create({ targetKey: 'group:1' });
  assert.equal(collected.contexts.length, 0, '没有 hooks 就不该注册 context');
});

await test('bridge 里有 runtimePanelV2，且 panelLine 按 injectedApi 分流', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /function runtimePanelV2\(key\)/, '缺 runtimePanelV2 生成器');
  assert.match(src, /options\.hooksOut\.runtimePanel/, '没挂到 hooksOut，插件拿不到');
  // ★ 关键：内嵌模式必须把这四段从 user message 里去掉，否则「搬家」等于搬家又留了一份。
  assert.match(src, /const panelLine = injectedApi \? '' : runtimePanelV2\(key\)/,
    'panelLine 没有按 injectedApi 分流 —— 内嵌模式仍会把四段拼进 user message');
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
