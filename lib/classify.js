// 出どころ判定のオーケストレータ。SPEC §3/§5 に従い
// 「あなた(ブラウザ) → ネットワーク → サーバー」の順に控えを探し、最初に当たった所で確定する。
import { toHeaderMap, get, has, parseAge, splitList, ccHas } from './headers.js';
import { detectCdn } from './cdn.js';
import { parseFastly } from './fastly.js';
import { parseCloudflare } from './cloudflare.js';
import { parseCloudFront } from './cloudfront.js';
import { parseAkamai } from './akamai.js';
import { parseCacheStatus } from './cache-status.js';
import { classifyServer } from './server.js';
import { freshness } from './freshness.js';

// オリジン側の自前リバースプロキシ（CDNではない）の手がかり
const ORIGIN_PROXY_HEADERS = ['x-varnish', 'x-drupal-cache', 'x-litespeed-cache', 'x-proxy-cache', 'x-fastcgi-cache', 'x-nginx-cache'];

function parseVary(map) {
  const v = get(map, 'vary');
  if (!v) return null;
  const list = splitList(v).map((s) => s.toLowerCase());
  if (list.includes('*')) return ['*'];
  return list.length ? list : null;
}

function revalidationTarget(map, ip) {
  const which = detectCdn(map);
  if (which === 'Fastly') {
    const f = parseFastly(map);
    return { name: 'Fastly', ip, pop: f.edgePop || f.pop, status: f.states?.join(', ') || null };
  }
  if (which === 'Cloudflare') {
    const c = parseCloudflare(map);
    return { name: 'Cloudflare', ip, pop: c.pop, status: c.status || null };
  }
  if (which === 'CloudFront') {
    const c = parseCloudFront(map);
    return { name: 'CloudFront', ip, pop: c.pop, status: c.xcache || null };
  }
  if (which === 'Akamai') {
    const c = parseAkamai(map);
    return { name: 'Akamai', ip, pop: null, status: c.xcache || null };
  }
  if (which === 'Cache-Status') {
    const c = parseCacheStatus(get(map, 'cache-status'));
    return { name: '標準キャッシュ', ip, pop: null, status: c.hit ? 'hit' : 'miss' };
  }
  if (which === 'generic') return { name: '中継キャッシュ', ip, pop: null, status: null };
  return ip ? { name: null, ip, pop: null, status: null } : null;
}

/**
 * @param {object} input
 * @param {{name:string,value?:string}[]} input.headers
 * @param {number|null} input.statusCode
 * @param {string} input.ip
 * @param {boolean} input.fromCache
 * @param {string|null} input.deliveryType  Performance API の deliveryType（'cache' 等）
 * @param {number|null} input.responseStatus Performance API の responseStatus
 * @param {number|null} input.transferSize   Performance API の transferSize
 * @param {number|null} input.encodedBodySize Performance API の encodedBodySize
 * @param {number|null} input.ttfbMs
 * @param {number|null} input.receiveTime    epoch ミリ秒（応答受信時刻）
 * @param {number} input.now                  epoch ミリ秒（判定時刻）
 */
