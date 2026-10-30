// P1 冷却窗口（CD）：发言后的一段时间内不唤醒，消息攒到窗口结束**合并投递一次**。
//
// 要钉住的核心语义（2026-10-30 与用户定）：
//   1. CD 只挂**唤醒调度**，不碰分条发送——一个 qq_send_message 发多条是同一波，
//      不该被 CD 切碎；
//   2. **固定窗口**：窗口内来新消息不延长 cdUntil（滚动会在活跃群里无限推迟）；
//   3. 窗口内多个唤醒请求**只保留一个定时器**，原因按优先级升级，到点投一次；
//   4. 合批到点（8s）如果仍在 CD 内，要转交冷却定时器，不能绕过；
//   5. cdMs=0 时行为完全不变（向后兼容）；
//   6. 清定时器时 cdUntil 一起清，否则暂停/退役后残留时间戳会一直挡住唤醒。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 必须用 harness 默认白名单里的 key，否则 scheduleWakeV2 会在
// `isSessionAllowedInCurrentMode()` 处直接 return，测不到 CD 分支。
const KEY = 'group:456';

const h = await bridgeHarness();
  // 关掉峰时限制：peakBlocksGroup() 会在工作日 9-12/14-18 点直接挡掉群聊唤醒，
  // 那会让本测试在白天假失败。这里测的是 CD / 初始提示词，与时间段无关。
  h.cfg.socialV2 ??= {};
  h.cfg.socialV2.offPeak = { ...(h.cfg.socialV2.offPeak || {}), enabled: false };
try {
  const setCd = (ms) => {
    h.cfg.socialV2 ??= {};
    h.cfg.socialV2.send ??= {};
    h.cfg.socialV2.send.cooldownAfterSpeakMs = ms;
  };
  const st = () => h.getSocialV2State(KEY);
  const reset = () => {
    h.clearSocialV2Timers(KEY);
    const s = st();
    s.cdUntil = 0;
    s.pendingWakeReason = null;
    s.wakeConfig = { ...(s.wakeConfig || {}), batchWindowMs: 8000 };
  };

  await test('cdMs=0 时 recordSentMessagesV2 不开窗口（向后兼容）', () => {
    setCd(0);
    reset();
    h.recordSentMessagesV2(KEY, ['随便说一句']);
    assert.equal(Number(st().cdUntil) || 0, 0, '关闭时不该有 cdUntil');
  });

  await test('发言后开启固定窗口：cdUntil ≈ now + cdMs', () => {
    setCd(30000);
    reset();
    const before = Date.now();
    h.recordSentMessagesV2(KEY, ['第一波']);
    const cdUntil = Number(st().cdUntil);
    assert.ok(cdUntil >= before + 29000 && cdUntil <= Date.now() + 30000,
      `cdUntil 应落在 now+30s 附近，实际 ${cdUntil - before}ms`);
  });

  await test('CD 期间 scheduleWakeV2 不设合批定时器，改由冷却定时器接住', () => {
    setCd(30000);
    reset();
    h.recordSentMessagesV2(KEY, ['说过话了']);
    h.scheduleWakeV2(KEY, 'atMention');
    const s = st();
    assert.equal(s.pendingWakeTimer, null, 'CD 内不该有合批定时器（那会在 8s 后绕过窗口）');
    assert.ok(s.cdTimer, '应该建立冷却定时器');
    assert.equal(s.pendingWakeReason, 'atMention');
  });

  await test('窗口内多条唤醒只保留一个定时器，原因按优先级升级', () => {
    setCd(30000);
    reset();
    h.recordSentMessagesV2(KEY, ['说过话了']);
    h.scheduleWakeV2(KEY, 'probability');   // 低优先级
    const firstTimer = st().cdTimer;
    h.scheduleWakeV2(KEY, 'atMention');     // 高优先级
    h.scheduleWakeV2(KEY, 'probability');   // 又一条低优先级，不能把原因降回去
    assert.equal(st().cdTimer, firstTimer, '窗口内不能重复建定时器');
    assert.equal(st().pendingWakeReason, 'atMention', '原因必须升级到 @，不能被后面的低优先级覆盖');
  });

  await test('固定窗口：窗口内新消息不延长 cdUntil', () => {
    setCd(30000);
    reset();
    h.recordSentMessagesV2(KEY, ['说过话了']);
    const original = Number(st().cdUntil);
    h.scheduleWakeV2(KEY, 'atMention');
    h.scheduleWakeV2(KEY, 'keyword');
    assert.equal(Number(st().cdUntil), original, '固定窗口不该被新消息延长（滚动窗口会无限推迟）');
  });

  await test('合批定时器到点时仍在 CD 内 → 转交冷却定时器（不能绕过）', async () => {
    setCd(30000);
    reset();
    // 合批窗口有 1000ms 下限，所以这里用 1000ms 并把 CD 开成 30s：
    // 合批到点时一定还在 CD 内，正确的行为是"转交"，不是直接投递。
    st().wakeConfig = { ...(st().wakeConfig || {}), batchWindowMs: 1000 };
    h.scheduleWakeV2(KEY, 'atMention');
    assert.ok(st().pendingWakeTimer, '正常情况下应有合批定时器');
    h.recordSentMessagesV2(KEY, ['在此期间她说话了']);
    await sleep(1300);
    assert.equal(st().pendingWakeTimer, null, '合批定时器应已触发');
    assert.ok(st().cdTimer, '触发后应转交给冷却定时器');
    assert.equal(st().pendingWakeReason, 'atMention', '原因要带过去');
  });

  await test('窗口结束后真的投递一次（用短窗口验证时序）', async () => {
    // 冷却定时器同样有 1000ms 下限，所以窗口取 1200ms。
    setCd(1200);
    reset();
    h.recordSentMessagesV2(KEY, ['说过话了']);
    h.scheduleWakeV2(KEY, 'atMention');
    assert.ok(st().cdTimer);
    await sleep(1600);
    assert.equal(st().cdTimer, null, '到点后定时器应清空');
    assert.equal(Number(st().cdUntil) || 0, 0, '到点后 cdUntil 应归零');
    assert.equal(st().pendingWakeReason, null, '原因被取走后应清空');
  });

  await test('过期窗口不会永久挡住唤醒：残留 cdUntil 会被清掉', () => {
    setCd(30000);
    reset();
    st().cdUntil = Date.now() - 5000; // 模拟进程停过一阵，时间戳残留
    h.scheduleWakeV2(KEY, 'atMention');
    assert.equal(Number(st().cdUntil) || 0, 0, '过期时间戳要清掉');
    assert.ok(st().pendingWakeTimer, '过期后应走正常合批路径');
  });

  await test('clearSocialV2Timers 同时清 cdTimer 和 cdUntil', () => {
    setCd(30000);
    reset();
    h.recordSentMessagesV2(KEY, ['说过话了']);
    h.scheduleWakeV2(KEY, 'atMention');
    assert.ok(st().cdTimer);
    h.clearSocialV2Timers(KEY);
    assert.equal(st().cdTimer, null);
    assert.equal(Number(st().cdUntil) || 0, 0, '残留 cdUntil 会一直挡住后续唤醒');
    assert.equal(st().pendingWakeReason, null);
  });

  setCd(0);
  reset();
} finally {
  await h.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
