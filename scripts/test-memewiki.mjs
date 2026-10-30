// 梗百科（github:in1t1a1/astrbot_plugin_memewiki）检索的回归测试。
//
// 要点：
//   · 梗库必须**独立于群内黑话库**。slang.json 有 2000 条上限、存的是带证据的群内黑话；
//     6668 条全网梗倒进去会触发裁剪，把群内黑话挤掉。所以这里钉死"两个文件分开"。
//   · 检索要**分层**：梗名/标签优先，正文匹配只作兜底。否则查「急了」会拉出一堆
//     只是正文提到该词的词条，对判断"这词什么意思"没有帮助。
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 相对项目根；文件不存在时跳过真实数据用例（刚 clone 的仓库就没有 state/）。
import { fileURLToPath } from 'node:url';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(PROJECT_ROOT, 'state', 'memewiki.json');

// 小 fixture：够验证打分与分层，又不依赖线上的 6668 条。
const FIXTURE_ITEMS = [
  { t: '典', g: ['文字梗', '贴吧梗'], u: '当对方发表陈词滥调时直接回“典”。' },
  { t: '破防', g: ['网络用语', '情绪表达'], u: '形容内心防线被击穿。' },
  { t: '典型发言', g: ['文字梗'], u: '指那些一看就知道会说的话。' },
  { t: '无关词条', g: ['游戏梗'], u: '本条正文提到了典这个字，但标题和标签都不沾边。' },
];
const fixtureFiles = (items) => ({
  'state/memewiki.json': JSON.stringify({ source: 'fixture', count: items.length, items }),
  'state/current-role.json': { role: null, mode: 'active' },
  // 群内黑话库：证明两者互不污染。
  'state/slang.json': [{
    id: 'x1', content: '白饭', meaning: '群内梗：白嫖的饭', usage: '吃白饭', example: '',
    risk: '', sources: [], status: 'confirmed', source: 'ai', count: 3, evidence: [],
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
  }],
});

await test('梗库独立于群内黑话库（不共用一个文件）', async () => {
  const h = await bridgeHarness({ files: fixtureFiles(FIXTURE_ITEMS) });
  try {
    // 群内黑话只有「白饭」；梗库里没有它 → 从梗库查「白饭」应为空。
    assert.equal(h.searchMemeWiki('白饭', 5).length, 0, '梗库不该被群内黑话污染');
    // 反过来：梗库能查到「典」，但它不在群内黑话里。
    assert.ok(h.searchMemeWiki('典', 5).length > 0);
  } finally { await h.close(); }
});

await test('精确命中排在最前，前缀次之', async () => {
  const h = await bridgeHarness({ files: fixtureFiles(FIXTURE_ITEMS) });
  try {
    const r = h.searchMemeWiki('典', 5);
    assert.equal(r[0].t, '典', '精确同名必须排第一');
    assert.ok(r.some((x) => x.t === '典型发言'), '前缀命中也要在');
  } finally { await h.close(); }
});

await test('正文匹配只作兜底，不跟标题/标签命中抢位', async () => {
  const h = await bridgeHarness({ files: fixtureFiles(FIXTURE_ITEMS) });
  try {
    const r = h.searchMemeWiki('典', 5);
    const titles = r.map((x) => x.t);
    assert.ok(titles.includes('典'));
    // 「无关词条」只在正文里提到「典」，有更好的命中时不该出现。
    assert.ok(!titles.includes('无关词条'), '正文命中不该挤进标题/标签命中的结果');
    // 但当标题/标签都不沾边时，正文兜底要生效。
    const onlyBody = h.searchMemeWiki('标题和标签都不沾边', 5);
    assert.ok(onlyBody.length > 0, '没有更好命中时应退回正文匹配');
    assert.equal(onlyBody[0].t, '无关词条');
  } finally { await h.close(); }
});

await test('空查询与查不到都返回空数组（不能倒出整库）', async () => {
  const h = await bridgeHarness({ files: fixtureFiles(FIXTURE_ITEMS) });
  try {
    assert.equal(h.searchMemeWiki('', 10).length, 0);
    assert.equal(h.searchMemeWiki('完全不存在的词xyz', 10).length, 0);
  } finally { await h.close(); }
});

await test('公开形状与黑话条目一致（调用方不用区分来源）', async () => {
  const h = await bridgeHarness({ files: fixtureFiles(FIXTURE_ITEMS) });
  try {
    const pub = h.publicMemeEntry(h.searchMemeWiki('破防', 1)[0]);
    assert.equal(pub.content, '破防');
    assert.equal(pub.source, 'memewiki');
    assert.equal(pub.status, 'confirmed');
    assert.ok(pub.meaning.includes('内心防线'));
    assert.ok(Array.isArray(pub.sources) && pub.sources.length > 0, '要标出来源，方便追溯');
    for (const k of ['id', 'content', 'meaning', 'usage', 'example', 'risk', 'sources', 'status', 'source', 'count', 'updatedAt']) {
      assert.ok(Object.hasOwn(pub, k), `缺少字段 ${k}（与 publicSlangEntry 形状不一致）`);
    }
  } finally { await h.close(); }
});

await test('真实梗库可加载且规模正确', async () => {
  if (!fs.existsSync(REAL)) {
    console.log('  （跳过：真实梗库不在，先跑一次导出）');
    return;
  }
  const raw = fs.readFileSync(REAL, 'utf8');
  const h = await bridgeHarness({ files: { 'state/memewiki.json': raw, 'state/current-role.json': { role: null, mode: 'active' } } });
  try {
    const items = h.memeWikiItems();
    assert.ok(items.length > 6000, `真实梗库只有 ${items.length} 条，疑似导出不全`);
    const r = h.searchMemeWiki('典', 3);
    assert.ok(r.length > 0);
    assert.equal(r[0].t, '典', '真实库里「典」应精确命中');
  } finally { await h.close(); }
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
