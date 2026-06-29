// サイドパネルの表示ロジック。lib/ の判定エンジンを Service Worker と共有する。
// アクティブタブの記録を storage.session から読み、L1/L2/L3 を描画。1秒ごとに鮮度を更新。
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';
import { recordToInput } from '../lib/record.js';

// 保存済みのテーマ選択を最優先で適用（チラ見え最小化）。未保存なら OS 設定に追従。
try {
  const savedTheme = localStorage.getItem('cc-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch (_) {
  /* localStorage が使えなければ OS 追従のまま */
}

const $ = (id) => document.getElementById(id);
const els = {
  permission: $('permission'),
  empty: $('empty'),
  loading: $('loading'),
  card: $('card'),
  tabCurrent: $('tab-current'),
  tabPrevious: $('tab-previous'),
  tabOlder: $('tab-older'),
  grantSite: $('grant-site'),
  grantAll: $('grant-all'),
  emptyTitle: $('empty-title'),
  emptyBody: $('empty-body'),
  reloadEmpty: $('reload-empty'),
  icon: $('origin-icon'),
  label: $('origin-label'),
  lead: $('origin-lead'),
  routeNotice: $('route-notice'),
  freshVal: $('fresh-val'),
  speedVal: $('speed-val'),
  reloadNormal: $('reload-normal'),
  reloadBypass: $('reload-bypass'),
  reloadClearHistory: $('reload-clear-history'),
  compareResult: $('compare-result'),
  rows: $('l2-rows'),
  terms: $('l2-terms'),
  stylesheets: $('stylesheets'),
  stylesheetSummary: $('stylesheet-summary'),
  stylesheetList: $('stylesheet-list'),
  advanced: $('advanced'),
  debugToggle: $('debug-toggle'),
  rawTable: $('raw-table'),
  rawNotes: $('raw-notes'),
  copyHeaders: $('copy-headers'),
  copyStatus: $('copy-status'),
  recordUrl: $('record-url'),
  recordTime: $('record-time'),
  themeToggle: $('theme-toggle'),
};

let currentTabId = null;
let currentRecord = null;
let currentVerdict = null;
let currentView = null;
let displayedRecord = null;
let displayedVerdict = null;
let displayedView = null;
let refreshTimer = null;
let activeRecordIndex = 0;
let currentTabUrl = '';

const recordKey = (tabId) => `tab_${tabId}`;
const compareKey = (tabId) => `compare_${tabId}`;

// Google Fonts Icons / Material Icons の同名アイコンをローカルSVGとして描画する。
// 外部フォントは読み込まず、拡張内だけで完結させる。
const ORIGIN_ICONS = {
  computer: { viewBox: '0 0 24 24', d: 'M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4ZM4 6h16v10H4V6Z' },
  cloud: { viewBox: '0 -960 960 960', d: 'M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm0-80h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41Zm220-240Z' },
  host: { viewBox: '0 -960 960 960', d: 'M160-120q-33 0-56.5-23.5T80-200v-560q0-33 23.5-56.5T160-840h200q33 0 56.5 23.5T440-760v560q0 33-23.5 56.5T360-120H160Zm440 0q-33 0-56.5-23.5T520-200v-560q0-33 23.5-56.5T600-840h200q33 0 56.5 23.5T880-760v560q0 33-23.5 56.5T800-120H600Zm-440-80h200v-560H160v560Zm440 0h200v-560H600v560ZM200-360h120v-80H200v80Zm440 0h120v-80H640v80ZM200-480h120v-80H200v80Zm440 0h120v-80H640v80ZM200-600h120v-80H200v80Zm440 0h120v-80H640v80ZM160-200h200-200Zm440 0h200-200Z' },
  help: { viewBox: '0 0 24 24', d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm1 17h-2v-2h2v2Zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25Z' },
};

function renderOriginIcon(name) {
  const icon = ORIGIN_ICONS[name] || ORIGIN_ICONS.help;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', icon.viewBox);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icon.d);
  svg.append(path);
  els.icon.replaceChildren(svg);
}

function isMacPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(platform);
}

function shortcutText(kind) {
  const mac = isMacPlatform();
  if (kind === 'normal') return mac ? '⌘R' : 'Ctrl+R';
  return mac ? '⇧⌘R' : 'Ctrl+Shift+R';
}

function setShortcutButton(button, label, shortcut) {
  const text = document.createElement('span');
  text.className = 'button-label';
  text.textContent = label;
  const key = document.createElement('kbd');
  key.className = 'shortcut-key';
  key.textContent = shortcut;
  button.replaceChildren(text, key);
  button.title = `${label} (${shortcut})`;
}

function setupShortcutButtons() {
  setShortcutButton(els.reloadEmpty, 'このページを再読み込み', shortcutText('normal'));
  setShortcutButton(els.reloadNormal, '通常再読み込み', shortcutText('normal'));
  setShortcutButton(els.reloadBypass, 'キャッシュ無視', shortcutText('bypass'));
}

function originPatternFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
}

