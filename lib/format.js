// やさしい日本語の時間・速度・日付フォーマッタ。すべて null 安全。

/** 残り時間など「約X」表現。 */
export function formatDurationJa(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `約${s}秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `約${m}分`;
  const h = Math.round(s / 3600);
  if (h < 24) return `約${h}時間`;
  const d = Math.round(s / 86400);
  return `約${d}日`;
}

/** 経過時間「X前」表現。1秒未満は「たった今」。 */
export function formatAgoJa(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.round(sec));
  if (s < 1) return 'たった今';
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(s / 86400);
  return `${d}日前`;
}

/** ミリ秒 → 速さ表現。 */
export function formatMsJa(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1) return 'ほぼ一瞬';
  const r = Math.round(ms);
  if (r < 1000) return `約${r}ミリ秒`;
  const sec = ms / 1000;
  return `約${sec < 10 ? sec.toFixed(1) : Math.round(sec)}秒`;
}

/** Date → "2026年6月19日 14:30"（ローカル時刻）。 */
export function formatDateTimeJa(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${p(date.getHours())}:${p(date.getMinutes())}`;
}
