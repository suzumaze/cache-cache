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

// ---- Fastly-Debug 有効時だけ返るヘッダー ----
// 書式は公式に明記が無いため、実測（2026-07-17・Fastly配下の実サイト）と算術の一致から読み取ったもの。
// 読めない形なら黙って null を返し、当て推量の値を作らない（原則3）。

/** `-`（値なし）と数値が混在する欄。`-` は「Fastly が値を出していない」であって 0 ではない。 */
function dashNum(s) {
  if (s == null || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `fastly-debug-ttl: (H cache-nrt-x-NRT 31510596.616 86400.000 25403)`
 * `fastly-debug-ttl: (M cache-nrt-x-NRT - - 341)` ← TTL/grace が出ない形もある
 * → { state:'H'|'M'|…, node, ttlRemainingSec, graceSec, ageSec }
 *
 * graceSec の公式名は stale-if-error TTL（バックエンド障害時に stale を配ってよい残り時間。
 * Fastly は stale-if-error を obj.grace に写すため、機構上は grace と同じもの）。
 * 実測 86400 は同一応答の Surrogate-Control: stale-if-error=86400 と一致。
 *
 * 2番目が残りTTLであることは、同一応答の `Surrogate-Control: max-age` から age を引いた値と
 * 5件で一致することで確認した（31536000 − 25403 = 31510597 ≒ 31510596.616）。
 * 先頭文字の公式定義は H=hit / M=miss の2値のみで、生成VCL上は obj.hits>0 の二値
 * （＝x-cache-hits と同源。実測10件で「配信段の hits>0 ⇔ H」が完全一致）。パージで hits が
 * 0 に戻った古い控えの配信では x-cache: HIT のまま M になるが、それは hits の写しであって
 * stale の直接申告ではない。単独では x-cache-hits 以上の情報を持たない（board.md 2026-07-18）。
 * 未観測の文字が来ても解釈せず、そのまま渡す。
 */
export function parseDebugTtl(value) {
  const m = String(value ?? '').match(/\(\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+?)\s*\)/);
  if (!m) return null;
  return {
    state: m[1],
    node: m[2],
    ttlRemainingSec: dashNum(m[3]),
    graceSec: dashNum(m[4]),
    ageSec: dashNum(m[5]),
  };
}

/**
 * `fastly-debug-path: (D cache-a-NRT 1784283913) (F cache-b-NRT 1784258510)`
 * → { deliveryNode, deliveryAtMs, fetchNode, fetchedAtMs }
 * D=配信、F=取得。F の時刻は控えが作られた時刻で、`受信時刻 − Age` と独立に一致する
 * （実測: D 1784283913 − F 1784258510 = 25403 = Age）。
 */
export function parseDebugPath(value) {
  const out = { deliveryNode: null, deliveryAtMs: null, fetchNode: null, fetchedAtMs: null };
  let found = false;
  for (const m of String(value ?? '').matchAll(/\(\s*([DF])\s+(\S+)\s+(\d+)\s*\)/g)) {
    found = true;
    const at = Number(m[3]) * 1000;
    if (m[1] === 'D') { out.deliveryNode = m[2]; out.deliveryAtMs = at; }
    else { out.fetchNode = m[2]; out.fetchedAtMs = at; }
  }
  return found ? out : null;
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
