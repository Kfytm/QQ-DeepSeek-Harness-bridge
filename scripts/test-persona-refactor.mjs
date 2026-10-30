// P0（规则搬出唤醒提示）+ P2（主人格 / 副卡两层人格）的回归测试。
//
// 为什么要有这份测试：
//   · P0 的收益是**省 token**，但"省下来的那几段"原本是行为规则。规则搬进 preset 之后，
//     桥接这边只剩数据行——如果将来有人把规则又抄回 buildWakePromptV2，token 会悄悄涨回去，
//     而且没人会发现。所以这里既钉"该没的没了"，也钉"该在的还在"。
//   · P2 的收益是**换卡不重建前缀、且旧卡不留残留**。要保证两件事同时成立：
//     ① 副卡全文只能走"每轮提示末尾"这一条路，绝不能走工具返回（否则卡进历史、换卡删不掉）；
//     ② 换卡后除了末尾那一段，提示其余部分逐字不变（KV 缓存照常命中）。
//     这两条都没法肉眼确认，只能靠测试钉住。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const GROUP_A = 'group:1001';
const GROUP_B = 'group:1002';
const PRIVATE = 'private:2001';

// 两张内容可区分的测试卡：断言时只看"拿到的是哪一张"，不依赖具体文案。
const ROLE_ONE = '# 卡一\n\n## 一、你是谁\n- 我是卡一独有的标记 ROLE_ONE_MARK。\n';
const ROLE_TWO = '# 卡二\n\n## 一、你是谁\n- 我是卡二独有的标记 ROLE_TWO_MARK。\n';
const ROLE_FILES = {
  'roles/1.md': ROLE_ONE,
  'roles/2.md': ROLE_TWO,
  // roleRawContent 会用 current-role.json 的 mtime 做缓存 key，文件不在就直接返回空。
  'state/current-role.json': { role: null, mode: 'active' },
};

/** 摘掉末尾的【当前副卡】段。它必须是 prompt 的最后一块，所以直接截断即可。 */
function stripSubCard(prompt) {
  const s = String(prompt);
  const i = s.indexOf('【当前副卡');
  return i < 0 ? s : s.slice(0, i);
}

await test('P0：静态规则不再重复注入唤醒提示（反AI味/积极性/表情策略）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    for (const reason of ['atMention', 'timeout', 'bootstrap', 'replyCheck', 'proactiveCheck', 'poke']) {
      const prompt = h.buildWakePromptV2(GROUP_A, reason);
      assert.doesNotMatch(prompt, /【反AI味】/, `${reason}: 反AI味应只在预设里`);
      assert.doesNotMatch(prompt, /【积极性】/, `${reason}: 积极性应只在预设里`);
      assert.doesNotMatch(prompt, /【表情包策略/, `${reason}: 表情策略应只在预设里`);
    }
  } finally { await h.close(); }
});

await test('P0：动态数据仍然在（令牌/身份/节奏数值/观察时长）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    h.setSelfIdentity('樰', '10001');
    const st = h.getSocialV2State(GROUP_A);
    const prompt = h.buildWakePromptV2(GROUP_A, 'atMention');
    assert.ok(prompt.includes('【会话令牌】'), '令牌是工具调用的硬前置，不能省');
    assert.ok(prompt.includes(st.agentToken), '必须是本会话的真实令牌');
    assert.ok(prompt.includes('【你的身份】'), 'issue #29：她得认得出 @自己');
    assert.match(prompt, /【首回复节奏】[^\n]*quietMs=\d+/, '静默数值是算出来的，必须带');
    assert.match(prompt, /【沉睡前观察】[^\n]*timeoutMs=\d+/, '观察时长是配置值，必须带');
  } finally { await h.close(); }
});

await test('P0：唤醒提示的“除副卡外”部分体积仍受控', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    // 副卡全文本来就会随卡变长，所以预算护栏只管**它之前**的部分。
    // 改造前 atMention ≈ 1750 字符（含表情策略 545 + 沉睡前 335 + 首回复 194 + 反AI味 55 + 积极性 74）。
    const prompt = h.buildWakePromptV2(GROUP_A, 'atMention');
    const head = stripSubCard(prompt);
    assert.ok(head.length < 900, `除副卡外的提示 ${head.length} 字符，超过 900（规则疑似又被抄回 prompt）`);
    const reminder = h.buildWakeReminderPromptV2(GROUP_A);
    assert.ok(reminder.length < 600, `收尾提醒 ${reminder.length} 字符，超过 600`);
  } finally { await h.close(); }
});

