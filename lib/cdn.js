// レスポンスヘッダーから CDN（ネットワーク上の共有キャッシュ提供者）を識別する。
// 戻り値: 'Fastly' | 'Cloudflare' | 'CloudFront' | 'Akamai' | 'Cache-Status' | 'generic' | null
// 'generic' = 既知CDNではないが Via があり中継キャッシュの可能性がある。
// null = 中継の痕跡なし（＝サーバー直か、出どころ不明）。
import { get, has, keys } from './headers.js';

export function detectCdn(map) {
  const xsb = get(map, 'x-served-by') || '';
  const via = (get(map, 'via') || '').toLowerCase();
  const server = (get(map, 'server') || '').toLowerCase();
  const xcache = get(map, 'x-cache') || '';
  const allKeys = keys(map).join(' ');

  // Fastly: x-served-by の "cache-<pop>-<node>" 形式 / x-timer / (Via varnish ＋ x-served-by)
  if ((xsb && /cache-[a-z0-9]+/i.test(xsb)) || has(map, 'x-timer') || (/\bvarnish\b/.test(via) && has(map, 'x-served-by'))) {
    return 'Fastly';
  }
  // Cloudflare
  if (server.includes('cloudflare') || has(map, 'cf-ray') || has(map, 'cf-cache-status')) {
    return 'Cloudflare';
  }
  // CloudFront
  if (via.includes('cloudfront') || has(map, 'x-amz-cf-id') || has(map, 'x-amz-cf-pop')) {
    return 'CloudFront';
  }
  // Akamai
  if (/akamaighost/i.test(server) || /akamai/i.test(xcache) || /\bx-akamai/i.test(allKeys) || /tcp_(hit|miss|mem_hit|refresh_hit|ims_hit)/i.test(xcache)) {
    return 'Akamai';
  }
  // RFC 9211 標準
  if (has(map, 'cache-status')) return 'Cache-Status';
  // 汎用の中継（Via があるが提供者は不明）
  if (via) return 'generic';
  return null;
}
