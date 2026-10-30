// P1 单轮总时长上限：`qq_wait_for_messages` 在 turn 已经跑太久时拒绝再等待。
//
// 要钉住的语义（2026-10-30 与用户定）：
//   1. **只拦 wait**——它是唯一纯粹延长 turn 的工具；send/mark_read 等收尾动作一律不拦，
//      否则会把她做到一半的事（标表情库之类）硬切断；
//   2. **不限次数、不限单次时长**，只看这一轮总共跑了多久——这样不影响「实时逐句跟话」；
//   3. 没有 turn 起始时间（新会话第一轮）时不拦；
//   4. maxTurnMs=0 时完全关闭（向后兼容）；
//   5. 超时返回 429 + 明确的收尾指引，并告诉她消息不会丢。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const KEY = 'group:456';
const SID = 'fixture-sid-turn-budget';

async function postWait(port, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/wait`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // harness 的 config.json 里固定是这个控制台令牌；没有它会先被网关层 401 拦掉。
      'x-console-token': 'fixture-console-token'
    },
    body: JSON.stringify({ key: KEY, timeoutMs: 5000, ...body })
  });
  return { status: res.status, body: await res.json() };
}

const h = await bridgeHarness();
try {
  const setBudget = (ms) => {
    h.cfg.socialV2 ??= {};
    h.cfg.socialV2.wake ??= {};
    h.cfg.socialV2.wake.maxTurnMs = ms;
  };
  // 建立会话映射：单轮预算靠 key -> sessionId -> v2TurnStartAt 推算已运行时长。
  h.state.sessions ??= {};
  h.state.sessions[KEY] = SID;

  await test('超时：turn 已跑 6.6 分钟 > 5 分钟上限 → 429 且给出收尾指引', async () => {
    setBudget(300000);
    h.v2TurnStartAt.set(SID, Date.now() - 400000);
    await withServer(h, async (port) => {
      const r = await postWait(port);
      assert.equal(r.status, 429, `应拒绝等待，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, false);
      assert.ok(r.body.turnElapsedMs > 300000, '应回报已运行时长');
      assert.match(r.body.error, /收尾/, '必须告诉她怎么结束本轮');
      assert.match(r.body.error, /不会丢/, '必须说明消息不会丢，否则她会以为要丢消息而硬撑');
    });
  });

  await test('未超时：正常进入等待（不被单轮预算拦）', async () => {
    setBudget(300000);
    h.v2TurnStartAt.set(SID, Date.now() - 10000); // 才跑了 10 秒
    await withServer(h, async (port) => {
      const r = await postWait(port, { timeoutMs: 5000 });
      // 不拦意味着会真的走等待逻辑：5 秒后以 timeout 结果返回，而不是 429
      assert.notEqual(r.status, 429, `不该被单轮预算拒绝：${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, true);
    });
  });

  await test('没有 turn 起始时间（新会话第一轮）时不拦', async () => {
    setBudget(300000);
    h.v2TurnStartAt.delete(SID);
    await withServer(h, async (port) => {
      const r = await postWait(port, { timeoutMs: 5000 });
      assert.notEqual(r.status, 429, '拿不到起始时间就不该拦');
      assert.equal(r.body.ok, true);
    });
  });

  await test('maxTurnMs=0 时完全关闭（向后兼容）', async () => {
    setBudget(0);
    h.v2TurnStartAt.set(SID, Date.now() - 400000); // 就算跑了一小时也不拦
    await withServer(h, async (port) => {
      const r = await postWait(port, { timeoutMs: 5000 });
      assert.notEqual(r.status, 429, '关闭时不该拦');
      assert.equal(r.body.ok, true);
    });
  });
} finally {
  await h.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
