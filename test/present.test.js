import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';
import { FIXTURES } from './fixtures.js';

test('Fastly東京シールド: L1 はネットワークキャッシュ・バッジC(緑)・有効期限は非公開', () => {
  const p = present(classify(FIXTURES.fastlyShieldTokyo));
  assert.equal(p.l1.label, 'ネットワークキャッシュ');
  assert.equal(p.l1.icon, 'cloud');
  assert.equal(p.badge.color, '#15803D'); // ネットワーク=緑
  assert.equal(p.badge.text, 'C');
  assert.match(p.l1.freshness, /非公開/);
  assert.match(p.l1.speed, /ミリ秒/);
  // L2 にエッジ/シールド・POP都市が出る
  const labels = p.l2.rows.map((r) => r.label);
  assert.ok(labels.includes('シールド'));
  assert.ok(labels.includes('返ってきた場所'));
  assert.ok(labels.includes('最寄りの拠点'));
  assert.ok(labels.includes('見つかった拠点'));
  assert.ok(labels.includes('条件別キャッシュ（Vary）'));
  const shield = p.l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /あり/);
});

test('Fastly 同一POPクラスタリング: シールドと誤表示せず、エッジ命中として示す', () => {
  const p = present(classify(FIXTURES.fastlyClusterTokyo));
  const shield = p.l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /判定できません/); // 「あり」と誤断定しない
  const served = p.l2.rows.find((r) => r.label === '返ってきた場所');
  assert.match(served.value, /エッジ/);
  assert.doesNotMatch(served.value, /シールド/);
  // 同一拠点なので「見つかった拠点」は出さず、最寄り（東京）を1つだけ示す
  const labels = p.l2.rows.map((r) => r.label);
  assert.ok(!labels.includes('見つかった拠点'));
  const nearest = p.l2.rows.find((r) => r.label === '最寄りの拠点');
  assert.match(nearest.value, /東京/);
});

test('Fastly 全MISS: L1 はサーバー（作りたて）・バッジS(赤)', () => {
  const p = present(classify(FIXTURES.fastlyMissFresh));
  assert.equal(p.l1.label, 'サーバー（作りたて）');
  assert.equal(p.badge.color, '#DC2626'); // サーバー=赤
  assert.equal(p.badge.text, 'S');
  assert.equal(p.l1.freshness, '今ご覧のものが最新です');
});

test('ブラウザキャッシュ: バッジ家', () => {
  const p = present(classify(FIXTURES.browserCache));
  assert.equal(p.l1.label, 'ブラウザキャッシュ');
  assert.equal(p.badge.color, '#2563EB'); // ブラウザ=青
  assert.equal(p.badge.text, 'B');
});

test('特定できない: L1 文言・バッジ?(灰)', () => {
  const p = present(classify(FIXTURES.noSignal));
  assert.match(p.l1.label, /特定できませんでした/);
  assert.equal(p.badge.color, '#6B7280'); // 特定できず=グレー
  assert.equal(p.badge.text, '?');
});

test('L1 文言に専門語（CDN/オリジン）が出ない（原則1）', () => {
  for (const key of ['fastlyShieldTokyo', 'cloudflareHit', 'fastlyMissFresh', 'akamaiHit', 'originVarnish', 'browserCache']) {
    const p = present(classify(FIXTURES[key]));
    const l1 = [p.l1.label, p.l1.lead, p.l1.freshness, p.l1.speed].filter(Boolean).join(' ');
    assert.doesNotMatch(l1, /CDN|オリジン|origin|private cache|TTFB/i, `L1 に専門語: ${key} → ${l1}`);
  }
});

test('用語補足は L2 のみに現れる', () => {
  const p = present(classify(FIXTURES.fastlyShieldTokyo));
  assert.ok(p.l2.terms.length > 0);
  assert.ok(p.l2.terms.some((t) => t.term === 'CDN'));
});

test('キャッシュタグ: 重複を畳んで L2 に名札で出し、生ヘッダーは原文のまま残す', () => {
  const v = classify(FIXTURES.fastlyDebugTags);
  // 空白区切りと ", " 結合が混在していても、同じタグは1つに畳む
  assert.deepEqual(v.tags, ['article-42', 'top', 'news']);
  const p = present(v);
  const tagRow = p.l2.rows.find((r) => r.label === 'キャッシュタグ');
  assert.deepEqual(tagRow.tags, ['article-42', 'top', 'news']);
  assert.equal(tagRow.value, undefined); // 値ではなく名札で描画する
  // 「切れ方」はタグ式（＋Surrogate-Control の時間式）として示され、用語補足が付く
  const how = p.l2.rows.find((r) => r.label === 'キャッシュの切れ方');
  assert.match(how.value, /タグ式/);
  assert.ok(p.l2.terms.some((t) => t.term === 'パージ'));
  // L3 の生ヘッダーは畳まず、届いた原文のまま（原則3）
  const raw = v.raw.headers.find((hh) => hh.name === 'surrogate-key');
  assert.equal(raw.value, 'article-42 top article-42, top news');
});

test('キャッシュタグ: Surrogate-Key が無ければタグの行も用語も出さない', () => {
  const p = present(classify(FIXTURES.fastlyEdgeHit));
  assert.equal(classify(FIXTURES.fastlyEdgeHit).tags, null);
  assert.ok(!p.l2.rows.some((r) => r.label === 'キャッシュタグ'));
  assert.ok(!p.l2.terms.some((t) => t.term === 'パージ'));
});
