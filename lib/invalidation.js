// 無効化（パージ）の形跡の検出。同じURLの複数記録（新しい順）を突き合わせる。Fastly のみ。
//
// 根拠（board.md 2026-07-17 / 2026-07-18 の対照実験）:
//   - ソフトパージ後も古い控えが stale-while-revalidate で配られ、応答は x-cache: HIT のまま
//   - そのとき配信段の x-cache-hits が 0 に戻る／後退する（7→0 や 6→1 を実測）
//   - 通常の初回命中は 1 から始まる（実測で反例なし）。カウンタは単調増加のはずなので、
//     同じ控え・同じノードでの後退は無効化の直後にだけ観測されている
// fastly-debug-ttl の先頭文字(H/M)は obj.hits>0 の二値で x-cache-hits と同源のため使わない。
// ここは引き算だけで判定し、表示側は「形跡」止まりにする（原則3: パージ以外で hits が
// 戻る反例を網羅できていないため、断定しない）。
import { toHeaderMap, get, parseAge, parseHttpDate, splitList } from './headers.js';
import { detectCdn } from './cdn.js';

// Age は秒精度なので、誕生時刻（受信時刻−Age）はこの幅で一致すれば同じ控えとみなす
// （lib/export.js の SAME_OBJECT_TOLERANCE_SEC と同じ理由・同じ値）。
const SAME_OBJECT_TOLERANCE_MS = 2000;

function facts(rec) {
  const map = toHeaderMap(rec?.headers || []);
  const ageSec = parseAge(map);
  const receiveTime = rec?.receiveTime ?? null;
  const states = splitList(get(map, 'x-cache')).map((s) => s.toUpperCase());
  const hits = splitList(get(map, 'x-cache-hits')).map((n) => parseInt(n, 10));
  const servedIdx = states.findIndex((s) => s.includes('HIT'));
  const bornAtMs = ageSec != null && receiveTime != null ? receiveTime - ageSec * 1000 : null;
  const lastModifiedMs = parseHttpDate(get(map, 'last-modified'));
  return {
    fastly: detectCdn(map) === 'Fastly',
    hit: servedIdx >= 0,
    servedHits: servedIdx >= 0 && Number.isFinite(hits[servedIdx]) ? hits[servedIdx] : null,
    ageSec,
    bornAtMs,
    // Age がオリジン側キャッシュの世代起点で連鎖しているか（bornAt ≒ last-modified）。
    // このとき bornAt は「CDNの控え」ではなく「コンテンツの世代」を指し、CDNの控えが自然満了で
    // 同じ世代を取り直しても bornAt が一致したまま hits がリセットされる＝後退がパージの証拠に
    // ならない（board.md 2026-07-21・実サイトの本番側で実測）。
    originAnchored: bornAtMs != null && lastModifiedMs != null
      && Math.abs(bornAtMs - lastModifiedMs) <= SAME_OBJECT_TOLERANCE_MS,
    nodes: get(map, 'x-served-by') || '',
  };
}

function sameObject(a, b) {
  return a.bornAtMs != null && b.bornAtMs != null
    && Math.abs(a.bornAtMs - b.bornAtMs) <= SAME_OBJECT_TOLERANCE_MS;
}

/**
 * @param {object[]} records 同じURLの記録（新しい順。sidepanel の tabRecords と同じ並び）
 * @returns {{invalidated:boolean, replacedLater:boolean}[]} records と同じ並び
 */
export function detectInvalidation(records) {
  const f = (records || []).map(facts);
  return f.map((cur, i) => {
    let invalidated = false;
    if (cur.fastly && cur.hit && cur.servedHits != null) {
      // 単独の形跡: 古い控え(Age>0)が命中として配られているのに、命中回数が 0。
      // 通常の初回命中は 1 から始まるため、正常系では作れない組み合わせ。
      if (cur.servedHits === 0 && cur.ageSec > 0) invalidated = true;
      // 2記録の形跡: 同じ控え・同じノードのまま命中回数が後退（例 7→0, 6→1）。
      // 後退先は 0 とは限らない（6→1 を実測）ので、単独の形跡だけでは取りこぼす。
      // ただし Age がオリジン錨（originAnchored）の記録が混ざるときは bornAt で CDN の控えを
      // 識別できず、自然満了の取り直しでも後退して見えるため、比較不成立として黙る（原則3）。
      const prev = f[i + 1]; // 1つ古い記録
      if (
        prev && prev.fastly && prev.hit && prev.servedHits != null
        && !cur.originAnchored && !prev.originAnchored
        && sameObject(cur, prev)
        && cur.nodes && cur.nodes === prev.nodes
        && cur.servedHits < prev.servedHits
      ) invalidated = true;
    }
    // この記録のあと、別の控えに切り替わったか（表示の時制に使う）
    const newer = f[i - 1];
    const replacedLater = !!(invalidated && newer && cur.bornAtMs != null && newer.bornAtMs != null
      && !sameObject(cur, newer));
    return { invalidated, replacedLater };
  });
}
