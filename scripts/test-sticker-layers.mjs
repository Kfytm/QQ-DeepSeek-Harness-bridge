// 表情库 P4：两层标签（画面层 / 场合层）的回归测试。
//
// 要钉住的三件事：
//   1. **画面层只写一次**：`visual.seen` 是「不再为同一张图调视觉模型」的唯一依据，
//      迁移时不能把老数据全标成"没看过"（那会逼 AI 把每张图重新看一遍）。
//   2. **场合层是替换不是追加**：场合判断会随语境变，追加会让同一张图的标签无限膨胀，
//      检索越来越不准。
//   3. **检索按场景+强度打分**：这是 P4 的核心用途——她要的不是"一张叫 XX 的图"，
//      而是"嘲讽的时候来一张狠的"。
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  normalizeStickerEntry,
  applyStickerVisual,
  applyStickerNote,
  searchStickersByScene,
  buildStickerContext,
  formatStickerList,
  loadStickerStore
} from '../src/sticker-lib.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 项目根：路径一律相对它推算，开源到任意目录都能跑，也不再暴露本机绝对路径。
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let passed = 0;
function test(name, run) {
  try { run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const base = (id, patch = {}) => normalizeStickerEntry({ id, desc: '', ...patch });

test('迁移：老数据有 localNote 的，视为「已看过」并把它当画面描述', () => {
  const e = normalizeStickerEntry({ id: 'a', localNote: '粉毛角色张嘴傻笑' });
  assert.equal(e.visual.seen, true, '有 localNote 说明当年看过图，不能重新标成没看过');
  assert.equal(e.visual.summary, '粉毛角色张嘴傻笑');
  assert.equal(e.visual.animated, false);
});

test('迁移：老数据没有 localNote 的，保持未看过', () => {
  const e = normalizeStickerEntry({ id: 'b', desc: '破防大吼猫' });
  assert.equal(e.visual.seen, false);
  assert.equal(e.visual.summary, '');
});

test('written visual 解析：seen/animated/summary/text/seenAt 都要归一化', () => {
  const e = normalizeStickerEntry({
    id: 'c',
    visual: { seen: true, animated: true, summary: '  猫在床上打滚  ', text: '草', seenAt: 123 }
  });
  assert.equal(e.visual.seen, true);
  assert.equal(e.visual.animated, true);
  assert.equal(e.visual.summary, '猫在床上打滚', '要 trim');
  assert.equal(e.visual.text, '草');
  assert.equal(e.visual.seenAt, 123);
});

test('applyStickerVisual：写 seen/animated，已有 summary 不被空值覆盖', () => {
  let list = [base('x', { visual: { seen: true, summary: '粉毛傻笑' } })];
  let r = applyStickerVisual(list, 'x', { animated: true });
  assert.equal(r.entry.visual.seen, true);
  assert.equal(r.entry.visual.animated, true);
  assert.equal(r.entry.visual.summary, '粉毛傻笑', '没传 summary 不能把已有的清空');
  assert.ok(r.entry.visual.seenAt > 0);

  // 传了 summary 就更新
  r = applyStickerVisual(r.entries, 'x', { summary: '换个描述' });
  assert.equal(r.entry.visual.summary, '换个描述');
});

test('applyStickerVisual：找不到表情时返回原数组不动', () => {
  const list = [base('y')];
  const r = applyStickerVisual(list, '不存在', { summary: 'x' });
  assert.equal(r.entry, null);
  assert.equal(r.entries.length, 1);
});

test('场合层：传数组是替换，不是追加', () => {
  let list = [base('z', { scenes: [{ scene: '嘲讽', intensity: 3 }, { scene: '无语', intensity: 1 }] })];
  assert.equal(list[0].scenes.length, 2);

  let r = applyStickerNote(list, 'z', { scenes: ['自嘲'] });
  assert.deepEqual(r.entry.scenes.map((s) => s.scene), ['自嘲'], '替换后旧场合必须消失');
  assert.equal(r.entry.scenes[0].intensity, 2, '没给强度时默认 2');
});

test('场合层：强度夹在 1~5，0/负数视为未指定（默认 2），重复场合只留一条', () => {
  const e = normalizeStickerEntry({
    id: 'w',
    scenes: [
      { scene: '嘲讽', intensity: 99 },
      { scene: '嘲讽', intensity: 1 },
      { scene: '无语', intensity: 0 }
    ]
  });
  assert.equal(e.scenes.length, 2, '重复场合要合并');
  assert.equal(e.scenes[0].intensity, 5, '超上限夹到 5');
  assert.equal(e.scenes[1].intensity, 2, '0 是「未指定」，不是「1 级」——落默认 2');

  const negative = normalizeStickerEntry({ id: 'neg', scenes: [{ scene: '嘲讽', intensity: -3 }] });
  assert.equal(negative.scenes[0].intensity, 2, '负数同样算未指定');

  const empty = normalizeStickerEntry({ id: 'v', scenes: [{ scene: '  ' }] });
  assert.equal(empty.scenes.length, 0, '空场合名要丢掉');
});

test('clampIntensity：0 不能被夹成 1（否则检索要 1 级会拉进一堆未标注的）', () => {
  const zero = normalizeStickerEntry({ id: 'z0', scenes: [{ scene: '嘲讽', intensity: 0 }] });
  assert.notEqual(zero.scenes[0].intensity, 1);
});

test('场景检索：精确场合名排最前', () => {
  const list = [
    normalizeStickerEntry({ id: '1', desc: '怼人图', scenes: [{ scene: '嘲讽', intensity: 4 }], useCount: 0 }),
    normalizeStickerEntry({ id: '2', desc: '普通图', scenes: [{ scene: '嘲讽式赞同', intensity: 2 }], useCount: 5 }),
    normalizeStickerEntry({ id: '3', desc: '无关图', scenes: [], useCount: 9 })
  ];
  const r = searchStickersByScene(list, '嘲讽', 0, 3);
  assert.equal(r.candidates.length, 3);
  assert.equal(r.candidates[0].id, '1', '精确「嘲讽」必须压过「嘲讽式赞同」和无关图');
});

test('场景检索：强度越接近越靠前', () => {
  const list = [
    normalizeStickerEntry({ id: 'low', scenes: [{ scene: '嘲讽', intensity: 1 }] }),
    normalizeStickerEntry({ id: 'high', scenes: [{ scene: '嘲讽', intensity: 5 }] })
  ];
  const wantHigh = searchStickersByScene(list, '嘲讽', 5, 2);
  assert.equal(wantHigh.candidates[0].id, 'high', '要 5 级时，5 级那张必须第一');
  const wantLow = searchStickersByScene(list, '嘲讽', 1, 2);
  assert.equal(wantLow.candidates[0].id, 'low', '要 1 级时，1 级那张必须第一');
});

test('场景检索：没有场合标签的图也进候选（刚收藏、还没标注的）', () => {
  const list = [normalizeStickerEntry({ id: 'new', desc: '刚存的图', scenes: [] })];
  const r = searchStickersByScene(list, '嘲讽', 0, 5);
  assert.equal(r.candidates.length, 1, '未标注的也要能作为兜底候选');
  assert.equal(r.sceneHits, 0, '一张都没标过时要能区分出来（调用方要靠它换提示语）');
});

test('场景检索：sceneHits 只数真有场合命中的条目', () => {
  const list = [
    normalizeStickerEntry({ id: 'hit', scenes: [{ scene: '嘲讽', intensity: 3 }] }),
    normalizeStickerEntry({ id: 'miss', desc: '没标注' })
  ];
  const r = searchStickersByScene(list, '嘲讽', 0, 5);
  assert.equal(r.sceneHits, 1, '只该数命中的那一张');
  assert.equal(r.candidates.length, 2);
});

test('场景检索：空场景返回空，limit 上限 8', () => {
  const list = Array.from({ length: 20 }, (_, i) => normalizeStickerEntry({ id: `s${i}`, scenes: [{ scene: '嘲讽', intensity: 3 }] }));
  assert.equal(searchStickersByScene(list, '', 0, 5).candidates.length, 0);
  assert.equal(searchStickersByScene(list, '嘲讽', 0, 100).candidates.length, 8, 'limit 要夹到 8');
});

test('注入摘要：画面层优先，有 QQ 备注的不标「没看过」', () => {
  const list = [
    normalizeStickerEntry({ id: 'seen', desc: 'QQ备注', visual: { seen: true, summary: '画面描述' } }),
    normalizeStickerEntry({ id: 'descOnly', desc: '只有备注' }),
    normalizeStickerEntry({ id: 'bare' })
  ];
  const text = buildStickerContext(list, 10);
  assert.ok(text.includes('画面描述'), '画面层优先于 QQ 备注');
  assert.ok(text.includes('只有备注'));
  // 有 desc 的不该被标「没看过」——否则会诱导她把视觉模型调十次
  const descLine = text.split('\n').find((l) => l.includes('只有备注'));
  assert.ok(!descLine.includes('没看过'), '有备注的图不该提示去看图');
  const bareLine = text.split('\n').find((l) => l.startsWith('- （没看过'));
  assert.ok(bareLine, '既没备注又没看过的才提示去看');
});

test('列表输出：带 visual / scenes 两层字段', () => {
  const list = [normalizeStickerEntry({
    id: 'q', desc: 'd', visual: { seen: true, summary: 's' }, scenes: [{ scene: '嘲讽', intensity: 3 }]
  })];
  const out = formatStickerList(list, '', 10);
  assert.equal(out.stickers[0].visual.summary, 's');
  assert.equal(out.stickers[0].scenes[0].scene, '嘲讽');
});

test('真实库能读且全部迁移成功（10 条老数据不报错）', () => {
  // 路径相对项目根推算：开源到别的目录也能跑，也不再暴露本机绝对路径。
  const file = path.join(PROJECT_ROOT, 'state', 'stickers.json');
  if (!fs.existsSync(file)) {
    console.log('  （跳过：没有真实表情库）');
    return;
  }
  const list = loadStickerStore(file);
  assert.ok(list.length > 0);
  for (const e of list) {
    assert.equal(typeof e.visual?.seen, 'boolean', `${e.id} 缺 visual.seen`);
    assert.ok(Array.isArray(e.scenes), `${e.id} 缺 scenes`);
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
