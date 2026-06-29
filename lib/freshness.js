// キャッシュの鮮度（あとどれくらい最新版に切り替わるか）を 4 モードで返す。
//  - 'no-store'  : 毎回新しく読み込む設定（控えを残さない）
//  - 'countdown' : 有効期限まで概ね24時間以内 → 残り時間を出す
//  - 'created'   : 有効期限が遠い / immutable → 作成日を出す
//  - 'unknown'   : 有効期限の情報が無い（非公開）→ 経過のみ
// freshness_lifetime = s-maxage > max-age > (Expires - Date)（RFC 9111）。
// current_age = Age + 受信後の経過。
import { get, parseAge, parseHttpDate, ccNum, ccHas, has } from './headers.js';

const DAY = 86400;

export function freshness(map, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const receiveTime = ctx.receiveTime ?? now;
  const shared = ctx.shared !== false; // 既定: 共有キャッシュ(CDN/プロキシ)。private(ブラウザ)は shared:false。
  const cc = get(map, 'cache-control') || '';
  const sc = get(map, 'surrogate-control') || '';

  const ageHeader = parseAge(map);
  const ageKnown = has(map, 'age');
  const elapsed = Math.max(0, (now - receiveTime) / 1000);
  const ageSec = (ageHeader ?? 0) + elapsed;

  if (ccHas(cc, 'no-store')) return { mode: 'no-store', ageSec, ageKnown };
  // no-cache は「毎回オリジンで再検証してから使う」指定（RFC 9111 §5.2.2）。
  // 有効な残り寿命を提示できないため不明扱いにする。
  if (ccHas(cc, 'no-cache')) return { mode: 'unknown', ageSec, ageKnown };

  const immutable = ccHas(cc, 'immutable');
  // lifetime と、それを決めた出所(lifetimeSource)。Surrogate-Control(max-age)・s-maxage は共有キャッシュ
  // (CDN/プロキシ)専用(RFC 9111)なので、private(ブラウザ)キャッシュ＝shared:false では使わず max-age >
  // Expires のみで判定する。共有キャッシュ＝既定は Surrogate-Control > s-maxage > max-age > Expires。
  let lifetime = null;
  let lifetimeSource = null;
  if (shared) {
    lifetime = ccNum(sc, 'max-age');
    if (lifetime != null) lifetimeSource = 'surrogate';
    if (lifetime == null) { lifetime = ccNum(cc, 's-maxage'); if (lifetime != null) lifetimeSource = 's-maxage'; }
  }
  if (lifetime == null) { lifetime = ccNum(cc, 'max-age'); if (lifetime != null) lifetimeSource = 'max-age'; }
  if (lifetime == null) {
    const exp = parseHttpDate(get(map, 'expires'));
    const dat = parseHttpDate(get(map, 'date'));
    if (exp != null && dat != null) { lifetime = Math.max(0, (exp - dat) / 1000); lifetimeSource = 'expires'; }
  }

  // 有効期限の手がかりが無い → 非公開
  if (lifetime == null && !immutable) {
    return { mode: 'unknown', ageSec, ageKnown };
  }
  if (immutable && lifetime == null) lifetime = Infinity;

  const remaining = lifetime - ageSec;
  const createdAt = (() => {
    const dat = parseHttpDate(get(map, 'date'));
    return dat != null ? new Date(dat) : null;
  })();

  if (lifetime === Infinity || immutable || remaining > DAY) {
    return {
      mode: 'created',
      createdAt,
      ageSec,
      ageKnown,
      remainingSec: Number.isFinite(remaining) ? remaining : null,
      lifetimeSec: Number.isFinite(lifetime) ? lifetime : null,
      lifetimeSource,
    };
  }
  return { mode: 'countdown', remainingSec: Math.max(0, remaining), lifetimeSec: lifetime, ageSec, ageKnown, lifetimeSource };
}
