// テスト用フィクスチャ。SPEC §6 の Fastly 東京シールド命中の実測ヘッダーを基準に、各CDN・各状態を網羅する。
export const NOW = Date.parse('2026-06-19T12:00:00Z');

/** {name: value} → webRequest 形式のヘッダー配列 */
export function h(obj) {
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

/** 入力を組み立てる。既定は「ネットワーク到達・キャッシュ非由来・受信は今」。 */
export function input(headers, extra = {}) {
  return {
    headers,
    statusCode: 200,
    ip: '151.101.1.1',
    fromCache: false,
    deliveryType: null,
    ttfbMs: null,
    receiveTime: NOW,
    now: NOW,
    ...extra,
  };
}

export const FIXTURES = {
  // SPEC §6 の実測（Fastly）。両ノードとも NRT＝東京POP内のクラスタリング（delivery MISS→fetch HIT）で、
  // 別拠点のシールドではない。地理的には東京1拠点＝エッジ命中扱い。
  fastlyClusterTokyo: input(h({
    server: 'nginx',
    via: '1.1 varnish',
    'x-served-by': 'cache-nrt-rjtf7700076-NRT, cache-nrt-rjtt7900040-NRT',
    'x-cache': 'MISS, HIT',
    'x-cache-hits': '0, 1',
    age: '7',
    'x-timer': 'S1781845958.411360,VS0,VE3',
    vary: 'X-Device-Type, Accept-Encoding',
  }), { ttfbMs: 3 }),

  // 別拠点のオリジンシールドで命中（エッジ＝大阪KIX は MISS、シールド＝東京NRT で HIT）。
  fastlyShieldTokyo: input(h({
    server: 'nginx',
    via: '1.1 varnish',
    'x-served-by': 'cache-kix-kxaa7700076-KIX, cache-nrt-rjtt7900040-NRT',
    'x-cache': 'MISS, HIT',
    'x-cache-hits': '0, 1',
    age: '7',
    'x-timer': 'S1781845958.411360,VS0,VE3',
    vary: 'X-Device-Type, Accept-Encoding',
  }), { ttfbMs: 3 }),

  fastlyEdgeHit: input(h({
    via: '1.1 varnish',
    'x-served-by': 'cache-nrt-rjtf7700099-NRT',
    'x-cache': 'HIT',
    'x-cache-hits': '1',
    age: '30',
    'x-timer': 'S1.0,VS0,VE0',
  })),

  fastlyMissFresh: input(h({
    via: '1.1 varnish',
    'x-served-by': 'cache-nrt-a7700099-NRT, cache-nrt-b7900040-NRT',
    'x-cache': 'MISS, MISS',
    'x-cache-hits': '0, 0',
    'x-timer': 'S1.0,VS0,VE42',
    'cache-control': 'private, no-cache',
    age: '0',
  })),

  cloudflareHit: input(h({
    server: 'cloudflare',
    'cf-ray': '8a1b2c3d4e5f6a7b-NRT',
    'cf-cache-status': 'HIT',
    age: '100',
    'cache-control': 'public, max-age=3600',
  })),

  cloudflareDynamic: input(h({
    server: 'cloudflare',
    'cf-ray': '8a1b2c3d4e5f6a7b-LHR',
    'cf-cache-status': 'DYNAMIC',
    'cache-control': 'no-store',
  })),

  cloudfrontHit: input(h({
    via: '1.1 abcdef0123.cloudfront.net (CloudFront)',
    'x-amz-cf-id': 'AbCdEf==',
    'x-amz-cf-pop': 'NRT57-C1',
    'x-cache': 'Hit from cloudfront',
    age: '5',
    'cache-control': 'public, max-age=86400',
  })),

  cloudfrontMiss: input(h({
    via: '1.1 abcdef0123.cloudfront.net (CloudFront)',
    'x-amz-cf-id': 'GhIjKl==',
    'x-amz-cf-pop': 'IAD12-C2',
    'x-cache': 'Miss from cloudfront',
    'cache-control': 'max-age=0, no-cache',
    age: '0',
  })),

  akamaiHit: input(h({
    'x-cache': 'TCP_HIT from a23-45-67.deploy.akamaitechnologies.com (AkamaiGHost)',
    age: '12',
    'cache-control': 'max-age=600',
  })),

  akamaiMiss: input(h({
    'x-cache': 'TCP_MISS from a23-45-67.deploy.akamaitechnologies.com (AkamaiGHost)',
    'cache-control': 'no-store',
    age: '0',
  })),

  cacheStatusHit: input(h({
    'cache-status': '"ExampleCDN"; hit; ttl=300',
    age: '40',
    'cache-control': 'public, max-age=300',
  })),

  cacheStatusMiss: input(h({
    'cache-status': 'ExampleCDN; fwd=uri-miss; stored',
    'cache-control': 'private',
    age: '0',
  })),

  browserCache: input(h({
    'cache-control': 'max-age=600',
    date: 'Fri, 19 Jun 2026 11:59:00 GMT',
    age: '0',
  }), { fromCache: true, ip: '' }),

  browserRevalidated: input(h({
    'cache-control': 'max-age=0',
    date: 'Fri, 19 Jun 2026 12:00:00 GMT',
  }), { statusCode: 304, ip: '93.184.216.34' }),

  originVarnish: input(h({
    server: 'nginx',
    via: '1.1 varnish (Varnish/7.0)',
    'x-varnish': '123456 654321',
    age: '20',
    'cache-control': 'public, max-age=120',
  })),

  genericProxyHit: input(h({
    via: '1.1 proxy.example.com',
    age: '50',
    'cache-control': 'public, max-age=3600',
  })),

  originDirectUnknown: input(h({
    server: 'nginx',
    'cache-control': 'public, max-age=600',
    age: '0',
    date: 'Fri, 19 Jun 2026 12:00:00 GMT',
  })),

  memoryCache: input([], { fromCache: false, ip: '', deliveryType: 'cache', statusCode: 200 }),

  noSignal: { headers: [], statusCode: null, ip: '', fromCache: false, deliveryType: null, receiveTime: NOW, now: NOW },
};
