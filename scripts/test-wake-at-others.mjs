// 回归测试：群里「@ 了别人」的消息不该把她叫醒。
//
// 真实现象（2026-10-31）：群友 @ 另一个人，句子里带了她的关键词/名字，她就跳出来插嘴。
// 根因是 atMention 只认「@ 的是她」，而名字/关键词/提问/概率这几条完全不看
// 「这句话是不是在跟别人说话」。
//
// 规则：@ 了别人（且没 @ 她、也不是 @全体）时，只有两种情况能唤醒：
//   · 她被引用（quoteTargetIsSelf）
//   · 使用者显式订阅了「指定成员发言」(triggers.speakerIds)
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({ config: { socialV2: {} } });
const KEY = 'group:456';
const SELF_ID = 2955699390;
h.setSelfIdentity('小鲸鱼', String(SELF_ID));

const st = h.getSocialV2State(KEY);
st.wakeConfig.triggers = {
  atMention: true,
  nameMention: true,
  keywords: ['大肥鱼'],
  question: true,
  probability: 0
};

const ev = ({ segs, userId = 111, selfId = SELF_ID } = {}) => ({
  self_id: selfId,
  user_id: userId,
  message: segs,
  sender: { card: '花', nickname: '花' }
});
const at = (qq) => ({ type: 'at', data: { qq } });
const text = (t) => ({ type: 'text', data: { text: t } });
const judge = (event, plain, quote = false) =>
  h.evaluateWakeTriggerV2(KEY, st, event, 'group', plain, plain, quote);

// 1. @别人 + 关键词 ⇒ 不唤醒
assert.equal(
  judge(ev({ segs: [at(2222), text(' 大肥鱼今天吃啥')] }), '[at] 大肥鱼今天吃啥'),
  null,
  '@别人 的消息带了关键词也不该叫醒'
);
console.log('✅ @别人 + 关键词：不唤醒');

// 2. @别人 + 她的名字 ⇒ 不唤醒
assert.equal(
  judge(ev({ segs: [at(2222), text(' 小鲸鱼刚才说啥')] }), '[at] 小鲸鱼刚才说啥'),
  null,
  '@别人 的消息提到她的名字也不该叫醒'
);
console.log('✅ @别人 + 名字：不唤醒');

// 3. @别人 + 像提问 ⇒ 不唤醒
assert.equal(
  judge(ev({ segs: [at(2222), text(' 你觉得呢')] }), '[at] 你觉得呢'),
  null,
  '@别人 的提问是在问那个人'
);
console.log('✅ @别人 + 提问：不唤醒');

// 4. @她 + 关键词 ⇒ atMention（原有行为不变）
assert.equal(
  judge(ev({ segs: [at(SELF_ID), text(' 大肥鱼')] }), '[at] 大肥鱼'),
  'atMention',
  '@她 必须叫醒'
);
console.log('✅ @她：唤醒，原因 atMention');

// 5. @全体 + 关键词 ⇒ 走正常判定（@全体 包含她）
assert.equal(
  judge(ev({ segs: [at('all'), text(' 大肥鱼开饭')] }), '[at] 大肥鱼开饭'),
  'keyword:大肥鱼',
  '@全体 不算 @别人，关键词照常生效'
);
console.log('✅ @全体 + 关键词：正常唤醒');

// 6. 没有 @ 的普通消息 ⇒ 关键词照常（别把整条链路掐死）
assert.equal(judge(ev({ segs: [text('大肥鱼今天吃啥')] }), '大肥鱼今天吃啥'), 'keyword:大肥鱼');
console.log('✅ 无 @ + 关键词：正常唤醒');

// 7. @别人 但引用了她 ⇒ 唤醒（对方是在接她的话）
assert.equal(
  judge(ev({ segs: [at(2222), text(' 你说得对')] }), '[at] 你说得对', true),
  'atMention',
  '引用了她就得算叫到她'
);
console.log('✅ @别人 + 引用她：唤醒');

// 8. @别人 但发话者在使用者订阅的 speakerIds 里 ⇒ 仍然唤醒（显式订阅优先）
st.wakeConfig.triggers.speakerIds = ['111'];
assert.equal(
  judge(ev({ segs: [at(2222), text(' 随便聊聊')] }), '[at] 随便聊聊'),
  'speaker:花',
  '使用者明确订阅了这个人，@别人时也要唤醒'
);
delete st.wakeConfig.triggers.speakerIds;
console.log('✅ @别人 + speakerIds 订阅：仍然唤醒');

// 9. anyMessage 模式优先（使用者主动开的"任何消息都醒"）
st.wakeConfig.triggers.anyMessage = true;
assert.equal(
  judge(ev({ segs: [at(2222), text(' 随便')] }), '[at] 随便'),
  'anyMessage'
);
console.log('✅ anyMessage 模式：优先级最高，不受 @别人 限制');
delete st.wakeConfig.triggers.anyMessage;

// 10. @别人 的**昵称**正好含关键词 ⇒ 不能因为昵称把她叫醒。
//     本群就有群友叫「总司家的大肥鱼」，而关键词里有「大肥鱼」。
//     这里把 atMention 关掉、并引用她（让 @别人 分支放行到关键词判定），专门验证
//     plainForMatch 确实把 @ 段文本剔掉了。
const atWithText = (qq, shown) => ({ type: 'at', data: { qq, text: shown } });
st.wakeConfig.triggers.atMention = false;
st.wakeConfig.triggers.speakerIds = [];
assert.equal(
  judge(
    ev({ segs: [atWithText(7777, '@总司家的大肥鱼'), text(' 你好')] }),
    '@总司家的大肥鱼 你好',
    true
  ),
  null,
  '@别人 的昵称含关键词时不该命中关键词（昵称不是正文）'
);
console.log('✅ @别人 昵称含关键词：不误触发');

// 11. 剔除只针对 @ 段：同一条消息的正文里真写了关键词，仍然命中
//     （这里用「@别人 + 引用她」让它放行到关键词判定，再断言命中的是正文而非昵称）
assert.equal(
  judge(
    ev({ segs: [atWithText(7777, '@总司家的大肥鱼'), text(' 大肥鱼开饭了')] }),
    '@总司家的大肥鱼 大肥鱼开饭了',
    true
  ),
  'keyword:大肥鱼',
  '正文里的关键词仍然生效'
);
console.log('✅ 正文关键词仍然生效（剔除只针对 @ 段）');

console.log('\n全部通过');
