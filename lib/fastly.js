// Fastly のヘッダー解析。POP（拠点）単位の段構成、HIT/MISS、サーバー取得時間を読む。
// X-Served-By は利用者寄り→サーバー寄りの順にノードが並び、X-Cache も同じ並びで各ノードの
// HIT/MISS を表す。ただし「ノード数＝段数」ではない点が要注意:
//   - 同一 POP の連続ノード（例 NRT, NRT）＝POP内クラスタリング（delivery→fetch）。地理的には1拠点で、
//     シールドではない。X-Cache "MISS, HIT" でも「東京の中で見つかった」に過ぎない。
//   - 異なる POP のノード（例 KIX, NRT）＝オリジンシールド（エッジ→別POPのシールド）。
// そこで POP コードで畳んで「段(tier)」を作り、異なる POP が2つ以上あるときだけシールドありと判定する。
import { get, splitList } from './headers.js';
import { popCity, popCodeOf } from './pop.js';

/** X-Timer "S....,VS0,VE3" の VE（サーバー取得にかかった時間の目安, ミリ秒）。 */
export function parseTimerVE(xtimer) {
  if (!xtimer) return null;
  const m = String(xtimer).match(/VE(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

export function parseFastly(map) {
  const chain = splitList(get(map, 'x-served-by')); // ノード列（利用者寄り→サーバー寄り）
  const states = splitList(get(map, 'x-cache')).map((s) => s.toUpperCase()); // 各ノードの HIT/MISS
  const hits = splitList(get(map, 'x-cache-hits')).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));

  // 命中したか。段構成に関係なく x-cache に1つでも HIT があれば命中とする（段数不一致にも耐える）。
  let servedIdx = states.findIndex((s) => s.includes('HIT'));
  if (servedIdx < 0 && hits.length) servedIdx = hits.findIndex((n) => n > 0);
  const hit = servedIdx >= 0;

  const codes = chain.map(popCodeOf); // 各ノードの POP コード（不明は null）

  // ノードを POP 単位の「段(tier)」に畳む。同一 POP の連続ノード（クラスタリング）は1段にまとめ、
  // その段の hit は「どれか1ノードでも HIT」とする。tiers.length は POP をまたぐ段だけを数える。
  const tiers = [];
  chain.forEach((_, i) => {
    const code = codes[i] || null;
    const nodeHit = (states[i] || '').includes('HIT') || hits[i] > 0;
    const last = tiers[tiers.length - 1];
    if (last && last.code && code && last.code === code) last.hit = last.hit || nodeHit;
    else tiers.push({ code, hit: nodeHit });
  });

  // 異なる既知 POP の数＝地理的な段数。2以上でシールド構成（エッジ→別POPのシールド）。
  const pops = new Set(codes.filter(Boolean)).size;

  const edgeCode = codes[0] || null; // 入口(エッジ)＝先頭ノードの POP
  // 命中した POP。命中ノードに対応する POP（無ければ既知の末尾 POP で代替）。
  const servedCode = (hit && codes[servedIdx]) || codes.filter(Boolean).slice(-1)[0] || null;

  // シールド由来＝命中 POP が入口 POP と「確かに」異なるとき。同一 POP 内(クラスタリング)や
  // 命中 POP 不明のときはシールドと断定しない（SPEC 原則3）。
  let servedAt = null;
  if (hit) servedAt = (servedCode && edgeCode && servedCode !== edgeCode) ? 'shield' : 'edge';

  // 命中した段のインデックス（tiers 上）。表示の「返ってきた場所」で使う。
  let servedTier = null;
  if (hit) {
    servedTier = servedAt === 'shield' ? tiers.findIndex((t) => t.code === servedCode) : 0;
    if (servedTier < 0) servedTier = Math.max(0, tiers.length - 1);
  }

  const pop = servedCode ? { code: servedCode, city: popCity(servedCode) } : null;
  const edgePop = edgeCode ? { code: edgeCode, city: popCity(edgeCode) } : null;

  return {
    hit,
    servedAt,
    servedTier,
    pops,
    tiers,
    pop,
    edgePop,
    hits,
    chain,
    states,
    serverMs: parseTimerVE(get(map, 'x-timer')),
  };
}
