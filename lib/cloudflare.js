// Cloudflare のヘッダー解析。cf-cache-status で命中判定、cf-ray 末尾で POP を読む。
import { get } from './headers.js';
import { popCity } from './pop.js';

// 控えから配ったとみなす状態。UPDATING は stale-while-revalidate で古い控えを配るため命中扱い（SPEC §5 に記載）。
const HIT_STATES = new Set(['HIT', 'STALE', 'REVALIDATED', 'UPDATING']);

export function parseCloudflare(map) {
  const status = (get(map, 'cf-cache-status') || '').toUpperCase();
  const hit = HIT_STATES.has(status);
  // cf-ray: "8a1b2c3d4e5f6a7b-NRT"
  const code = (get(map, 'cf-ray') || '').split('-')[1]?.toUpperCase() || null;
  const pop = code ? { code, city: popCity(code) } : null;
  return { hit, status, pop };
}
