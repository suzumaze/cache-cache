import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentReport } from '../lib/export.js';
import { h } from './fixtures.js';

const at = (hhmmss) => Date.parse(`2026-07-17T${hhmmss}+09:00`);

/** Fastly配下の検証サイト /esi/sidebar/keywords の実測（2026-07-17）。14:57:05 生まれの1つの控えを
 *  71秒追えており、同一ノードのまま hits が 1→2→3→0 に落ちて、その2秒後に別の控えへ入れ替わる。 */
const keywords = (time, age, hits, nodes, ve) => ({
  url: 'https://staging.example.com/esi/sidebar/keywords',
  statusCode: 200,
  fromCache: false,
  receiveTime: at(time),
  headers: h({
    server: 'nginx',
    via: '1.1 varnish',
    age: String(age),
    'x-served-by': nodes,
    'x-cache': 'MISS, HIT',
    'x-cache-hits': hits,
    'x-timer': `S1784267829.805089,VS0,VE${ve}`,
    vary: 'Accept-Encoding',
  }),
});

const NODES_A = 'cache-nrt-rjaa8190021-NRT, cache-nrt-rjtt7900054-NRT';
const NODES_B = 'cache-nrt-rjaa8190037-NRT, cache-nrt-rjtt7900054-NRT';

// サイドパネルが渡す形（新しい順）
const ENTRIES = [
  { label: '現在', record: keywords('14:58:20', 2, '0, 1', NODES_B, 1) },
  { label: '前回', record: keywords('14:58:16', 71, '0, 0', NODES_A, 1) },
  { label: '前々回', record: keywords('14:58:10', 65, '0, 3', NODES_A, 0) },
];

function reportJson(entries, now = at('14:58:21')) {
  const text = buildAgentReport(entries, now);
  const json = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(json, 'JSON ブロックが出力されていない');
  return { text, report: JSON.parse(json[1]) };
}

test('AI向け書き出し: 古い順に並べ替え、ラベルは各記録に残る', () => {
  const { report } = reportJson(ENTRIES);
  assert.equal(report.recordCount, 3);
  assert.deepEqual(report.records.map((r) => r.label), ['前々回', '前回', '現在']);
});

test('AI向け書き出し: 誕生時刻(受信時刻−Age)を計算し、同じ控えかを判定する', () => {
  const { report } = reportJson(ENTRIES);
  const [older, prev, cur] = report.records;
  // 14:58:10 − 65秒 と 14:58:16 − 71秒 は同じ 14:57:05 を指す＝同じ控え
  assert.equal(older.derived.objectBornAt, new Date(at('14:57:05')).toISOString());
  assert.equal(prev.derived.objectBornAt, new Date(at('14:57:05')).toISOString());
  // 14:58:20 − 2秒 = 14:58:18 生まれ＝別の控えに入れ替わっている
  assert.equal(cur.derived.objectBornAt, new Date(at('14:58:18')).toISOString());

  const [t1, t2] = report.transitions;
  assert.equal(t1.elapsedSec, 6);
  assert.equal(t1.ageDeltaSec, 6); // 経過ぶんだけ Age が伸びた
  assert.equal(t1.sameObject, true);
  assert.equal(t2.sameObject, false); // 入れ替わった
});

test('AI向け書き出し: ノードの同一性を出す（hits比較が成立するかの前提）', () => {
  const { report } = reportJson(ENTRIES);
  const [t1, t2] = report.transitions;
  // hits が 3→0 に落ちた区間はノードが同一＝別勘定では説明できない
  assert.equal(t1.sameNodes, true);
  assert.deepEqual(t1.hitsFrom, [0, 3]);
  assert.deepEqual(t1.hitsTo, [0, 0]);
  // 入れ替わった区間は配信ノードが変わっている＝hits の単純比較は成立しない
  assert.equal(t2.sameNodes, false);
});

test('AI向け書き出し: observed は届いたヘッダーをそのまま持つ', () => {
  const { report } = reportJson(ENTRIES);
  const prev = report.records[1];
  assert.equal(prev.observed.headers['x-cache-hits'], '0, 0');
  assert.equal(prev.observed.headers['x-served-by'], NODES_A);
  assert.equal(prev.observed.statusCode, 200);
  assert.equal(prev.verdict, 'ネットワークキャッシュ');
  assert.equal(prev.derived.cdn, 'Fastly');
});

test('AI向け書き出し: 推測（stale/パージの断定）を書かない', () => {
  const { text } = reportJson(ENTRIES);
  assert.doesNotMatch(text, /パージされ|stale配信された|期限切れです/);
});

test('AI向け書き出し: 記録1件でも壊れず、差分は空になる', () => {
  const { report } = reportJson([ENTRIES[0]]);
  assert.equal(report.recordCount, 1);
  assert.deepEqual(report.transitions, []);
});

