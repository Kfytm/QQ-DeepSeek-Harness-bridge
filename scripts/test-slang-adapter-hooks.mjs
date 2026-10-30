// 回归测试：适配层只给「QQ 会话」装配 persona / 运行时面板。
//
// 背景（真实现象，2026-10-31）：黑话学习 agent 用 targetKey=`slang-learner` 建会话，
// 桥接把 runtimePanelV2 注册成 systemPrompt.context，而 runtimePanelV2 第一行是
// getSocialV2State(key) —— 它对非 `group:/private:` 的 key 直接抛「无效的会话 key」。
// 结果：学习会话每个 turn 都在装配阶段抛异常，turn/end 的 reason 是 error，
// 日志只剩一句「学习会话 turn 未正常完成：error」，一晚上重建了十几个会话。
//
// 修复：adapter 在注册前校验 targetKey 形状。这个测试锁住两条边界：
//   · 非 QQ key（学习 agent）→ 一个 section 都不注册；
//   · QQ key → section/context 都注册，且求值正常。
import assert from 'node:assert/strict';
import { createDshAdapter } from '../plugins/qq-agent-host/lib/adapter.js';

const QQ_KEY = /^(group|private):\d+$/;

/** 最小可用的 DSH ctx 替身：只要能走完 createAgent 的装配流程。 */
function makeCtx() {
  const created = [];
  const ctx = {
    agents: {
      create: async ({ sessionId, meta, setup }) => {
        const registered = { sessionId, sections: [], contexts: [], meta };
        const agentCtx = {
          systemPrompt: {
            section: (cfg) => registered.sections.push(cfg),
            context: (cfg) => registered.contexts.push(cfg)
          }
        };
        const agent = { session: { id: sessionId }, followup() {}, steer() {}, options: {} };
        await setup(agentCtx, agent);
        created.push(registered);
        return { agent, handle: { dispose: async () => {} } };
      }
    },
    agentPresets: { mount: async () => {} },
    sessionTitle: { rename: () => {} },
    workspaceRegistry: {
      create: async () => ({ id: 'ws-1', attachSession: async () => {}, setTitle: async () => {} })
    }
  };
  return { ctx, created };
}

/** 与桥接真实 hook 同形状：非 QQ key 求值即抛。 */
const hooks = {
  roleCardBlock: () => 'ROLE-CARD',
  runtimePanel: (key) => {
    if (!QQ_KEY.test(String(key))) throw new Error(`无效的会话 key：${key}`);
    return 'PANEL';
  }
};

const logs = [];

// ── 1. 黑话学习 agent：必须一个 section 都不注册 ────────────────────────────
{
  const { ctx, created } = makeCtx();
  const adapter = createDshAdapter({ ctx, hooks, log: (m) => logs.push(m) });
  await adapter.api.workspace.create({ path: 'D:\\probe-slang-agent' });
  const r = await adapter.api.sessions.create({ targetKey: 'slang-learner', agentPreset: 'standard' });
  assert.equal(r.result.ok, true, 'slang session 应创建成功');

  const reg = created.at(-1);
  assert.match(reg.sessionId, /^qq-slang-learner-[0-9a-f]{8}$/);
  assert.equal(reg.sections.length, 0, `学习 agent 不该注册 systemPrompt.section，实际 ${reg.sections.length} 个`);
  assert.equal(reg.contexts.length, 0, `学习 agent 不该注册 systemPrompt.context，实际 ${reg.contexts.length} 个`);
  // 而且它的 context 一个都不能求值 —— 求值就是上一版每轮 error 的触发点。
  for (const c of reg.contexts) c.text();
  assert.ok(logs.some((l) => l.includes('不是 QQ 会话 key')), '应留下跳过装配的日志，避免下次有人以为没装');
  console.log('✅ 学习 agent 不装配 persona/panel');
}

// ── 2. QQ 群会话：照旧装配，且求值正常 ──────────────────────────────────────
for (const key of ['group:786761410', 'private:1079900415']) {
  const { ctx, created } = makeCtx();
  const adapter = createDshAdapter({ ctx, hooks, log: () => {} });
  await adapter.api.workspace.create({ path: 'D:\\probe-agents' });
  await adapter.api.sessions.create({ targetKey: key, agentPreset: 'qq-chat-v2' });

  const reg = created.at(-1);
  assert.equal(reg.sections.length, 1, `${key} 应注册 1 个 section`);
  assert.equal(reg.contexts.length, 1, `${key} 应注册 1 个 context`);
  assert.equal(reg.sections[0].text(), 'ROLE-CARD');
  assert.equal(reg.contexts[0].text(), 'PANEL');
  console.log(`✅ ${key} 正常装配 persona/panel`);
}

console.log('\n全部通过');