export function classify(input = {}) {
  const {
    headers = [],
    statusCode = null,
    ip = '',
    fromCache = false,
    deliveryType = null,
    responseStatus = null,
    transferSize = null,
    encodedBodySize = null,
    ttfbMs = null,
    serverTiming = null,
    receiveTime = null,
    now = Date.now(),
  } = input;

  const map = toHeaderMap(headers);
  const frCtx = { receiveTime: receiveTime ?? now, now };
  const frShared = freshness(map, frCtx); // 共有キャッシュ(CDN/プロキシ)用
  const frPrivate = freshness(map, { ...frCtx, shared: false }); // private(ブラウザ)キャッシュ用
  const vary = parseVary(map);
  const speed = { ttfbMs: typeof ttfbMs === 'number' && ttfbMs >= 0 ? ttfbMs : null, serverMs: null };
  const hasResponse = headers.length > 0 || statusCode != null;
  const hasAnySignal = hasResponse || fromCache === true || !!deliveryType;
  const perfCache = deliveryType === 'cache';
  // Resource Timing は再検証済みキャッシュを `cache mode = validated` とし、transferSize を 300 にする。
  // responseStatus=304 が取れる環境ではそれを最優先の根拠にする。
  const perfValidated = responseStatus === 304 || (perfCache && transferSize === 300);

  let origin = null;
  let cdn = null;
  let server = null;

  // ① ブラウザキャッシュ
  if ((statusCode === 304 && ip) || responseStatus === 304) {
    origin = { state: 'browser', revalidated: true };
  } else if ((fromCache === true || perfCache) && (statusCode === 200 || statusCode == null)) {
    // fromCache=true は「本体がブラウザのディスクキャッシュから来た」を意味する（Chromium の
    // was_fetched_via_cache）。ip が入っていても（304再検証でネットワークに往復した、または
    // キャッシュ済みの元レスポンスの ip が残る）、出どころはブラウザキャッシュ。x-cache 等の CDN
    // ヘッダーはキャッシュされた中身に過ぎず、ここで network と誤判定してはいけない。
    // 鮮度は private 文脈(frPrivate)で判定する（s-maxage/Surrogate-Control は共有キャッシュ専用で
    // ブラウザには効かない・RFC 9111）。再検証(304)の有無: webRequest は 304 をキャッシュ済み200に
    // 統合して報告し、if-modified-since も渡さない（実機で DevTools=304 でも観測不可を確認）。そのため
    // 「期限切れ(stale)のキャッシュが配信された＝ブラウザは stale をそのまま使わず再検証(304)して使った」
    // と推論し revalidated とする。no-cache は定義上「使う前に必ず再検証」なので配信された＝再検証済み。
    const stale = frPrivate.mode === 'countdown' && frPrivate.remainingSec <= 1;
    const noCache = ccHas(get(map, 'cache-control') || '', 'no-cache');
    origin = { state: 'browser', revalidated: perfValidated || stale || noCache };
  }

  if (!origin) {
    const which = detectCdn(map);
    if (which === 'Fastly') {
      const f = parseFastly(map);
      cdn = { name: 'Fastly', ...f };
      if (f.hit) origin = { state: 'network' };
      else { origin = { state: 'server' }; server = { kind: classifyServer(map, { cdnPresent: true }) }; speed.serverMs = f.serverMs ?? null; }
    } else if (which === 'Cloudflare') {
      const c = parseCloudflare(map);
      cdn = { name: 'Cloudflare', ...c };
      if (c.hit) origin = { state: 'network' };
      else { origin = { state: 'server' }; server = { kind: classifyServer(map, { cdnPresent: true }) }; }
    } else if (which === 'CloudFront') {
      const c = parseCloudFront(map);
      cdn = { name: 'CloudFront', ...c };
      if (c.hit) origin = { state: 'network' };
      else { origin = { state: 'server' }; server = { kind: classifyServer(map, { cdnPresent: true }) }; }
    } else if (which === 'Akamai') {
      const c = parseAkamai(map);
      cdn = { name: 'Akamai', ...c };
      if (c.hit) origin = { state: 'network' };
      else { origin = { state: 'server' }; server = { kind: classifyServer(map, { cdnPresent: true }) }; }
    } else if (which === 'Cache-Status') {
      const c = parseCacheStatus(get(map, 'cache-status'));
      const fwd = c.members.find((m) => m.fwd)?.fwd;
      cdn = { name: '標準キャッシュ', standard: true, hit: c.hit, status: c.hit ? 'hit' : (fwd ? `fwd=${fwd}` : 'miss'), members: c.members };
      if (c.hit) origin = { state: 'network' };
      else { origin = { state: 'server' }; server = { kind: classifyServer(map, { cdnPresent: true }) }; }
    } else {
      // 既知CDNなし。中継キャッシュ(generic) か、サーバー直か、不明か。
      const age = parseAge(map) ?? 0;
      const originProxy = ORIGIN_PROXY_HEADERS.some((h) => has(map, h));
      if (which === 'generic' && !originProxy && age > 0) {
        origin = { state: 'network' };
        cdn = { name: null, generic: true, hit: true };
      } else if (hasResponse) {
        origin = { state: 'server' };
        server = { kind: classifyServer(map, { cdnPresent: false }) };
      } else if (!hasAnySignal) {
        origin = { state: 'unknown' };
      } else {
        origin = { state: 'unknown' };
      }
    }
  }

  // ブラウザキャッシュは private 文脈の鮮度を、それ以外は共有文脈の鮮度を採用する。
  const fr = origin?.state === 'browser' ? frPrivate : frShared;
  const revalidation = origin?.state === 'browser' && origin.revalidated ? revalidationTarget(map, ip) : null;
  return {
    origin: origin || { state: 'unknown' },
    server,
    cdn,
    revalidation,
    freshness: fr,
    speed,
    vary,
    raw: { statusCode, ip, fromCache, deliveryType, responseStatus, transferSize, encodedBodySize, serverTiming, headers },
  };
}
