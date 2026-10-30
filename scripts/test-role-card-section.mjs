// 角色卡搬家（第 4 层第二步）的冒烟测试。
//
// 搬的是什么：卡全文从 **user message 末尾** 移到 **systemPrompt.section**。
// 要钉住的四条：
//   1. bridge 暴露了生成器（hooksOut.roleCardBlock）
//   2. adapter 在 agent 作用域真的注册了 section（name/order/text）
//   3. section 的 text 是**函数**且每次调用都重新求值（换卡才能生效）
//   4. 唤醒提示里**不再包含**卡全文（否则等于没搬，还多了一份）
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'plugins', 'qq-agent-host', 'lib', 'adapter.js');
const GROUP = 'group:456';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

await test('bridge 提供了 roleCardBlockV2，且能被 hooksOut 拿到', async () => {
  const h = await bridgeHarness({
    files: {
      'roles/1.md': '# 卡一\n\n## 一、你是谁\n- 我是 ROLE_ONE_MARK。\n'
    }
  });
  try {
    h.bindSessionRole(GROUP, '1');
    // harness 里 startBridge 已经跑过，hooksOut 不在 harness 签名里 —— 这里直接验证
    // 内部生成器的可见行为：唤醒提示里不该再有卡全文。
    const prompt = h.buildWakePromptV2(GROUP, 'atMention');
    assert.doesNotMatch(prompt, /【当前副卡 · /, '卡全文不该再出现在唤醒提示里（已搬到 section）');
    assert.doesNotMatch(prompt, /ROLE_ONE_MARK/, '卡正文不该再出现在唤醒提示里');
    assert.doesNotMatch(prompt, /【可选副卡】/, '可选卡清单也属于静态内容，应随卡一起搬到 section');
  } finally { await h.close(); }
});

await test('adapter 在 agent 作用域注册 qq:role-card section', async () => {
  const { createDshAdapter } = await import(pathToFileURL(ADAPTER).href);
  const registered = [];
  const mounted = [];
  const hooks = { roleCardBlock: (key) => `CARD_FOR_${key}` };
  const ctx = {
    agents: {
      create: async ({ setup }) => {
        const agentCtx = {
          systemPrompt: {
            section: (sec) => { registered.push(sec); return () => {}; }
          }
        };
        const agent = { session: { rename() {} }, followup() {}, steer() {}, cancel() {}, options: {} };
        await setup?.(agentCtx, agent);
        return { agent, dispose: async () => {} };
      }
    },
    settings: { describe: () => [], update: async () => {} },
    agentPresets: { list: async () => [], mount: async (_ctx, id) => { mounted.push(id); return { id }; } },
    sessionTitle: { rename() {} },
    workspaceRegistry: { create: async () => null, get: () => undefined }
  };
  const a = createDshAdapter({ ctx, hooks, log: () => {} });
  await a.api.sessions.create({ targetKey: GROUP, agentPreset: 'qq-chat-v2' });

  assert.deepEqual(mounted, ['qq-chat-v2'], 'setup 里必须先挂载 preset（否则主人格根本不加载）');
  assert.equal(registered.length, 1, `应该恰好注册一个 section，实际 ${registered.length}`);
  const sec = registered[0];
  assert.equal(sec.name, 'qq:role-card');
  assert.equal(typeof sec.order, 'number', 'order 必须是数字（决定在 system prompt 里的位置）');
  assert.equal(typeof sec.text, 'function', 'text 必须是函数：每次装配求值，换卡才能生效');
  assert.equal(sec.text(), `CARD_FOR_${GROUP}`, 'text 调用的应该是这个会话的卡块');
});

await test('section 的 text 是动态求值（换卡后立即反映新卡）', async () => {
  const { createDshAdapter } = await import(pathToFileURL(ADAPTER).href);
  let current = 'CARD_A';
  const registered = [];
  const mounted = [];
  const hooks = { roleCardBlock: () => current };
  const ctx = {
    agents: {
      create: async ({ setup }) => {
        const agentCtx = { systemPrompt: { section: (sec) => { registered.push(sec); return () => {}; } } };
        const agent = { session: { rename() {} }, followup() {}, steer() {}, cancel() {}, options: {} };
        await setup?.(agentCtx, agent);
        return { agent, dispose: async () => {} };
      }
    },
    settings: { describe: () => [], update: async () => {} },
    agentPresets: { list: async () => [], mount: async (_ctx, id) => { mounted.push(id); return { id }; } },
    sessionTitle: { rename() {} },
    workspaceRegistry: { create: async () => null, get: () => undefined }
  };
  const a = createDshAdapter({ ctx, hooks, log: () => {} });
  await a.api.sessions.create({ targetKey: GROUP });
  assert.equal(registered[0].text(), 'CARD_A');
  current = 'CARD_B'; // 模拟换卡
  assert.equal(registered[0].text(), 'CARD_B', 'text 必须每次求值，不能捕获旧值');
});

await test('没有 hooks 时不注册 section（独立运行模式下也不会崩）', async () => {
  const { createDshAdapter } = await import(pathToFileURL(ADAPTER).href);
  const registered = [];
  const mounted = [];
  const ctx = {
    agents: {
      create: async ({ setup }) => {
        const agentCtx = { systemPrompt: { section: (sec) => { registered.push(sec); return () => {}; } } };
        const agent = { session: { rename() {} }, followup() {}, steer() {}, cancel() {}, options: {} };
        await setup?.(agentCtx, agent);
        return { agent, dispose: async () => {} };
      }
    },
    settings: { describe: () => [], update: async () => {} },
    agentPresets: { list: async () => [], mount: async (_ctx, id) => { mounted.push(id); return { id }; } },
    sessionTitle: { rename() {} },
    workspaceRegistry: { create: async () => null, get: () => undefined }
  };
  const a = createDshAdapter({ ctx, log: () => {} }); // 不传 hooks
  await a.api.sessions.create({ targetKey: GROUP });
  assert.equal(registered.length, 0, '没有 hooks 就不该注册（避免注册一个返回空串的段）');
});

await test('bridge 源码里有 roleCardBlockV2 且 hooksOut 挂载了它', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /function roleCardBlockV2\(key\)/, '必须有生成器函数');
  assert.match(src, /options\.hooksOut\.roleCardBlock/, '必须挂到 hooksOut 上，否则插件拿不到');
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
