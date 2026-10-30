// qq-agent-host 适配层单测：mock 掉 cordis 上下文，不启动桥接、不连 SnowLuma。
//
// 要钉住的是「bridge.js 以为自己在跟 HTTP API 说话，实际在跟进程内 agent 说话」这件事：
//   1. sessions.create → ctx.agents.create（含 agentPreset 透传）
//   2. sessions.prompt → agent.followup / steer（UserMessage 形状正确）
//   3. events.mux → 真异步生成器（bridge.js 的 pumpMux 用 for await 消费）
//   4. stopSessionWork → agent.cancel
//   5. workspace.archiveSession → handle.dispose
//   6. 所有返回值都要保持 { result: { ok, value } } 包装（bridge.js 用 unwrap 拆）
import assert from 'node:assert/strict';
import { createDshAdapter, userMessage } from '../plugins/qq-agent-host/lib/adapter.js';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function makeCtx() {
  const calls = { created: [], followup: [], steer: [], cancel: [], disposed: [], setups: [] };
  const ctx = {
    agents: {
      create: async ({ sessionId, meta, setup }) => {
        const agent = {
          options: {},
          session: { rename() {} },
          followup: (m) => calls.followup.push(m),
          steer: (m) => calls.steer.push(m),
          cancel: (c) => calls.cancel.push(c)
        };
        calls.created.push({ sessionId, meta });
        if (setup) {
          calls.setups.push(sessionId);
          // setup 现在是 async（里面 await agentPresets.mount），必须 await。
          await setup({ systemPrompt: { section: () => () => {} }, tools: {} }, agent);
        }
        return { agent, dispose: async () => { calls.disposed.push(sessionId); } };
      }
    },
    // adapter 在 setup 里会调 agentPresets.mount —— 少了它 mock 会直接抛
    // 「Cannot read properties of undefined (reading 'mount')」。
    agentPresets: {
      list: async () => [],
      mount: async (_ctx, id) => { calls.mounted = id; return { id }; }
    },
    settings: { describe: () => [], update: async () => {} },
    sessionTitle: { rename() {} },
    workspaceRegistry: {
      create: async () => ({ id: 'w-smoke', attachSession: async () => {}, setTitle: async () => {} }),
      get: () => undefined
    }
  };
  return { ctx, calls };
}

await test('userMessage 形状符合 DSH 的 UserMessage（id/role/content/source）', () => {
  const m = userMessage('你好');
  assert.equal(m.role, 'user');
  assert.deepEqual(m.content, [{ type: 'text', text: '你好' }]);
  assert.deepEqual(m.source, { kind: 'user' });
  assert.equal(typeof m.id, 'string');
  assert.ok(m.id.length > 0);
});

await test('sessions.create 建 agent 并透传 agentPreset', async () => {
  const { ctx, calls } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const wrapped = await a.api.sessions.create({ targetKey: 'group:123', agentPreset: 'qq-chat-v2', cwd: 'D:/x' });
  assert.equal(wrapped.result.ok, true);
  const sessionId = wrapped.result.value.sessionId;
  assert.ok(sessionId.startsWith('qq-group-123-'), `sessionId 应含 QQ key：${sessionId}`);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].meta.agentPreset, 'qq-chat-v2');
  assert.equal(calls.created[0].meta.cwd, 'D:/x');
  assert.equal(calls.setups.length, 1, 'setup 必须被调用（prompt 段/工具在那里装）');
  assert.ok(a.live.has(sessionId));
});

await test('sessions.prompt 走 agent.followup，文本被拼成 text 块', async () => {
  const { ctx, calls } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const { result } = await a.api.sessions.create({ targetKey: 'group:1' });
  const sid = result.value.sessionId;
  await a.api.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '第一段' }, { type: 'image', data: 'x' }, { type: 'text', text: '第二段' }] });
  assert.equal(calls.followup.length, 1);
  assert.equal(calls.followup[0].content[0].text, '第一段\n第二段', '只拼 text 块，image 不进文本');
  assert.equal(calls.followup[0].role, 'user');
});

await test('sessions.prompt mode=steer 走 agent.steer', async () => {
  const { ctx, calls } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const { result } = await a.api.sessions.create({ targetKey: 'group:2' });
  await a.api.sessions.prompt({ sessionId: result.value.sessionId, content: [{ type: 'text', text: '插一句' }], mode: 'steer' });
  assert.equal(calls.steer.length, 1);
  assert.equal(calls.followup.length, 0);
});

await test('sessions.prompt 对未知会话抛错（不能静默丢消息）', async () => {
  const { ctx } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  await assert.rejects(
    () => a.api.sessions.prompt({ sessionId: '不存在', content: [{ type: 'text', text: 'x' }] }),
    /没有找到会话/,
  );
});

await test('events.mux 是真异步生成器，能按序收到 publish 的帧', async () => {
  const { ctx } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const it = a.api.events.mux({})[Symbol.asyncIterator]();
  // 先消费一个（此时队列空 → 挂起），再 publish
  const pending = it.next();
  a.publish('s1', { type: 'turn/end', data: { turn: 1 } });
  const got = await pending;
  assert.equal(got.done, false);
  assert.equal(got.value.payload.type, 'session/event');
  assert.equal(got.value.payload.sessionId, 's1');
  assert.equal(got.value.payload.event.type, 'turn/end');
  await it.return?.();
});

await test('events.mux 队列有上界（消费端卡死不能无限涨）', async () => {
  const { ctx } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  for (let i = 0; i < 6000; i += 1) a.publish('s2', { type: 'x', i });
  const it = a.api.events.mux({})[Symbol.asyncIterator]();
  const first = await it.next();
  // 队列被裁到 5000，所以拿到的是较晚的那条而不是最前面那条
  assert.equal(first.value.payload.event.i >= 999, true, `应已丢弃最早的部分，实际 i=${first.value.payload.event.i}`);
  await it.return?.();
});

await test('stopSessionWork → agent.cancel', async () => {
  const { ctx, calls } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const { result } = await a.api.sessions.create({ targetKey: 'group:3' });
  await a.api.stopSessionWork(result.value.sessionId);
  assert.equal(calls.cancel.length, 1);
});

await test('workspace.archiveSession → handle.dispose 并清理映射', async () => {
  const { ctx, calls } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  const { result } = await a.api.sessions.create({ targetKey: 'group:4' });
  const sid = result.value.sessionId;
  await a.api.workspace.archiveSession({ sessionId: sid });
  assert.equal(calls.disposed.length, 1);
  assert.equal(a.live.has(sid), false);
});

await test('callUnary 在进程内模式明确抛错（不静默返回假数据）', async () => {
  const { ctx } = makeCtx();
  const a = createDshAdapter({ ctx, log: () => {} });
  await assert.rejects(() => a.api.callUnary('session.modelCatalog', {}), /不可用/);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
