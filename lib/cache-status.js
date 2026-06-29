// RFC 9211 `Cache-Status` 標準ヘッダーのパーサ。
// 例: `Cache-Status: ExampleCache; hit; ttl=376`
//     `Cache-Status: "CDN"; hit, ExampleCache; fwd=uri-miss; collapsed; ttl=0`
// 各メンバー（カンマ区切り）が 1 つのキャッシュを表し、`hit` パラメータがあれば命中、
// `fwd` があれば転送（ミス）。1 つでも hit があれば hit とみなす。

/** トップレベルのカンマで分割（ダブルクオート内のカンマは無視）。 */
function splitTopLevel(str) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (const ch of str) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** @param {string|null} value Cache-Status ヘッダー値 */
export function parseCacheStatus(value) {
  if (!value) return { present: false, hit: false, members: [] };
  const members = splitTopLevel(value).map((raw) => {
    const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
    const nameRaw = parts.shift() || '';
    const name = nameRaw.replace(/^"|"$/g, '');
    const params = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq >= 0) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
      else params[p.toLowerCase()] = true;
    }
    return {
      name,
      hit: 'hit' in params,
      fwd: params.fwd ?? null,
      ttl: params.ttl != null ? Number(params.ttl) : null,
      stored: 'stored' in params,
      collapsed: 'collapsed' in params,
    };
  });
  return { present: true, hit: members.some((m) => m.hit), members };
}