await test('P2：未绑定会话回退全局默认卡；没有默认卡时不写副卡段', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    assert.equal(h.roleNameForSession(GROUP_A), null);
    assert.equal(h.roleNameForSession(PRIVATE), null);
    const prompt = h.buildWakePromptV2(GROUP_A, 'atMention');
    assert.ok(!prompt.includes('【当前副卡'), '没有卡时不得凭空写一段副卡');
  } finally { await h.close(); }
});

await test('P2：副卡全文直接注入提示末尾（不经工具返回）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    h.bindSessionRole(GROUP_A, '1');
    // 【架构变更】卡全文已从 user message 搬到 systemPrompt.section，
    // 所以断言的对象从 buildWakePromptV2() 改成 roleCardBlockV2()。
    // 同时新增一条更硬的：唤醒提示里**绝不能**再有卡全文（否则等于没搬、还多一份）。
    const block = h.roleCardBlockV2(GROUP_A);
    assert.match(block, /【当前副卡 · 1】/, '要写明当前是哪张卡');
    assert.match(block, /ROLE_ONE_MARK/, '卡全文必须出现在 section 的内容里');
    assert.doesNotMatch(block, /ROLE_TWO_MARK/, '不能串卡');
    const prompt = h.buildWakePromptV2(GROUP_A, 'atMention');
    assert.doesNotMatch(prompt, /ROLE_ONE_MARK/, '卡全文不该再进 user message（已搬到 section）');
    assert.doesNotMatch(prompt, /【当前副卡/, '唤醒提示里不该再有副卡段');
  } finally { await h.close(); }
});

await test('P2：换卡后除副卡段外前缀逐字不变（缓存照常命中）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    h.bindSessionRole(GROUP_A, '1');
    // 【架构变更】换卡影响的是 section 内容，user message 应该逐字不变。
    const beforeBlock = h.roleCardBlockV2(GROUP_A);
    const beforePrompt = h.buildWakePromptV2(GROUP_A, 'atMention');
    h.bindSessionRole(GROUP_A, '2');
    const afterBlock = h.roleCardBlockV2(GROUP_A);
    const afterPrompt = h.buildWakePromptV2(GROUP_A, 'atMention');

    assert.match(beforeBlock, /【当前副卡 · 1】/);
    assert.match(afterBlock, /【当前副卡 · 2】/);
    assert.equal(afterPrompt, beforePrompt, '换卡后 user message 必须逐字不变（卡已不在里面）');
  } finally { await h.close(); }
});

await test('P2：卡全文按会话隔离（一个会话一张，不串）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    h.bindSessionRole(GROUP_A, '1');
    h.bindSessionRole(PRIVATE, '2');
    assert.equal(h.roleNameForSession(GROUP_A), '1');
    assert.equal(h.roleNameForSession(PRIVATE), '2');
    assert.equal(h.roleNameForSession(GROUP_B), null, '没绑定的第三会话仍回退默认');
    assert.match(h.currentRoleHintV2(GROUP_A), /ROLE_ONE_MARK/);
    assert.match(h.currentRoleHintV2(PRIVATE), /ROLE_TWO_MARK/);
    assert.doesNotMatch(h.currentRoleHintV2(GROUP_A), /ROLE_TWO_MARK/, '不能串卡');
  } finally { await h.close(); }
});

await test('P2：切卡当场拿到新卡全文（这一轮就能用）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    h.bindSessionRole(GROUP_A, '1');
    assert.match(h.currentRoleHintV2(GROUP_A), /ROLE_ONE_MARK/);
    // 模拟 qq_switch_role 的效果：切完立刻读，拿到的必须是新卡全文。
    h.bindSessionRole(GROUP_A, '2');
    assert.match(h.currentRoleHintV2(GROUP_A), /ROLE_TWO_MARK/, '切完这一轮就该拿到新卡');
    assert.doesNotMatch(h.currentRoleHintV2(GROUP_A), /ROLE_ONE_MARK/);
  } finally { await h.close(); }
});

await test('P2：绑定校验与解绑（防目录穿越 / 不存在的卡）', async () => {
  const h = await bridgeHarness({ files: ROLE_FILES });
  try {
    assert.throws(() => h.bindSessionRole('not-a-key', '1'), /会话 key/, '非法会话 key 必须拒绝');
    assert.throws(() => h.bindSessionRole(GROUP_A, 'not-exist'), /不存在/, '不存在的卡必须拒绝');
    assert.throws(() => h.bindSessionRole(GROUP_A, '../escape'), /不合法|不存在/, '目录穿越必须拒绝');

    h.bindSessionRole(GROUP_A, '1');
    assert.equal(h.roleNameForSession(GROUP_A), '1');
    h.bindSessionRole(GROUP_A, '');   // 解绑
    assert.equal(h.roleNameForSession(GROUP_A), null, '解绑后回退默认卡');
  } finally { await h.close(); }
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
