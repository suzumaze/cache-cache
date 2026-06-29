// サーバー（オリジン）に到達した場合の内訳分類。
// 'server-cache' = サーバー側が用意していた控えに命中 / 'fresh' = その場で生成（作りたて）/
// 'unknown' = 手がかりが無く見分けられない（正直に不明）。
import { get, has, parseAge, ccHas } from './headers.js';

export function classifyServer(map, ctx = {}) {
  const cdnPresent = !!ctx.cdnPresent;
  const cc = get(map, 'cache-control') || '';
  const age = parseAge(map);
  const xcache = get(map, 'x-cache') || '';

  // ① サーバー側キャッシュ命中の手がかり
  if (has(map, 'x-varnish') && (age ?? 0) > 0) return 'server-cache';
  if (/hit/i.test(get(map, 'x-drupal-cache') || '')) return 'server-cache';
  if (/hit/i.test(get(map, 'x-litespeed-cache') || '')) return 'server-cache';
  if (/hit/i.test(get(map, 'x-proxy-cache') || '')) return 'server-cache';
  if (/hit/i.test(get(map, 'x-fastcgi-cache') || '')) return 'server-cache';
  if (/hit/i.test(get(map, 'x-nginx-cache') || '')) return 'server-cache';
  if (!cdnPresent && /\bhit\b/i.test(xcache)) return 'server-cache';
  if (!cdnPresent && (age ?? 0) > 0) return 'server-cache';

  // ② 作りたて（毎回生成）の手がかり
  if ((age == null || age === 0) && (ccHas(cc, 'no-store') || ccHas(cc, 'no-cache') || ccHas(cc, 'private'))) return 'fresh';
  if (/miss/i.test(get(map, 'x-drupal-cache') || '')) return 'fresh';
  if (/miss/i.test(get(map, 'x-proxy-cache') || '')) return 'fresh';
  if (/miss/i.test(get(map, 'x-fastcgi-cache') || '')) return 'fresh';

  // ③ 見分けられない
  return 'unknown';
}
