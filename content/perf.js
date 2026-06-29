// コンテンツスクリプト。主ドキュメントの Navigation Timing を読み、出どころ補完情報を
// Service Worker へ送る。webRequest が発火しないメモリキャッシュを deliveryType で補う。
// host 権限が付与された後に chrome.scripting で動的登録される（静的宣言しない＝オプトイン）。
(() => {
  const CSS_LIMIT = 24;

  function collect() {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav) return null;
    const ttfb = nav.responseStart && nav.requestStart ? Math.max(0, nav.responseStart - nav.requestStart) : null;
    let deliveryType = nav.deliveryType || '';
    // メモリ/ディスクキャッシュの補完: 転送量0かつ本体ありはキャッシュ由来とみなす
    if (deliveryType !== 'cache' && nav.transferSize === 0 && nav.encodedBodySize > 0) {
      deliveryType = 'cache';
    }
    return {
      deliveryType: deliveryType || null,
      responseStatus: nav.responseStatus ?? null,
      ttfbMs: ttfb,
      transferSize: nav.transferSize ?? null,
      encodedBodySize: nav.encodedBodySize ?? null,
      serverTiming: (nav.serverTiming || []).map((s) => ({ name: s.name, dur: s.duration, desc: s.description })),
    };
  }

  function normalizedUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    try {
      const u = new URL(url, document.baseURI);
      u.hash = '';
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function sameOrigin(url) {
    try {
      return new URL(url).origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function collectStylesheets() {
    const urls = new Map();
    const add = (url) => {
      const href = normalizedUrl(url);
      if (href && sameOrigin(href) && !urls.has(href)) urls.set(href, { url: href, order: urls.size });
    };

    document.querySelectorAll('link[rel~="stylesheet"][href], link[rel~="preload"][as="style"][href]').forEach((link) => add(link.href));
    for (const sheet of document.styleSheets || []) add(sheet.href);

    const perfByUrl = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
      const href = normalizedUrl(entry.name);
      if (href) perfByUrl.set(href, entry);
    }

    return [...urls.values()].slice(0, CSS_LIMIT).map((item) => {
      const perf = perfByUrl.get(item.url);
      return {
        ...item,
        transferSize: perf?.transferSize ?? null,
        encodedBodySize: perf?.encodedBodySize ?? null,
        responseStatus: perf?.responseStatus ?? null,
      };
    });
  }

  function send() {
    const data = collect();
    if (!data) return;
    try {
      chrome.runtime.sendMessage({ type: 'cc-perf', data });
    } catch (_) {
      /* SW 停止中などは無視（次回再送される） */
    }
  }

  function sendStylesheets() {
    const stylesheets = collectStylesheets();
    if (!stylesheets.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'cc-css', stylesheets });
    } catch (_) {
      /* SW 停止中などは無視（次回再送される） */
    }
  }

  function sendAll() {
    send();
    sendStylesheets();
    setTimeout(sendStylesheets, 1000);
  }

  if (document.readyState === 'complete') sendAll();
  else window.addEventListener('load', () => setTimeout(sendAll, 0), { once: true });
})();
