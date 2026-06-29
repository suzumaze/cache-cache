// Akamai のヘッダー解析。X-Cache の TCP_* トークンで命中判定（POP は標準化されておらず省略）。
import { get } from './headers.js';

export function parseAkamai(map) {
  const xcache = (get(map, 'x-cache') || '').toUpperCase();
  const hit = /TCP_(HIT|MEM_HIT|REFRESH_HIT|IMS_HIT)/.test(xcache);
  return { hit, xcache: get(map, 'x-cache') || null };
}
