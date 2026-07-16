import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';
import { FIXTURES } from './fixtures.js';

test('Fastly東京シールド: L1 はネットワークキャッシュ・バッジ網・有効期限は非公開', () => {
  const p = present(classify(FIXTURES.fastlyShieldTokyo));
  assert.equal(p.l1.label, 'ネットワークキャッシュ');
  assert.equal(p.l1.icon, 'cloud');
  assert.equal(p.badge.text, '網');
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

test('Fastly 全MISS: L1 はサーバー（作りたて）・バッジ新', () => {
  const p = present(classify(FIXTURES.fastlyMissFresh));
  assert.equal(p.l1.label, 'サーバー（作りたて）');
  assert.equal(p.badge.text, '新');
  assert.equal(p.l1.freshness, '今ご覧のものが最新です');
});

test('ブラウザキャッシュ: バッジ家', () => {
  const p = present(classify(FIXTURES.browserCache));
  assert.equal(p.l1.label, 'ブラウザキャッシュ');
  assert.equal(p.badge.text, '家');
});

test('特定できない: L1 文言・バッジ?', () => {
  const p = present(classify(FIXTURES.noSignal));
  assert.match(p.l1.label, /特定できませんでした/);
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
