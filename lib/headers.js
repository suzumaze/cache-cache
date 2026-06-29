// HTTP レスポンスヘッダーの正規化と、共通の小さなパーサ群。
// webRequest の responseHeaders は [{name, value}] の配列で、ヘッダー名の
// 大文字小文字が一定しない。小文字キーの Map に正規化し、同名は ", " で結合する。

/** @param {{name:string,value?:string}[]} list */
export function toHeaderMap(list) {
  const map = new Map();
  for (const h of list || []) {
    if (!h || !h.name) continue;
    const key = String(h.name).toLowerCase();
    const val = h.value == null ? '' : String(h.value);
    map.set(key, map.has(key) ? `${map.get(key)}, ${val}` : val);
  }
  return map;
}

export function get(map, name) {
  return map.get(String(name).toLowerCase()) ?? null;
}

export function has(map, name) {
  return map.has(String(name).toLowerCase());
}

export function keys(map) {
  return [...map.keys()];
}

/** "MISS, HIT" → ["MISS","HIT"] */
export function splitList(str) {
  return String(str ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Age ヘッダー（秒）。無ければ null。 */
export function parseAge(map) {
  const v = get(map, 'age');
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/** HTTP-date 文字列 → epoch ミリ秒。失敗時 null。 */
export function parseHttpDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Cache-Control 等から `name=数値` を取り出す（s-maxage と max-age は別物として扱える）。 */
export function ccNum(value, name) {
  const m = String(value ?? '').match(new RegExp(`${name}\\s*=\\s*"?(\\d+)`, 'i'));
  return m ? parseInt(m[1], 10) : null;
}

/** `no-store` のような単独トークンの有無。修飾付き（no-cache="field" 等, RFC 9111）も検出する。 */
export function ccHas(value, token) {
  return new RegExp(`(?:^|[\\s,])${token}(?:[\\s,;=]|$)`, 'i').test(String(value ?? ''));
}
