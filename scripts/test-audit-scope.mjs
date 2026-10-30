// 脱敏范围的可验证断言。
//
// 起因：她出错时 QQ 里只显示「（含敏感信息，已隐藏）」，日志里也一样 —— 管理员
// 连错在哪都看不到。修法是「owner 私聊豁免脱敏 + 日志记原文」。
//
// 但这条改动**不能靠等错误自然复现来验证**（错误可能几天不出现一次，出现了也可能
// 跟这次改动无关）。所以直接对判定函数下断言：给定会话 key 和当前模式，它到底
// 要不要脱敏。这是确定性的。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const OWNER = 123; // harness 默认 config.ownerQQ
const OWNER_KEY = `private:${OWNER}`;

const h = await bridgeHarness();
try {
  await test('reserved2：owner 私聊不脱敏（出错时管理员必须能看到原因）', () => {
    h.setMode('reserved2');
    assert.equal(h.shouldAuditKey(OWNER_KEY), false,
      'owner 私聊被脱敏的话，出错时只剩「含敏感信息，已隐藏」，等于看不到错误');
  });

  await test('reserved2：群聊仍然脱敏（不能让群友看到 token/路径）', () => {
    h.setMode('reserved2');
    assert.equal(h.shouldAuditKey('group:456'), true, '群聊必须脱敏');
  });

  await test('reserved2：别人的私聊仍然脱敏', () => {
    h.setMode('reserved2');
    assert.equal(h.shouldAuditKey('private:999'), true, '非 owner 私聊不是管理员，必须脱敏');
  });

  await test('closed-agent：owner 私聊不脱敏（原有行为不能回归）', () => {
    h.setMode('closed-agent');
    assert.equal(h.shouldAuditKey(OWNER_KEY), false);
    assert.equal(h.shouldAuditKey('private:999'), true);
  });

  await test('敏感内容本身确实会被 SENSITIVE_RE 命中（否则上面几条是空测）', () => {
    // 用一个看似 token 的串验证正则真的在工作：如果它不命中，
    // 「脱敏范围」这套断言就失去意义（永远走不到脱敏分支）。
    const sample = 'Authorization: Bearer sk-abcdef0123456789abcdef0123456789';
    assert.equal(h.SENSITIVE_RE.test(sample), true, `SENSITIVE_RE 应命中：${sample}`);
  });
} finally {
  await h.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
