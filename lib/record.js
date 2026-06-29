// storage.session に保存したタブ記録 → classify() への入力に変換する。
// Service Worker（バッジ用）とサイドパネル（表示用）の両方から使う唯一の変換口。
export function recordToInput(rec, now = Date.now()) {
  if (!rec) return { headers: [], statusCode: null, ip: '', fromCache: false, deliveryType: null, responseStatus: null, transferSize: null, encodedBodySize: null, ttfbMs: null, receiveTime: now, now };
  return {
    headers: rec.headers || [],
    statusCode: rec.statusCode ?? null,
    ip: rec.ip || '',
    fromCache: !!rec.fromCache,
    deliveryType: rec.perf?.deliveryType ?? null,
    responseStatus: rec.perf?.responseStatus ?? null,
    transferSize: rec.perf?.transferSize ?? null,
    encodedBodySize: rec.perf?.encodedBodySize ?? null,
    ttfbMs: rec.perf?.ttfbMs ?? null,
    serverTiming: rec.perf?.serverTiming ?? null,
    receiveTime: rec.receiveTime ?? now,
    now,
  };
}
