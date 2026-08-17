import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInvalidation } from '../lib/invalidation.js';
import { h } from './fixtures.js';

const at = (t) => Date.parse(`2026-07-17T${t}Z`);

/** Fastly配下の検証サイトの実測形。records は新しい順（sidepanel の tabRecords と同じ）。 */
const rec = (time, age, hits, delivery, extra = {}) => ({
  url: 'https://staging.example.com/esi/sidebar/keywords',
  statusCode: 200,
  fromCache: false,
  receiveTime: at(time),
  headers: h({
    via: '1.1 varnish',
    age: String(age),
    'x-served-by': `${delivery}, cache-nrt-rjtt7900031-NRT`,
    'x-cache': 'MISS, HIT',
    'x-cache-hits': hits,
    ...extra,
  }),
});
const D48 = 'cache-nrt-rjaa8190048-NRT';
const D65 = 'cache-nrt-rjaa8190065-NRT';

test('パージ実測(7→0): stale配信の記録に形跡が立ち、後続の入れ替わりも分かる', () => {
  const marks = detectInvalidation([
    rec('10:33:02.742', 3, '0, 1', D65),    // 新しい控え
    rec('10:32:58.728', 175, '0, 0', D48),  // パージ直後の古い控え（hits 7→0）
    rec('10:32:44.150', 160, '0, 7', D48),  // パージ前
  ]);
  assert.deepEqual(marks.map((m) => m.invalidated), [false, true, false]);
  assert.equal(marks[1].replacedLater, true); // 次の記録で別の控えに切り替わっている
});

test('パージ実測(6→1): hits が 0 でなくても後退なら形跡が立つ（単独判定では取りこぼす形）', () => {
  const marks = detectInvalidation([
    rec('05:58:20.000', 2, '0, 1', 'cache-nrt-rjaa8190037-NRT'), // 入れ替わり後
    rec('05:58:16.000', 71, '0, 1', 'cache-nrt-rjaa8190021-NRT'), // stale配信（hits 6→1）
    rec('05:58:10.000', 65, '0, 6', 'cache-nrt-rjaa8190021-NRT'),
  ]);
  // 中央の記録: hits==1 なので単独の形跡は立たないが、同一控え・同一ノードで 6→1 の後退
  assert.deepEqual(marks.map((m) => m.invalidated), [false, true, false]);
  assert.equal(marks[1].replacedLater, true);
});

test('正常な増加(6→10, footer実測): どの記録にも形跡は立たない', () => {
  const footer = (time, age, hits) => rec(time, age, hits, 'cache-nrt-rjtt7900080-NRT');
  const marks = detectInvalidation([
    footer('10:25:41.114', 25432, '0, 10'),
    footer('10:25:39.478', 25430, '0, 9'),
    footer('10:25:37.094', 25428, '0, 8'),
    footer('10:25:15.165', 25406, '0, 7'),
    footer('10:25:12.598', 25403, '0, 6'),
  ]);
  assert.ok(marks.every((m) => !m.invalidated));
});

test('単独記録でも形跡が立つ: HIT + 配信段hits==0 + Age>0（M観測の実データ）', () => {
  const marks = detectInvalidation([
    rec('10:38:40.964', 341, '0, 0', 'cache-nrt-rjaa8190051-NRT', {
      'fastly-debug-ttl': '(M cache-nrt-rjtt7900031-NRT - - 341)',
    }),
  ]);
  assert.equal(marks[0].invalidated, true);
  assert.equal(marks[0].replacedLater, false); // 新しい記録がまだ無い
});

test('通常の初回命中(hits 1, age小)は形跡にしない', () => {
  const marks = detectInvalidation([rec('05:57:06.000', 1, '0, 1', 'cache-nrt-rjaa8190021-NRT')]);
  assert.equal(marks[0].invalidated, false);
});

test('別の控えへの入れ替わりでは hits が数として減っても比較しない', () => {
  // [0,6] の古い控え → 入れ替わって [0,1] の新しい控え。数は減るが別勘定なので形跡ではない
  const marks = detectInvalidation([
    rec('10:33:02.742', 3, '0, 1', D65),
    rec('10:32:44.150', 160, '0, 6', D48),
  ]);
  assert.ok(marks.every((m) => !m.invalidated));
});

test('Fastly でない応答には立てない（x-cache-hits 風の値があっても）', () => {
  const notFastly = {
    url: 'https://example.com/',
    statusCode: 200,
    fromCache: false,
    receiveTime: at('10:00:00'),
    headers: h({ server: 'nginx', age: '100', 'x-cache': 'HIT', 'x-cache-hits': '0' }),
  };
  const marks = detectInvalidation([notFastly]);
  assert.equal(marks[0].invalidated, false);
});

/** 実サイト（本番）型: Age がオリジン側キャッシュの世代起点で連鎖するサイト
 *  （last-modified = 受信時刻−Age が秒単位で一致。board.md 2026-07-21）。 */
const anchored = (time, age, hits, { lm = true } = {}) => {
  const receiveTime = at(time);
  const headers = {
    via: '1.1 varnish',
    'cache-control': 'max-age=120',
    age: String(age),
    'x-served-by': 'cache-nrt-rjtf7700072-NRT',
    'x-cache': 'HIT',
    'x-cache-hits': hits,
  };
  if (lm) headers['last-modified'] = new Date(receiveTime - age * 1000).toUTCString();
  return {
    url: 'https://media.example.com/fashion',
    statusCode: 200,
    fromCache: false,
    receiveTime,
    headers: h(headers),
  };
};

test('オリジン錨のAge(last-modified=bornAt)では hits 後退を形跡にしない（自然満了の取り直しと区別不能）', () => {
  // 同じ世代をFastlyが取り直すと bornAt 一致のまま hits がリセットされる偽陽性シナリオ。
  // 18→1 の後退だが、bornAt は CDN の控えを識別していないので黙る。
  const marks = detectInvalidation([
    anchored('05:14:00.000', 362, '1'),
    anchored('05:12:53.000', 295, '18'),
  ]);
  assert.ok(marks.every((m) => !m.invalidated));
});

test('同じ後退でも last-modified が無ければ（CDN錨とみなせるので）形跡になる', () => {
  const marks = detectInvalidation([
    anchored('05:14:00.000', 362, '1', { lm: false }),
    anchored('05:12:53.000', 295, '18', { lm: false }),
  ]);
  assert.deepEqual(marks.map((m) => m.invalidated), [true, false]);
});

test('last-modified があっても bornAt と離れていれば（静的ファイル型）検出を維持する', () => {
  const staticLike = (time, age, hits) => {
    const r = anchored(time, age, hits, { lm: false });
    r.headers.push({ name: 'last-modified', value: 'Wed, 01 Jul 2026 00:00:00 GMT' });
    return r;
  };
  const marks = detectInvalidation([
    staticLike('05:14:00.000', 362, '1'),
    staticLike('05:12:53.000', 295, '18'),
  ]);
  assert.deepEqual(marks.map((m) => m.invalidated), [true, false]);
});