async function hasAccessToUrl(url) {
  const origin = originPatternFromUrl(url);
  if (!origin) return false;
  try {
    if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true;
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

function comparableUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch (_) {
    return url || '';
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
async function loadRecord(tabId) {
  if (tabId == null) return null;
  const o = await chrome.storage.session.get(recordKey(tabId));
  return o[recordKey(tabId)] || null;
}

function show(which) {
  els.permission.hidden = which !== 'permission';
  els.empty.hidden = which !== 'empty';
  els.loading.hidden = which !== 'loading';
  els.card.hidden = which !== 'card';
}

// ---- テーマ（ライト/ダーク）。明示選択は localStorage に保存し OS 設定を上書き ----
const THEME_ICON_MOON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
const THEME_ICON_SUN =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.6v2.3M12 19.1v2.3M21.4 12h-2.3M4.9 12H2.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"/></g></svg>';
const darkMql = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  return document.documentElement.dataset.theme || (darkMql.matches ? 'dark' : 'light');
}

function updateThemeToggle() {
  const dark = effectiveTheme() === 'dark';
  // タップで切り替わる先（＝反対のモード）のアイコンと説明を出す
  els.themeToggle.innerHTML = dark ? THEME_ICON_SUN : THEME_ICON_MOON;
  const label = dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.title = label;
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('cc-theme', next);
  } catch (_) {
    /* 保存できなくても表示は切り替える */
  }
  updateThemeToggle();
}

function tabRecords(rec) {
  const currentUrl = comparableUrl(rec?.url);
  const history = (rec?.history || []).filter((item) => item?.url && comparableUrl(item.url) === currentUrl);
  return [rec, ...history].filter((item) => item?.url).slice(0, 3);
}

function updateRecordTabs(rec) {
  const records = tabRecords(rec);
  if (activeRecordIndex >= records.length) activeRecordIndex = 0;
  const tabs = [els.tabCurrent, els.tabPrevious, els.tabOlder];
  tabs.forEach((tab, index) => {
    const visible = index < records.length;
    tab.hidden = !visible;
    tab.disabled = !visible;
    tab.tabIndex = visible ? 0 : -1;
    tab.classList.toggle('active', visible && activeRecordIndex === index);
    tab.setAttribute('aria-selected', String(visible && activeRecordIndex === index));
    tab.setAttribute('aria-hidden', String(!visible));
  });
}

function setActiveRecord(index) {
  activeRecordIndex = index;
  if (!currentRecord?.url) return;
  renderSelectedRecord(currentRecord);
}

// 鮮度チップは常時表示（2列グリッドの枠を固定しレイアウトシフトを防ぐ）。値が無ければ「—」。
function setChip(valEl, text) {
  valEl.textContent = text || '—';
}

// 速さ専用。枠は常時表示（chip-speed は hidden にしない）にして、perf（Navigation Timing）が
// 後から届くまでは薄色のプレースホルダ「測定中…」で埋める。後から枠が増えるレイアウトシフトを防ぐ。
function setSpeed(text) {
  const measuring = !text;
  els.speedVal.textContent = measuring ? '測定中…' : text;
  els.speedVal.classList.toggle('measuring', measuring);
}

function rowEl(r) {
  const div = document.createElement('div');
  div.className = 'row';
  const dt = document.createElement('dt');
  dt.textContent = r.label;
  const dd = document.createElement('dd');
  dd.textContent = r.value;
  div.append(dt, dd);
  if (r.note) {
    const note = document.createElement('div');
    note.className = 'row-note';
    note.textContent = r.note;
    div.append(note);
  }
  return div;
}

function termEl(t) {
  const div = document.createElement('div');
  div.className = 'term';
  const b = document.createElement('b');
  b.textContent = t.term;
  div.append(b, document.createTextNode('：' + t.def));
  return div;
}

const CSS_STATE_LABELS = {
  browser: 'ブラウザ',
  network: 'ネットワーク',
  server: 'サーバー',
  unknown: '不明',
};

function shortCssPath(path) {
  if (!path) return '—';
  const [pathname, query = ''] = path.split('?');
  const parts = pathname.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/') || pathname || '/';
  return query ? `${tail}?${query}` : tail;
}

function cssEl(item) {
  const div = document.createElement('div');
  div.className = 'css-item';
  const badge = document.createElement('span');
  badge.className = 'css-badge';
  badge.textContent = 'css';
  const name = document.createElement('span');
  name.className = 'css-name';
  name.textContent = shortCssPath(item.path);
  name.title = item.path || '';
  const meta = document.createElement('span');
  meta.className = 'css-meta';
  const source = item.observed
    ? (CSS_STATE_LABELS[item.state] || '不明')
    : (item.state === 'browser' ? 'ブラウザキャッシュ（推定）' : 'CSSリンクのみ検出');
  const checked = item.revalidated === true ? ' / 最新確認済み' : '';
  const cdn = item.cdn ? ` / ${item.cdn}` : '';
  const freshness = item.freshness ? ` / ${item.freshness}` : '';
  const detail = item.observed ? '' : ' / 応答ヘッダーなし';
  meta.textContent = `${source}${checked}${cdn}${freshness}${detail}`;
  div.append(badge, name, meta);
  return div;
}

function renderStylesheets(rec) {
  const stylesheets = rec.stylesheets || [];
  if (!stylesheets.length) {
    // 同一サイト内CSSが無ければブロックごと隠す（「見つかりませんでした」は表示しない）
    els.stylesheets.hidden = true;
    els.stylesheetSummary.textContent = '';
    els.stylesheetList.replaceChildren();
    return;
  }
  els.stylesheets.hidden = false;
  const observed = stylesheets.filter((item) => item.observed).length;
  els.stylesheetSummary.textContent = `同一サイト内CSS ${stylesheets.length}件（応答ヘッダー取得 ${observed}件）。外部配信CSSは除外しています。`;
  els.stylesheetList.replaceChildren(...stylesheets.map(cssEl));
}

async function loadHeaderDescriptionGroups() {
  try {
    const res = await fetch(chrome.runtime.getURL('sidepanel/header-descriptions.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('レスポンスヘッダー解説の読み込みに失敗:', e);
    return {};
  }
}

const HEADER_DESCRIPTION_GROUPS = await loadHeaderDescriptionGroups();
const HEADER_GROUP_BY_NAME = new Map(
  Object.entries(HEADER_DESCRIPTION_GROUPS).flatMap(([key, group]) => (
    Object.keys(group?.headers || {}).map((name) => [name, key])
  )),
);
const NETWORK_PRIVATE_HEADER_GROUPS = new Set(['surrogate', 'cdnCommon', 'fastly', 'cloudflare', 'cloudfront', 'akamai']);

function isNetworkPrivateHeader(name) {
  return NETWORK_PRIVATE_HEADER_GROUPS.has(HEADER_GROUP_BY_NAME.get(String(name).toLowerCase()));
}

function rawHeaderRow({ name, value }) {
  const tr = document.createElement('tr');
  const k = document.createElement('td');
  k.className = 'k';
  k.textContent = name;
  const val = document.createElement('td');
  val.textContent = value;
  tr.append(k, val);
  return tr;
}

function rawSubtitleRow(text) {
  const tr = document.createElement('tr');
  tr.className = 'raw-subtitle';
  const td = document.createElement('td');
  td.colSpan = 2;
  td.textContent = text;
  tr.append(td);
  return tr;
}

function renderRaw(headers) {
  const sorted = [...(headers || [])].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const regular = sorted.filter(({ name }) => !isNetworkPrivateHeader(name));
  const networkPrivate = sorted.filter(({ name }) => isNetworkPrivateHeader(name));
  const rawRows = regular.map(rawHeaderRow);
  if (networkPrivate.length) {
    rawRows.push(rawSubtitleRow('CDN・中継キャッシュのヘッダー'));
    rawRows.push(...networkPrivate.map(rawHeaderRow));
  }
  els.rawTable.replaceChildren(...rawRows);
  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = 'ヘッダーは取得できませんでした';
    tr.append(td);
    els.rawTable.replaceChildren(tr);
    els.rawNotes.replaceChildren();
    return;
  }
  // 解説は行内に散らさず、カテゴリ別に下部へまとめる（重複なし）。
  const seen = new Set();
  const headerNames = sorted.map(({ name }) => name.toLowerCase());
  const groups = [];
  for (const group of Object.values(HEADER_DESCRIPTION_GROUPS)) {
    const items = [];
    for (const n of headerNames) {
      const description = group?.headers?.[n];
      if (description && !seen.has(n)) {
        seen.add(n);
        items.push({ name: n, description });
      }
    }
    if (items.length) groups.push({ label: group.label || 'その他', items });
  }
  els.rawNotes.replaceChildren(
    ...groups.map((group) => {
      const section = document.createElement('section');
      section.className = 'raw-note-group';
      const heading = document.createElement('div');
      heading.className = 'raw-note-heading';
      heading.textContent = group.label;
      section.append(heading);
      for (const item of group.items) {
        const div = document.createElement('div');
        div.className = 'raw-note';
        const b = document.createElement('b');
        b.textContent = item.name;
        div.append(b, document.createTextNode(' — ' + item.description));
        section.append(div);
      }
      return section;
    }),
  );
}

function formatClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 取得`;
}

function setRecordUrl(url) {
  if (!url) {
    els.recordUrl.textContent = '—';
    els.recordUrl.title = '';
    return;
  }
  try {
    const u = new URL(url);
    els.recordUrl.textContent = u.hostname;
  } catch (_) {
    els.recordUrl.textContent = url;
  }
  els.recordUrl.title = url;
}

function setRouteNotice(tabUrl, recordUrl) {
  const staleRoute = tabUrl && recordUrl && comparableUrl(tabUrl) !== comparableUrl(recordUrl);
  els.routeNotice.hidden = !staleRoute;
  els.routeNotice.textContent = staleRoute
    ? 'ページ内でURLだけが変わっています。表示中の判定は、前回読み込まれたHTMLの情報です。正確に見るには再読み込みしてください。'
    : '';
}

function snapshot(rec, verdict, view) {
  return {
    at: Date.now(),
    url: rec?.url || '',
    label: view?.l1?.label || '—',
    freshness: view?.l1?.freshness || '—',
    speed: view?.l1?.speed || '測定中',
    originState: verdict?.origin?.state || 'unknown',
    revalidated: verdict?.origin?.revalidated ?? null,
    cdn: verdict?.cdn?.name || '',
    server: verdict?.server?.kind || '',
  };
}

function describeCompare(before, after, mode) {
  const modeLabel = mode === 'bypass' ? 'キャッシュ無視' : '通常再読み込み';
  const confirm = after.revalidated === true ? ' / 最新確認済み' : '';
  const transition = before.label === after.label
    ? `${after.label}のまま`
    : `${before.label} → ${after.label}`;
  return `${modeLabel}: ${transition}${confirm}。鮮度 ${after.freshness}、速さ ${after.speed}`;
}

async function loadCompare(tabId) {
  if (tabId == null) return null;
  const o = await chrome.storage.session.get(compareKey(tabId));
  return o[compareKey(tabId)] || null;
}

async function renderComparison(rec) {
  const state = await loadCompare(currentTabId);
  if (!state) {
    els.compareResult.hidden = true;
    els.compareResult.textContent = '';
    return;
  }
  els.compareResult.hidden = false;
  if (!rec?.receiveTime || rec.receiveTime < state.startedAt) {
    els.compareResult.textContent = '再読み込み中です…';
    return;
  }
  const after = snapshot(rec, currentVerdict, currentView);
  els.compareResult.textContent = describeCompare(state.before, after, state.mode);
  if (!state.after) {
    await chrome.storage.session.set({ [compareKey(currentTabId)]: { ...state, after } });
  }
}

function renderDisplayedRecord(rec, index) {
  const v = classify(recordToInput(rec, Date.now()));
  const p = present(v);
  displayedRecord = rec;
  displayedVerdict = v;
  displayedView = p;
  // 上級者向け（Fastly-Debug 注入）は現在タブの Fastly 検出時だけ表示する
  els.advanced.hidden = index !== 0 || v.cdn?.name !== 'Fastly';
  document.documentElement.style.setProperty('--accent', p.badge.color);
  renderOriginIcon(p.l1.icon);
  els.label.textContent = p.l1.label;
  els.lead.textContent = p.l1.lead;
  setChip(els.freshVal, p.l1.freshness);
  setSpeed(p.l1.speed);
  els.rows.replaceChildren(...p.l2.rows.map(rowEl));
  els.terms.replaceChildren(...p.l2.terms.map(termEl));
  renderStylesheets(rec);
  renderRaw(rec.headers || []);
  setRecordUrl(rec.url);
  els.recordTime.textContent = rec.receiveTime ? formatClock(rec.receiveTime) : '';
  if (index === 0) {
    setRouteNotice(currentTabUrl, rec.url);
  } else {
    els.routeNotice.hidden = true;
    els.routeNotice.textContent = '';
  }
}

function renderSelectedRecord(rec) {
  const currentVerdictNext = classify(recordToInput(rec, Date.now()));
  currentVerdict = currentVerdictNext;
  currentView = present(currentVerdictNext);
  const records = tabRecords(rec);
  if (activeRecordIndex >= records.length) activeRecordIndex = 0;
  updateRecordTabs(rec);
  renderDisplayedRecord(records[activeRecordIndex] || rec, activeRecordIndex);
}

function fullRender(rec) {
  renderSelectedRecord(rec);
}

const RECORD_LABELS = ['現在', '前回', '前々回'];

function buildResponseHeadersText(rec, title = 'レスポンスヘッダー') {
  const lines = [
    title,
  ];
  if (rec?.url) lines.push(rec.url);
  if (rec?.receiveTime) lines.push(formatClock(rec.receiveTime));
  lines.push('');
  for (const h of rec?.headers || []) lines.push(`${h.name}: ${h.value ?? ''}`);
  if (!(rec?.headers || []).length) lines.push('レスポンスヘッダーはまだ取得できていません。');
  return lines.join('\n');
}

function buildAllResponseHeadersText(rec) {
  const records = tabRecords(rec);
  const sections = records.map((item, index) => {
    let label = '特定できませんでした';
    try {
      label = present(classify(recordToInput(item, Date.now()))).l1?.label || label;
    } catch (_) {}
    return buildResponseHeadersText(item, `カーシュ・カーシュ ${RECORD_LABELS[index]}: ${label}`);
  });
  return sections.join('\n\n---\n\n');
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  els.copyStatus.hidden = false;
  els.copyStatus.textContent = 'レスポンスヘッダーをまとめてコピーしました';
}

async function copyHeaders() {
  if (!currentRecord) return;
  try {
    await copyText(buildAllResponseHeadersText(currentRecord));
  } catch (e) {
    els.copyStatus.hidden = false;
    els.copyStatus.textContent = 'コピーできませんでした';
  }
}

async function startCompare(mode) {
  if (currentTabId == null || !currentRecord || !currentVerdict || !currentView) return;
  activeRecordIndex = 0;
  const state = {
    mode,
    startedAt: Date.now(),
    before: snapshot(currentRecord, currentVerdict, currentView),
  };
  await chrome.storage.session.set({ [compareKey(currentTabId)]: state });
  els.compareResult.hidden = false;
  els.compareResult.textContent = '再読み込み中です…';
  await chrome.tabs.reload(currentTabId, { bypassCache: mode === 'bypass' });
}

async function clearHistoryAndReload() {
  if (currentTabId == null) return;
  activeRecordIndex = 0;
  await chrome.storage.session.remove(compareKey(currentTabId));
  const rec = await loadRecord(currentTabId);
  const pendingUrl = rec?.url || currentTabUrl || '';
  await chrome.storage.session.set({ [recordKey(currentTabId)]: { pendingUrl, stylesheets: [], history: [] } });
  els.compareResult.hidden = false;
  els.compareResult.textContent = '履歴をクリアして再読み込み中です…';
  await chrome.tabs.reload(currentTabId);
}

async function requestAllSitesAccess() {
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (granted && currentTabId != null) await chrome.tabs.reload(currentTabId);
  } catch (e) {
    console.error(e);
  }
  await refresh();
}

function tick() {
  if (els.card.hidden || !currentRecord) return;
  currentVerdict = classify(recordToInput(currentRecord, Date.now()));
  currentView = present(currentVerdict);
  const source = displayedRecord || currentRecord;
  const p = source === currentRecord ? currentView : present(classify(recordToInput(source, Date.now())));
  displayedView = p;
  setChip(els.freshVal, p.l1.freshness);
  setSpeed(p.l1.speed);
}

async function syncDebugToggle() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    els.debugToggle.checked = rules.some((r) => r.id === currentTabId);
  } catch (_) {
    /* 取得できなければ既定 off のまま */
  }
}

function isMonitorable(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) {
    return false;
  }
}

async function refresh() {
  const tab = await getActiveTab();
  const nextTabId = tab?.id ?? null;
  if (currentTabId !== nextTabId) activeRecordIndex = 0;
  currentTabId = nextTabId;
  currentTabUrl = tab?.url || '';

  // ブラウザの内部ページ（chrome:// 等）は仕組み上、出どころを確認できない
  if (tab?.url && !isMonitorable(tab.url)) {
    currentRecord = null;
    currentVerdict = null;
    currentView = null;
    displayedRecord = null;
    displayedVerdict = null;
    displayedView = null;
    els.emptyTitle.textContent = 'このページは確認できません';
    els.emptyBody.textContent = 'ブラウザの内部ページ（chrome:// など）は、仕組み上どこから届いたかを確認できません。';
    els.reloadEmpty.hidden = true;
    show('empty');
    return;
  }

  const granted = await hasAccessToUrl(tab?.url);
  if (!granted) {
    currentRecord = null;
    currentVerdict = null;
    currentView = null;
    displayedRecord = null;
    displayedVerdict = null;
    displayedView = null;
    els.grantSite.disabled = !originPatternFromUrl(tab?.url);
    show('permission');
    return;
  }

  const previousReceiveTime = currentRecord?.receiveTime || null;
  const rec = await loadRecord(currentTabId);
  if (rec?.receiveTime && previousReceiveTime && rec.receiveTime !== previousReceiveTime) activeRecordIndex = 0;
  currentRecord = rec;
  if (!rec?.url) {
    currentVerdict = null;
    currentView = null;
    displayedRecord = null;
    displayedVerdict = null;
    displayedView = null;
    // 読み込み中は empty を出さずローダー（チラつき防止）。完了後に記録が無ければ empty。
    if (tab?.status === 'loading') {
      show('loading');
      return;
    }
    els.emptyTitle.textContent = 'このタブの情報はまだありません';
    els.emptyBody.textContent = rec
      ? 'ページ本体の読み込みが終わると、出どころを確認できます。'
      : 'ページを再読み込みすると、出どころを確認できます。';
    els.reloadEmpty.hidden = false;
    show('empty');
    return;
  }
  fullRender(rec);
  await renderComparison(rec);
  await syncDebugToggle();
  show('card');
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 120);
}

// ---- イベント ----
els.tabCurrent.addEventListener('click', () => setActiveRecord(0));
els.tabPrevious.addEventListener('click', () => setActiveRecord(1));
els.tabOlder.addEventListener('click', () => setActiveRecord(2));

els.grantSite.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    const origin = originPatternFromUrl(tab?.url);
    const granted = origin ? await chrome.permissions.request({ origins: [origin] }) : false;
    if (granted && currentTabId != null) await chrome.tabs.reload(currentTabId);
  } catch (e) {
    console.error(e);
  }
  await refresh();
});

els.grantAll.addEventListener('click', async () => {
  await requestAllSitesAccess();
});

els.reloadEmpty.addEventListener('click', () => {
  if (currentTabId != null) chrome.tabs.reload(currentTabId);
});

els.reloadNormal.addEventListener('click', () => startCompare('normal'));
els.reloadBypass.addEventListener('click', () => startCompare('bypass'));
els.reloadClearHistory.addEventListener('click', clearHistoryAndReload);

window.addEventListener('keydown', (event) => {
  const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || event.key.toLowerCase() !== 'r') return;
  event.preventDefault();
  startCompare(event.shiftKey ? 'bypass' : 'normal');
});

els.debugToggle.addEventListener('change', async () => {
  if (currentTabId == null) return;
  // ルール反映の完了を待ってから再読み込みし、反映前のリクエストが飛ぶのを防ぐ
  await chrome.runtime.sendMessage({ type: 'cc-toggle-debug', tabId: currentTabId, on: els.debugToggle.checked });
  chrome.tabs.reload(currentTabId);
});

els.copyHeaders.addEventListener('click', copyHeaders);

// テーマ切替（右上アイコン）。未選択(auto)時は OS 変更にも追従してアイコンを更新
els.themeToggle.addEventListener('click', toggleTheme);
darkMql.addEventListener('change', updateThemeToggle);
updateThemeToggle();

// ---- ライブ更新 ----
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && currentTabId != null && recordKey(currentTabId) in changes) scheduleRefresh();
});
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && (changeInfo.status === 'complete' || changeInfo.url)) refresh();
});
if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(refresh);

setInterval(tick, 1000);
setupShortcutButtons();
refresh();
