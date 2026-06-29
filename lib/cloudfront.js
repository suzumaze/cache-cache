// Amazon CloudFront のヘッダー解析。X-Cache "Hit/Miss from cloudfront"、X-Amz-Cf-Pop で POP。
import { get } from './headers.js';
import { popCity } from './pop.js';

export function parseCloudFront(map) {
  const xcache = get(map, 'x-cache') || '';
  const hit = /cloudfront/i.test(xcache) && /(?:^|\b)(hit|refreshhit)\b/i.test(xcache);
  // X-Amz-Cf-Pop: "NRT57-C1" → 先頭3文字が空港コード
  const code = (get(map, 'x-amz-cf-pop') || '').slice(0, 3).toUpperCase() || null;
  const pop = code && /^[A-Z]{3}$/.test(code) ? { code, city: popCity(code) } : null;
  return { hit, pop, xcache };
}