test('AI向け書き出し: ノードが分からないときは sameNodes を true と偽らない', () => {
  const bare = (time) => ({
    url: 'https://example.com/',
    statusCode: 200,
    fromCache: false,
    receiveTime: at(time),
    headers: h({ server: 'nginx', age: '5' }), // x-served-by 無し
  });
  const { report } = reportJson([
    { label: '現在', record: bare('14:00:02') },
    { label: '前回', record: bare('14:00:00') },
  ], at('14:00:03'));
  // 手がかりが無いので「同じ」とも「違う」とも言わない（原則3）
  assert.equal(report.transitions[0].sameNodes, null);
  assert.deepEqual(report.records[0].derived.nodes, []);
});

test('AI向け書き出し: 単一ノード応答でもノードの同一性を正しく見る', () => {
  const edge = (time, age, node) => ({
    url: 'https://example.com/',
    statusCode: 200,
    fromCache: false,
    receiveTime: at(time),
    headers: h({ via: '1.1 varnish', age: String(age), 'x-served-by': node, 'x-cache': 'HIT', 'x-cache-hits': '2' }),
  });
  const same = reportJson([
    { label: '現在', record: edge('14:00:02', 7, 'cache-nrt-rjtf7700099-NRT') },
    { label: '前回', record: edge('14:00:00', 5, 'cache-nrt-rjtf7700099-NRT') },
  ], at('14:00:03')).report;
  assert.equal(same.transitions[0].sameNodes, true);
  assert.deepEqual(same.transitions[0].hitsFrom, [2]);

  const moved = reportJson([
    { label: '現在', record: edge('14:00:02', 7, 'cache-kix-kxaa7700076-KIX') },
    { label: '前回', record: edge('14:00:00', 5, 'cache-nrt-rjtf7700099-NRT') },
  ], at('14:00:03')).report;
  assert.equal(moved.transitions[0].sameNodes, false);
});

test('AI向け書き出し: Age が無い応答でも誕生時刻を捏造しない', () => {
  const noAge = {
    url: 'https://example.com/',
    statusCode: 200,
    fromCache: false,
    receiveTime: at('14:58:20'),
    headers: h({ server: 'nginx' }),
  };
  const { report } = reportJson([{ label: '現在', record: noAge }]);
  assert.equal(report.records[0].derived.ageSec, null);
  assert.equal(report.records[0].derived.objectBornAt, null);
});

/** Fastly配下の検証サイトでの対照実験（2026-07-17 10:32）。
 *  リクエスト1 → パージ → リクエスト2 → リクエスト3 の並び。パージ直後も古い控えが配られ
 *  （objectBornAt 不変・age は伸び続ける）、同一ノードのまま hits が 7→0 に後退する。 */
const purge = (time, age, hits, delivery) => ({
  url: 'https://staging.example.com/esi/sidebar/keywords',
  statusCode: 200,
  fromCache: false,
  receiveTime: Date.parse(`2026-07-17T${time}+09:00`),
  headers: h({
    via: '1.1 varnish',
    age: String(age),
    'x-served-by': `${delivery}, cache-nrt-rjtt7900031-NRT`,
    'x-cache': 'MISS, HIT',
    'x-cache-hits': hits,
    'x-timer': 'S1784284364.172683,VS0,VE0',
  }),
});
const D48 = 'cache-nrt-rjaa8190048-NRT';

test('hitsDecreased: 同じ控え・同じノードでHIT回数が後退したら true（パージ実測）', () => {
  const { report } = reportJson([
    { label: '現在', record: purge('19:33:02.742', 3, '0, 1', 'cache-nrt-rjaa8190065-NRT') },
    { label: '前回', record: purge('19:32:58.728', 175, '0, 0', D48) },
    { label: '前々回', record: purge('19:32:44.150', 160, '0, 7', D48) },
  ], Date.parse('2026-07-17T19:33:05.514+09:00'));

  const [t1, t2] = report.transitions;
  // パージを打った区間: 古い控えのまま age は伸び、hits だけが 7→0 に逆行した
  assert.equal(t1.sameObject, true);
  assert.equal(t1.sameNodes, true);
  assert.equal(t1.elapsedSec, 15);
  assert.equal(t1.ageDeltaSec, 15); // 経過ぶん Age は伸びている＝同じ控えが配られ続けた
  assert.equal(t1.hitsDecreased, true);
  // 次は別の控えに入れ替わっている＝カウンタが別勘定なので比較しない
  assert.equal(t2.sameObject, false);
  assert.equal(t2.hitsDecreased, null);
});

test('hitsDecreased: 素直に増えているだけなら false、比較不能なら null', () => {
  const { report } = reportJson(ENTRIES); // 3→0 の落差を含む既存の並び
  assert.equal(report.transitions[0].hitsDecreased, true);  // 前々回→前回で 3→0
  assert.equal(report.transitions[1].hitsDecreased, null);  // 控えが入れ替わり比較不能

  const rising = reportJson([
    { label: '現在', record: purge('19:32:46', 162, '0, 8', D48) },
    { label: '前回', record: purge('19:32:44', 160, '0, 7', D48) },
  ], Date.parse('2026-07-17T19:32:47+09:00')).report;
  assert.equal(rising.transitions[0].hitsDecreased, false);
});

