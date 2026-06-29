// cache-cache の取得層（Service Worker, MV3）。
// 役割: webRequest で主ドキュメントのヘッダー＋fromCache と同一オリジンCSSの要約を観測し、
// タブ単位で chrome.storage.session に保存。バッジ更新。host 権限付与後に perf.js を動的登録。
// SW は頻繁に停止するため、状態はグローバル変数に持たず storage.session に置く。
import { classify } from './lib/classify.js';
import { present } from './lib/present.js';
import { recordToInput } from './lib/record.js';

const key = (tabId) => `tab_${tabId}`;
const CSS_LIMIT = 8;
const HISTORY_LIMIT = 2;

// ---- サイドパネルを開く（default_popup を置かないので onClicked が発火する） ----
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.error('sidePanel.open に失敗:', e);
  }
});

// ---- 主ドキュメントの観測（リスナはトップレベルで同期登録） ----
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame' && details.tabId >= 0) resetTab(details.tabId, details.url);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.webRequest.onCompleted.addListener(
  handleCompleted,
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders', 'extraHeaders'],
);

chrome.webRequest.onCompleted.addListener(
  handleStylesheetCompleted,
  { urls: ['<all_urls>'], types: ['stylesheet', 'other'] },
  ['responseHeaders', 'extraHeaders'],
);

async function handleCompleted(details) {
  if (details.tabId < 0) return;
  const record = {
    url: details.url,
    statusCode: details.statusCode ?? null,
    ip: details.ip || '',
    fromCache: !!details.fromCache,
    headers: (details.responseHeaders || []).map((h) => ({ name: h.name, value: h.value ?? '' })),
    receiveTime: details.timeStamp || Date.now(),
  };
  await mergeTab(details.tabId, record);
  await refreshBadge(details.tabId);
}

async function handleStylesheetCompleted(details) {
  if (details.tabId < 0) return;
  if (!isStylesheetResponse(details)) return;
  await updateTab(details.tabId, (cur) => {
    const pageUrl = cur.url || cur.pendingUrl;
    if (!isSameOrigin(details.url, pageUrl)) return cur;
    const entry = stylesheetEntry(details);
    return { ...cur, stylesheets: mergeStylesheet(cur.stylesheets || [], entry) };
  });
}

// ---- コンテンツスクリプト(perf.js)からの補完情報 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'cc-perf' && sender.tab?.id != null) {
        await mergeTab(sender.tab.id, { perf: msg.data });
        await refreshBadge(sender.tab.id);
        sendResponse?.({ ok: true });
      } else if (msg?.type === 'cc-css' && sender.tab?.id != null) {
        await mergeStylesheetHints(sender.tab.id, msg.stylesheets || [], sender.tab.url);
        sendResponse?.({ ok: true });
      } else if (msg?.type === 'cc-toggle-debug' && typeof msg.tabId === 'number') {
        await setDebugRule(msg.tabId, !!msg.on);
        sendResponse?.({ ok: true });
      } else {
        sendResponse?.({ ok: false });
      }
    } catch (e) {
      console.error(e);
      sendResponse?.({ ok: false, error: String(e) });
    }
  })();
  return true; // 非同期応答のためチャンネルを開いたままにする
});

// ---- タブ掃除・切替 ----
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId)).catch(() => {});
  setDebugRule(tabId, false).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => refreshBadge(tabId));

// ---- storage.session ヘルパ ----
async function getTab(tabId) {
  const o = await chrome.storage.session.get(key(tabId));
  return o[key(tabId)] || null;
}
// 同一タブへの更新を直列化し、read-modify-write の競合（lost update）を防ぐ。
// これは永続「状態」ではなく一時的な並行制御で、SW 再起動で消えても害はない。
const writeChains = new Map();
function updateTab(tabId, updater) {
  const prev = writeChains.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const cur = (await getTab(tabId)) || {};
    await chrome.storage.session.set({ [key(tabId)]: updater(cur) });
  });
  writeChains.set(tabId, next);
  next.finally(() => { if (writeChains.get(tabId) === next) writeChains.delete(tabId); });
  return next;
}
function mergeTab(tabId, patch) {
  return updateTab(tabId, (cur) => ({ ...cur, ...patch }));
}
async function resetTab(tabId, pendingUrl) {
  const cur = await getTab(tabId);
  const curUrl = cur?.url || cur?.pendingUrl || '';
  const history = sameComparableUrl(pendingUrl, curUrl) ? pushHistory(cur?.history || [], cur, pendingUrl) : [];
  writeChains.delete(tabId); // 新ナビゲーション開始時は旧更新チェーンの参照を断つ
  const next = chrome.storage.session.set({ [key(tabId)]: { pendingUrl, stylesheets: [], history } });
  writeChains.set(tabId, next);
  next.finally(() => { if (writeChains.get(tabId) === next) writeChains.delete(tabId); });
  await next.catch(() => {});
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (_) {}
}

