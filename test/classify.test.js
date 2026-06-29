import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.js';
import { FIXTURES } from './fixtures.js';

test('Fastly 東京シールドで命中 → ネットワークキャッシュ', () => {
  const v = classify(FIXTURES.fastlyShieldTokyo);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.name, 'Fastly');
  assert.equal(v.cdn.servedAt, 'shield');
  assert.equal(v.cdn.pop.code, 'NRT');
  assert.equal(v.cdn.pop.city, '東京');
  assert.equal(v.cdn.layers, 2);
  assert.equal(v.freshness.mode, 'unknown'); // Cache-Control 不在
  assert.equal(v.freshness.ageKnown, true);
  assert.equal(v.speed.ttfbMs, 3);
});

test('Fastly エッジで命中（1段）', () => {
  const v = classify(FIXTURES.fastlyEdgeHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.servedAt, 'edge');
  assert.equal(v.cdn.layers, 1);
});

test('Fastly 全MISS → サーバー作りたて＋生成時間', () => {
  const v = classify(FIXTURES.fastlyMissFresh);
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'fresh');
  assert.equal(v.speed.serverMs, 42);
});

test('Cloudflare HIT → ネットワークキャッシュ・POP=NRT', () => {
  const v = classify(FIXTURES.cloudflareHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.name, 'Cloudflare');
  assert.equal(v.cdn.pop.code, 'NRT');
  assert.equal(v.freshness.mode, 'countdown');
});

test('Cloudflare DYNAMIC → サーバー作りたて', () => {
  const v = classify(FIXTURES.cloudflareDynamic);
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'fresh');
  assert.equal(v.freshness.mode, 'no-store');
});

test('CloudFront Hit → ネットワークキャッシュ・POP=NRT', () => {
  const v = classify(FIXTURES.cloudfrontHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.name, 'CloudFront');
  assert.equal(v.cdn.pop.code, 'NRT');
});

test('CloudFront Miss → サーバー', () => {
  const v = classify(FIXTURES.cloudfrontMiss);
  assert.equal(v.origin.state, 'server');
});

test('Akamai TCP_HIT → ネットワークキャッシュ', () => {
  const v = classify(FIXTURES.akamaiHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.name, 'Akamai');
});

test('Akamai TCP_MISS → サーバー作りたて', () => {
  const v = classify(FIXTURES.akamaiMiss);
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'fresh');
});

test('RFC 9211 Cache-Status hit → ネットワークキャッシュ', () => {
  const v = classify(FIXTURES.cacheStatusHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.name, '標準キャッシュ');
});

test('RFC 9211 Cache-Status fwd=miss → サーバー', () => {
  const v = classify(FIXTURES.cacheStatusMiss);
  assert.equal(v.origin.state, 'server');
});

test('ブラウザキャッシュ（fromCache）', () => {
  const v = classify(FIXTURES.browserCache);
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, false);
});

test('ブラウザキャッシュ（304 再確認あり）', () => {
  const v = classify(FIXTURES.browserRevalidated);
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
});

test('メモリキャッシュ（deliveryType=cache）→ ブラウザキャッシュ', () => {
  const v = classify(FIXTURES.memoryCache);
  assert.equal(v.origin.state, 'browser');
});

test('オリジンVarnish（Via varnish＋X-Varnish＋Age>0, X-Served-By無し）→ サーバー側キャッシュ', () => {
  const v = classify(FIXTURES.originVarnish);
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'server-cache');
});

test('汎用プロキシ（Via＋Age>0, オリジン痕跡なし）→ ネットワークキャッシュ', () => {
  const v = classify(FIXTURES.genericProxyHit);
  assert.equal(v.origin.state, 'network');
  assert.equal(v.cdn.generic, true);
});

test('オリジン直・手がかり無し → サーバー（内訳不明）', () => {
  const v = classify(FIXTURES.originDirectUnknown);
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'unknown');
});

test('信号が一切無い → 特定できない', () => {
  const v = classify(FIXTURES.noSignal);
  assert.equal(v.origin.state, 'unknown');
});