test('fastlyDebug: 残りTTL・grace・フェッチ時刻を解析する（footer実測）', () => {
  const rec = {
    url: 'https://staging.example.com/esi/footer/site-contents',
    statusCode: 200,
    fromCache: false,
    receiveTime: Date.parse('2026-07-17T19:25:12.598+09:00'),
    headers: h({
      via: '1.1 varnish',
      age: '25403',
      'surrogate-control': 'max-age=31536000, stale-while-revalidate=180, stale-if-error=86400',
      'x-served-by': 'cache-nrt-rjtt7900080-NRT, cache-nrt-rjtt7900031-NRT',
      'x-cache': 'MISS, HIT',
      'x-cache-hits': '0, 6',
      'fastly-debug-ttl': '(H cache-nrt-rjtt7900031-NRT 31510596.616 86400.000 25403)',
      'fastly-debug-path': '(D cache-nrt-rjtt7900031-NRT 1784283913) (F cache-nrt-rjtt7900094-NRT 1784258510)',
      'fastly-debug-digest': 'cd48382fd9655709aa39f0fed41f512f31cba8e45797f497f4226eb9da82200c',
    }),
  };
  const { report } = reportJson([{ label: '現在', record: rec }], Date.parse('2026-07-17T19:25:43+09:00'));
  const d = report.records[0].derived.fastlyDebug;
  assert.equal(d.state, 'H');
  assert.equal(d.ttlRemainingSec, 31510596.616); // max-age 31536000 − age 25403 と一致
  assert.equal(d.graceSec, 86400);
  assert.equal(d.debugAgeSec, 25403);
  assert.equal(d.fetchNode, 'cache-nrt-rjtt7900094-NRT');
  assert.equal(d.cacheKeyDigest.slice(0, 8), 'cd48382f');
  // Fastly が持つフェッチ時刻と、こちらの「受信時刻 − Age」が独立に一致する
  const born = Date.parse(report.records[0].derived.objectBornAt);
  assert.ok(Math.abs(Date.parse(d.objectFetchedAt) - born) <= 1000);
});

test('fastlyDebug: Fastly-Debug が無効なら null（無い情報を作らない）', () => {
  const { report } = reportJson(ENTRIES);
  assert.equal(report.records[0].derived.fastlyDebug, null);
});

test('ageOriginAnchored: bornAt=last-modified のとき true になり hits 比較は成立しない', () => {
  // 実サイト（本番）の実測形（Age がオリジン世代起点で連鎖。board.md 2026-07-21）
  const fashion = (time, age, hits) => {
    const receiveTime = Date.parse(`2026-07-21T${time}Z`);
    return {
      url: 'https://media.example.com/fashion',
      statusCode: 200,
      fromCache: false,
      receiveTime,
      headers: h({
        via: '1.1 varnish',
        'cache-control': 'max-age=120',
        age: String(age),
        'last-modified': new Date(receiveTime - age * 1000).toUTCString(),
        'x-served-by': 'cache-nrt-rjtf7700072-NRT',
        'x-cache': 'HIT',
        'x-cache-hits': hits,
      }),
    };
  };
  const { report } = reportJson([
    { label: '現在', record: fashion('05:14:00.000', 362, '1') },
    { label: '前回', record: fashion('05:12:53.000', 295, '18') },
  ], Date.parse('2026-07-21T05:14:01Z'));
  assert.equal(report.records[0].derived.ageOriginAnchored, true);
  assert.equal(report.records[1].derived.ageOriginAnchored, true);
  const t = report.transitions[0];
  assert.equal(t.sameObject, true);     // 世代としては同じ（事実はそのまま出す）
  assert.equal(t.hitsDecreased, null);  // ただし CDN の控えの比較としては成立しない
});

test('ageOriginAnchored: last-modified が無ければ null で、従来の検出は変わらない', () => {
  const { report } = reportJson(ENTRIES);
  assert.equal(report.records[0].derived.ageOriginAnchored, null);
  assert.equal(report.transitions[0].hitsDecreased, true); // 実パージの後退は引き続き検出
});

test('AI向け書き出し: 冒頭に分析依頼のプロンプトが付き、観測データより前にある', () => {
  const { text } = reportJson(ENTRIES);
  const promptIdx = text.indexOf('次の観点で分析してください');
  const jsonIdx = text.indexOf('```json');
  assert.ok(promptIdx >= 0 && promptIdx < jsonIdx, 'プロンプトがデータより前に無い');
  // 原則3を受け取り側のAIにも課す
  assert.match(text, /事実（観測と引き算）と推測を分ける/);
  assert.match(text, /「判定できない」と明言する/);
  assert.match(text, /次に何を観測すべきか/);
  // 末尾に質問の書き足し場所
  assert.match(text, /質問があればこの下に書き足してください/);
});
