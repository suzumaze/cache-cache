// Fastly のヘッダー解析。エッジ＋1つ以上のシールド、POP、HIT/MISS、サーバー取得時間を読む。
// X-Served-By は利用者寄り(エッジ)→サーバー寄り(シールド)の順。X-Cache も同じ並びで
// 各段の HIT/MISS を表す（例: "MISS, HIT" = エッジMISS・シールドHIT）。
import { get, splitList } from './headers.js';
import { popCity, popCodeOf } from './pop.js';

/** X-Timer "S....,VS0,VE3" の VE（サーバー取得にかかった時間の目安, ミリ秒）。 */
export function parseTimerVE(xtimer) {
  if (!xtimer) return null;
  const m = String(xtimer).match(/VE(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

export function parseFastly(map) {
  const chain = splitList(get(map, 'x-served-by')); // [edge, shield?]
  const states = splitList(get(map, 'x-cache')).map((s) => s.toUpperCase()); // [edge, shield?]
  const hits = splitList(get(map, 'x-cache-hits')).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  // 段数は x-served-by と x-cache の食い違いに備え両者の最大を採る（1=エッジのみ / 2=エッジ→シールド）
  const layers = Math.max(chain.length, states.length);

  // 命中位置は x-cache（HIT/MISS の並び＝[エッジ, シールド]）側で判定する（SPEC §5）
  let servedIdx = states.findIndex((s) => s.includes('HIT'));
  if (servedIdx < 0 && hits.length) servedIdx = hits.findIndex((n) => n > 0);
  const hit = servedIdx >= 0;

  let servedAt = null;
  if (hit) servedAt = layers >= 2 ? (servedIdx === 0 ? 'edge' : 'shield') : 'edge';

  // POP は命中セグメント優先。x-served-by が短く対応セグメントが無ければ末尾で代替
  const seg = chain[servedIdx] || chain[chain.length - 1] || '';
  const code = popCodeOf(seg);
  const pop = code ? { code, city: popCity(code) } : null;
  // 入口（エッジ＝利用者に最も近い段）の拠点。命中拠点と分けて提示するため別に持つ。
  const edgeCode = popCodeOf(chain[0]);
  const edgePop = edgeCode ? { code: edgeCode, city: popCity(edgeCode) } : null;

  return {
    hit,
    servedAt,
    servedIndex: hit ? servedIdx : null,
    pop,
    edgePop,
    hits,
    chain,
    layers,
    states,
    serverMs: parseTimerVE(get(map, 'x-timer')),
  };
}