function hasCompletedMainRecord(rec) {
  if (!rec?.url) return false;
  return rec.statusCode != null || Array.isArray(rec.headers) || rec.perf != null;
}

function clonePerf(perf) {
  if (!perf) return undefined;
  return {
    ...perf,
    serverTiming: Array.isArray(perf.serverTiming) ? perf.serverTiming.map((s) => ({ ...s })) : perf.serverTiming,
  };
}

function historyEntry(rec) {
  return {
    url: rec.url || '',
    statusCode: rec.statusCode ?? null,
    ip: rec.ip || '',
    fromCache: !!rec.fromCache,
    headers: (rec.headers || []).map((h) => ({ name: h.name, value: h.value ?? '' })),
    receiveTime: rec.receiveTime || Date.now(),
    perf: clonePerf(rec.perf) ?? null,
    stylesheets: (rec.stylesheets || []).map((item) => ({ ...item })),
  };
}

function comparableUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch (_) {
    return url || '';
  }
}

function sameComparableUrl(a, b) {
  return !!a && !!b && comparableUrl(a) === comparableUrl(b);
}

function pushHistory(history, rec, targetUrl = rec?.url || rec?.pendingUrl || '') {
  const existing = Array.isArray(history)
    ? history.filter((item) => sameComparableUrl(item?.url, targetUrl))
    : [];
  if (!hasCompletedMainRecord(rec)) return existing.slice(0, HISTORY_LIMIT);
  let entry;
  try {
    entry = historyEntry(rec);
  } catch (_) {
    return existing.slice(0, HISTORY_LIMIT);
  }
  return [
    entry,
    ...existing.filter((item) => Math.abs((item.receiveTime || 0) - entry.receiveTime) > 1000),
  ].slice(0, HISTORY_LIMIT);
}

function isSameOrigin(url, baseUrl) {
  if (!url || !baseUrl) return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch (_) {
    return false;
  }
}

