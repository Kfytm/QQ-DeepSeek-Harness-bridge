// 回归测试：「主动机会醒了但无事可做 → 刷一轮 B 站」这条分支。
//
// 规则（bridge.js buildWakePromptV2 的 proactiveCheck 分支）：
//   · 只在 cfg.socialV2.proactive.biliWhenIdle 不为 false 时启用；
//   · 冷却 biliIdleCooldownMs（默认 2 小时）内不重复给机会 —— 主动机会每 15~30 分钟
//     就有一次，不加冷却的话一夜能刷十几轮 B 站，每轮都是真实的 headless 模型调用；
//   · 给了机会就把 st.biliIdleAt 记下来（要落盘，重启后冷却不能归零）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({ config: { socialV2: { proactive: {} } } });
const KEY = 'group:456';
const st = h.getSocialV2State(KEY);

// 测试夹具里的 cfg 未必带上新默认值，这里显式设一遍（模拟 DEFAULTS 里的值）。
h.cfg.socialV2 = h.cfg.socialV2 || {};
h.cfg.socialV2.proactive = {
  ...(h.cfg.socialV2.proactive || {}),
  biliWhenIdle: true,
  biliIdleCooldownMs: 2 * 60 * 60 * 1000
};

const prompt = () => h.buildWakePromptV2(KEY, 'proactiveCheck');

// 1. 冷却期内：不该出现「去刷 B 站」的分支（否则就是每轮都劝她去刷）。
st.biliIdleAt = Date.now();
assert.ok(!prompt().includes('bili_run'), '冷却期内不应给刷 B 站分支');
console.log('✅ 冷却期内不给刷B站分支');

// 2. 冷却已过：分支出现，并记录本次机会时刻。
st.biliIdleAt = Date.now() - 3 * 60 * 60 * 1000;
const t0 = Date.now();
const text = prompt();
assert.ok(text.includes('bili_run'), '冷却过后应给出刷 B 站分支');
assert.ok(text.includes('bili_run'), '分支里必须点名 bili_run 工具，她才知道调什么');
assert.ok(st.biliIdleAt >= t0, '给出机会时应更新 biliIdleAt');
console.log('✅ 冷却过后给出分支并记录时刻');

// 3. 紧接着再来一次：又被冷却挡住（这就是「一夜别狂刷」的落点）。
assert.ok(!prompt().includes('bili_run'), '刚给过机会，下一次主动机会不应再给');
console.log('✅ 一次机会后立刻进入冷却');

// 4. 开关关掉：任何情况下都不给。
h.cfg.socialV2.proactive.biliWhenIdle = false;
st.biliIdleAt = 0;
assert.ok(!prompt().includes('bili_run'), 'biliWhenIdle=false 时不应出现分支');
console.log('✅ 开关关闭时不出现分支');

// 5. 默认文案仍然保留「开个话题」那条主路径（别把原有行为写丢了）。
h.cfg.socialV2.proactive.biliWhenIdle = true;
st.biliIdleAt = 0;
const withBranch = prompt();
assert.ok(withBranch.includes('主动冒泡'), '主动机会的原有引导不能丢');
assert.ok(withBranch.includes('qq_mark_read'), '收尾方式仍然要告诉她');
console.log('✅ 原有主动机会文案保持完整');

console.log('\n全部通过');
