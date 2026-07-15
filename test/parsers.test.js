import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHeaderMap } from '../lib/headers.js';
import { detectCdn } from '../lib/cdn.js';
import { parseFastly, parseTimerVE } from '../lib/fastly.js';
import { parseCacheStatus } from '../lib/cache-status.js';
import { popCodeOf, popCity } from '../lib/pop.js';
import { h } from './fixtures.js';

const map = (obj) => toHeaderMap(h(obj));

test('detectCdn: Fastly / Cloudflare / CloudFront / Akamai / 標準 / generic / null', () => {
  assert.equal(detectCdn(map({ 'x-served-by': 'cache-nrt-x-NRT', 'x-timer': 'S1,VS0,VE1' })), 'Fastly');
  assert.equal(detectCdn(map({ server: 'cloudflare', 'cf-ray': 'abc-NRT' })), 'Cloudflare');
  assert.equal(detectCdn(map({ via: '1.1 x.cloudfront.net', 'x-amz-cf-id': 'z' })), 'CloudFront');
  assert.equal(detectCdn(map({ 'x-cache': 'TCP_HIT from x (AkamaiGHost)' })), 'Akamai');
  assert.equal(detectCdn(map({ 'cache-status': 'X; hit' })), 'Cache-Status');
  assert.equal(detectCdn(map({ via: '1.1 proxy' })), 'generic');
  assert.equal(detectCdn(map({ server: 'nginx' })), null);
});

test('detectCdn: オリジンVarnish（X-Served-By無し）は Fastly と誤認しない', () => {
  assert.equal(detectCdn(map({ via: '1.1 varnish', 'x-varnish': '123' })), 'generic');
});

test('parseFastly: 同一POPの MISS,HIT はクラスタリング＝エッジ命中（シールドではない）', () => {
  // 両ノードとも NRT＝東京POP内の delivery→fetch。地理的には1拠点なのでシールド扱いしない。
  const f = parseFastly(map({
    'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT',
    'x-cache': 'MISS, HIT',
    'x-cache-hits': '0, 1',
  }));
  assert.equal(f.hit, true);
  assert.equal(f.servedAt, 'edge');
  assert.equal(f.pop.code, 'NRT');
  assert.equal(f.pops, 1);
  assert.equal(f.servedTier, 0);
});

test('parseFastly: 別POPの MISS,HIT はシールド命中', () => {
  // エッジ＝大阪KIX が MISS、東京NRT シールドで HIT。POP が異なるので shield。
  const f = parseFastly(map({
    'x-served-by': 'cache-kix-a-KIX, cache-nrt-b-NRT',
    'x-cache': 'MISS, HIT',
    'x-cache-hits': '0, 1',
  }));
  assert.equal(f.hit, true);
  assert.equal(f.servedAt, 'shield');
  assert.equal(f.pops, 2);
  assert.equal(f.edgePop.code, 'KIX');
  assert.equal(f.pop.code, 'NRT');
  assert.equal(f.servedTier, 1);
});

test('parseFastly: エッジ側クラスタ＋別シールドは POP 数で2段（ノード数3でも）', () => {
  // SJC,SJC(クラスタ)＋NRT(シールド)。命中は SJC の fetch ノード＝エッジ命中。POP は2つ。
  const f = parseFastly(map({
    'x-served-by': 'cache-sjc-a-SJC, cache-sjc-b-SJC, cache-nrt-c-NRT',
    'x-cache': 'MISS, HIT, HIT',
    'x-cache-hits': '0, 3, 1',
  }));
  assert.equal(f.hit, true);
  assert.equal(f.servedAt, 'edge');
  assert.equal(f.pops, 2);
  assert.equal(f.edgePop.code, 'SJC');
  assert.equal(f.pop.code, 'SJC');
  assert.equal(f.servedTier, 0);
});

test('parseFastly: HIT, MISS → edge 命中', () => {
  const f = parseFastly(map({ 'x-served-by': 'cache-lhr-a-LHR, cache-lhr-b-LHR', 'x-cache': 'HIT, MISS' }));
  assert.equal(f.servedAt, 'edge');
  assert.equal(f.pop.code, 'LHR');
});

test('parseTimerVE: VE を抽出', () => {
  assert.equal(parseTimerVE('S1781845958.411360,VS0,VE3'), 3);
  assert.equal(parseTimerVE('S1,VS0,VE42'), 42);
  assert.equal(parseTimerVE(null), null);
});

test('parseCacheStatus: 複数メンバーの hit/fwd', () => {
  const c = parseCacheStatus('"CDN"; hit, ExampleCache; fwd=uri-miss; collapsed; ttl=0');
  assert.equal(c.present, true);
  assert.equal(c.hit, true);
  assert.equal(c.members.length, 2);
  assert.equal(c.members[0].name, 'CDN');
  assert.equal(c.members[1].fwd, 'uri-miss');
});

test('parseCacheStatus: 全 fwd は miss', () => {
  const c = parseCacheStatus('ExampleCache; fwd=uri-miss; stored');
  assert.equal(c.hit, false);
});

test('popCodeOf / popCity', () => {
  assert.equal(popCodeOf('cache-nrt-rjtf7700076-NRT'), 'NRT');
  assert.equal(popCity('NRT'), '東京');
  assert.equal(popCity('ZZZ'), null);
});