function stylesheetPath(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search || ''}`;
  } catch (_) {
    return url || '';
  }
}

function responseHeader(details, name) {
  const key = String(name).toLowerCase();
  const found = (details.responseHeaders || []).find((h) => h.name?.toLowerCase() === key);
  return found?.value || '';
}

function isCssLikeUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.css');
  } catch (_) {
    return false;
  }
}

function isStylesheetResponse(details) {
  if (details.type === 'stylesheet') return true;
  const contentType = responseHeader(details, 'content-type').toLowerCase();
  return contentType.includes('text/css') || isCssLikeUrl(details.url);
}

function stylesheetEntry(details) {
  const rec = {
    headers: (details.responseHeaders || []).map((h) => ({ name: h.name, value: h.value ?? '' })),
    statusCode: details.statusCode ?? null,
    ip: details.ip || '',
    fromCache: !!details.fromCache,
    receiveTime: details.timeStamp || Date.now(),
  };
  const verdict = classify(recordToInput(rec));
  const view = present(verdict);
  return {
    path: stylesheetPath(details.url),
    statusCode: rec.statusCode,
    fromCache: rec.fromCache,
    state: verdict.origin?.state || 'unknown',
    revalidated: verdict.origin?.revalidated ?? null,
    cdn: verdict.cdn?.name || '',
    freshness: view.l1?.freshness || '',
    receiveTime: rec.receiveTime,
    observed: true,
    seenInDom: false,
  };
}

function stylesheetHintEntry(hint) {
  const transferSize = hint.transferSize ?? null;
  const encodedBodySize = hint.encodedBodySize ?? null;
  const responseStatus = hint.responseStatus ?? null;
  const revalidated = responseStatus === 304 || transferSize === 300;
  const fromCache = transferSize === 0 && encodedBodySize > 0;
  return {
    path: stylesheetPath(hint.url),
    statusCode: responseStatus,
    fromCache,
    state: fromCache || revalidated ? 'browser' : 'unknown',
    revalidated: revalidated || null,
    cdn: '',
    freshness: '',
    receiveTime: Date.now(),
    observed: false,
    seenInDom: true,
    order: hint.order ?? null,
    transferSize,
    encodedBodySize,
  };
}

function mergeStylesheetEntry(prev, next) {
  if (!prev) return next;
  const preferNextDetail = next.observed || !prev.observed;
  return {
    path: next.path || prev.path,
    statusCode: preferNextDetail ? next.statusCode : prev.statusCode,
    fromCache: preferNextDetail ? next.fromCache : prev.fromCache,
    state: preferNextDetail ? next.state : prev.state,
    revalidated: preferNextDetail ? next.revalidated : prev.revalidated,
    cdn: preferNextDetail ? next.cdn : prev.cdn,
    freshness: preferNextDetail ? next.freshness : prev.freshness,
    receiveTime: Math.max(prev.receiveTime || 0, next.receiveTime || 0),
    observed: prev.observed || next.observed,
    seenInDom: prev.seenInDom || next.seenInDom,
    order: next.order ?? prev.order ?? null,
    transferSize: next.transferSize ?? prev.transferSize ?? null,
    encodedBodySize: next.encodedBodySize ?? prev.encodedBodySize ?? null,
  };
}

function mergeStylesheet(list, entry) {
  const existing = list.find((item) => item.path === entry.path);
  const deduped = list.filter((item) => item.path !== entry.path);
  const merged = mergeStylesheetEntry(existing, entry);
  return [...deduped, merged]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || (a.receiveTime || 0) - (b.receiveTime || 0))
    .slice(-CSS_LIMIT);
}

async function mergeStylesheetHints(tabId, hints, fallbackPageUrl) {
  if (!Array.isArray(hints) || !hints.length) return;
  await updateTab(tabId, (cur) => {
    const pageUrl = cur.url || cur.pendingUrl || fallbackPageUrl;
    let stylesheets = cur.stylesheets || [];
    for (const hint of hints) {
      if (!hint?.url || !isSameOrigin(hint.url, pageUrl)) continue;
      stylesheets = mergeStylesheet(stylesheets, stylesheetHintEntry(hint));
    }
    return { ...cur, stylesheets };
  });
}

// ---- バッジ更新（タブ単位） ----
async function refreshBadge(tabId) {
  const rec = await getTab(tabId);
  if (!rec) return;
  let badge;
  try {
    badge = present(classify(recordToInput(rec))).badge;
  } catch (e) {
    return;
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: badge.textColor || '#FFFFFF' });
  } catch (_) {
    /* タブが既に閉じている等は無視 */
  }
}

// ---- host 権限の付与状況に応じて perf.js を動的登録/解除 ----
const PERF_SCRIPT_ID = 'cc-perf';

async function getGrantedHostMatches() {
  const perms = await chrome.permissions.getAll();
  const origins = perms.origins || [];
  if (origins.includes('<all_urls>')) return ['<all_urls>'];
  return origins.filter((origin) => /^https?:\/\//.test(origin));
}

function sameMatches(a, b) {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.every((v, i) => v === bb[i]);
}

async function syncContentScript() {
  let matches = [];
  try {
    matches = await getGrantedHostMatches();
  } catch (_) {
    return;
  }
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PERF_SCRIPT_ID] });
  } catch (_) {}
  const currentMatches = existing[0]?.matches || [];
  const isRegistered = existing.length > 0;
  try {
    if (!matches.length && isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [PERF_SCRIPT_ID] });
      return;
    }
    if (isRegistered && !sameMatches(currentMatches, matches)) {
      await chrome.scripting.unregisterContentScripts({ ids: [PERF_SCRIPT_ID] });
    }
    if (matches.length && (!isRegistered || !sameMatches(currentMatches, matches))) {
      await chrome.scripting.registerContentScripts([
        {
          id: PERF_SCRIPT_ID,
          js: ['content/perf.js'],
          matches,
          runAt: 'document_end',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    }
  } catch (e) {
    console.warn('content script の同期に失敗:', e);
  }
}
chrome.runtime.onInstalled.addListener(syncContentScript);
chrome.runtime.onStartup.addListener(syncContentScript);
chrome.permissions.onAdded.addListener(syncContentScript);
chrome.permissions.onRemoved.addListener(syncContentScript);

// ---- Fastly-Debug 注入（上級者向け・対象タブ限定の session ルール） ----
async function setDebugRule(tabId, on) {
  const addRules = on
    ? [
        {
          id: tabId, // タブIDをそのままルールIDに（一意・正の整数）
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Fastly-Debug', operation: 'set', value: '1' }],
          },
          condition: { tabIds: [tabId], resourceTypes: ['main_frame'] },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId], addRules });
}
