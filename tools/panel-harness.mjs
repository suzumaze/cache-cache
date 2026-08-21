// サイドパネル（sidepanel/）を実 Chrome で動かし、記録を注入して DOM を確かめるためのハーネス。
//
// なぜ要るか: npm test（node --test）が届くのは lib/ の純粋関数までで、chrome.* に依存する
// 表示層（sidepanel/）と Service Worker は対象外になる。そこを実物の Chrome で見るのがここ。
//
// board.md「実機検証ハーネスの技法」の4点を、そのまま関数にしたもの:
//   ① 記録の直接注入   chrome.storage.session の `tab_<tabId>` に書く（history 込み）。
//                      実際のネットワークアクセスを待たずに任意のヘッダー状況を再現できる。
//   ② 対象タブの固定   サイドパネルは chrome.tabs.query({active:true}) で対象タブを決めるため、
//                      検証ページ自身が active になると対象を見失う。active の問い合わせだけを
//                      スタブし、それ以外は本物へ委譲する（以降は本物のコードが動く）。
//   ③ コピーの捕捉     navigator.clipboard.writeText を差し替えて書き込み文字列を溜める
//                      （読み取りAPIは権限で弾かれるため、書き込み側を捕まえる）。
//   ④ SW の監視        service_worker ターゲットの console / error を集める。
//
// 使い方は tools/verify-panel.mjs を参照。
import {
  extensionIdCandidates,
  launchChrome,
  prepareExtensionForVerification,
  resolveExtensionId,
} from './chrome-harness.mjs';

// 架空タブのID。実在しないので chrome.tabs.reload 等は届かない（スタブで受け止める）。
export const FAKE_TAB_ID = 424242;

// storage のキー名は service-worker.js / sidepanel.js と持ち合っている。片方だけ変えると黙って外れる。
const RECORD_KEY = (tabId) => `tab_${tabId}`;
const DEBUG_DOMAINS_KEY = 'debugDomains';
// スタブの設定はページ側から同期的に読めないと間に合わない（evaluateOnNewDocument は
// ページ読み込みの最初に走る）ため、localStorage 経由で渡す。sidepanel.js のテーマ保存とは別キー。
const HARNESS_TAB_KEY = '__ccHarnessTab';

/** ページ読み込みの最初に差し込むスタブ（②③）。ここだけがブラウザ側で動くコード。 */
function installStubs(harnessTabKey) {
  const readConfig = () => {
    try {
      return JSON.parse(localStorage.getItem(harnessTabKey) || 'null');
    } catch (_) {
      return null;
    }
  };

  // ③ コピーの捕捉
  window.__ccClipboard = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__ccClipboard.push(String(text));
        },
      },
    });
  } catch (_) {
    /* 差し替えられなければコピー検証だけが落ちる。他の検証は続行させる。 */
  }

  // ② 対象タブの固定。active の問い合わせだけ架空タブを返し、それ以外は本物に委譲する。
  const patch = () => {
    if (typeof chrome === 'undefined' || !chrome.tabs || chrome.tabs.__ccPatched) return false;
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (queryInfo, callback) => {
      const cfg = readConfig();
      if (cfg && queryInfo && queryInfo.active === true) {
        const tabs = [{ id: cfg.id, url: cfg.url, status: cfg.status, active: true, windowId: 1 }];
        if (typeof callback === 'function') return void callback(tabs);
        return Promise.resolve(tabs);
      }
      return realQuery(queryInfo, callback);
    };
    // 架空タブに実際の再読み込みは届かない。呼ばれた事実だけ数え、拒否で unhandled rejection に
    // させない（SW/パネルのコンソール監視を、検証自身のノイズで汚さないため）。
    const realReload = chrome.tabs.reload.bind(chrome.tabs);
    chrome.tabs.reload = (tabId, props, callback) => {
      const cfg = readConfig();
      if (cfg && (tabId === cfg.id || tabId == null)) {
        window.__ccReloads = (window.__ccReloads || 0) + 1;
        if (typeof callback === 'function') return void callback();
        return Promise.resolve();
      }
      return realReload(tabId, props, callback);
    };
    chrome.tabs.__ccPatched = true;
    window.__ccStub = 'ok';
    return true;
  };

  if (!patch()) {
    // chrome バインディングがまだ無いときの保険。sidepanel.js は type="module"（defer 相当）
    // なので、DOMContentLoaded より前に当たれば間に合う。
    window.__ccStub = 'pending';
    const timer = setInterval(() => {
      if (patch()) clearInterval(timer);
    }, 1);
    document.addEventListener('DOMContentLoaded', () => {
      patch();
      clearInterval(timer);
    });
  }
}

/** 1セレクタぶんの DOM の様子をまとめて取る。判定は Node 側で行う。 */
function readSelector(selector) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const els = [...document.querySelectorAll(selector)];
  return {
    count: els.length,
    text: els.length ? norm(els[0].textContent) : null,
    all: els.map((e) => norm(e.textContent)),
    hidden: els.length ? els[0].hidden === true : null,
  };
}

/**
 * 期待1件を判定する。verb は text / match / count / hidden / contains の5つだけ。
 * @returns {string|null} 満たしていれば null、違えば「何がどう違ったか」の文字列
 */
function checkOne(expectation, seen) {
  const { sel } = expectation;
  const where = `${sel}`;
  // 長い注記まで丸ごと出すと読めなくなるので、実際の値は頭を見せるだけにする。
  const clip = (s, max = 400) => (s.length > max ? `${s.slice(0, max)}…` : s);
  if (!('count' in expectation) && seen.count === 0) {
    return `${where}\n      期待: 要素が存在すること\n      実際: 0件（セレクタに一致しません）`;
  }
  if ('count' in expectation && seen.count !== expectation.count) {
    const found = seen.all.length ? `（${clip(seen.all.map((t) => JSON.stringify(t)).join(', '))}）` : '';
    return `${where} の件数\n      期待: ${expectation.count}件\n      実際: ${seen.count}件${found}`;
  }
  if ('text' in expectation && seen.text !== expectation.text) {
    return `${where} の文言\n      期待: ${JSON.stringify(expectation.text)}\n      実際: ${JSON.stringify(seen.text)}`;
  }
  if ('match' in expectation && !expectation.match.test(seen.text ?? '')) {
    return `${where} の文言\n      期待: ${expectation.match} に一致\n      実際: ${JSON.stringify(seen.text)}`;
  }
  if ('hidden' in expectation && seen.hidden !== expectation.hidden) {
    return `${where} の表示\n      期待: hidden=${expectation.hidden}\n      実際: hidden=${seen.hidden}（文言 ${JSON.stringify(seen.text)}）`;
  }
  if ('contains' in expectation) {
    const joined = seen.all.join(' ⏐ ');
    const missing = expectation.contains.filter((needle) => !joined.includes(needle));
    if (missing.length) {
      return `${where} に含まれるべき語\n      期待: ${missing.map((m) => JSON.stringify(m)).join(', ')} を含む\n      実際: ${JSON.stringify(clip(joined))}`;
    }
  }
  return null;
}

/**
 * ハーネスを起動する。呼び出し側は prepare → check → （必要なら click → check）を繰り返す。
 * @param {{sourceDir?: string, onLog?: (msg: string) => void}} options
 */
export async function openPanelHarness({ sourceDir = process.cwd(), onLog = () => {} } = {}) {
  const extDir = prepareExtensionForVerification(sourceDir);
  const browser = await launchChrome({ windowSize: '460,900' });

  // ④ Service Worker のコンソール監視。起動より前から張っておく（起動直後のエラーを逃さない）。
  const swErrors = [];
  const swWarnings = [];
  const swLogs = [];
  // 「エラー無し」を言うには、そもそも SW に取り付けられたことが要る（取り付け失敗も無言なので）。
  const swAttached = [];
  const watchWorker = async (target) => {
    if (target.type() !== 'service_worker') return;
    let worker = null;
    try {
      worker = await target.worker();
    } catch (_) {
      return;
    }
    if (!worker) return;
    swAttached.push(target.url());
    onLog(`   SW 起動を検出: ${target.url()}`);
    worker.on('console', (m) => {
      const line = `[SW ${m.type()}] ${m.text()}`;
      swLogs.push(line);
      if (m.type() === 'error') swErrors.push(line);
      else if (m.type() === 'warning' || m.type() === 'warn') swWarnings.push(line);
    });
    worker.on('error', (e) => swErrors.push(`[SW error] ${e.message}`));
  };
  browser.on('targetcreated', watchWorker);
  for (const t of browser.targets()) watchWorker(t);

  const installedId = await browser.installExtension(extDir).catch(() => null);

  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 880, deviceScaleFactor: 1 });

  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`[panel console.error] ${m.text()}`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[panel pageerror] ${e.message}`));

  const extensionId = await resolveExtensionId(page, extensionIdCandidates(installedId, extDir), (id, ok) =>
    onLog(`   候補ID ${id}: ${ok ? '一致（サイドパネル描画）' : '不一致'}`),
  );
  if (!extensionId) {
    await browser.close();
    throw new Error(
      [
        '拡張IDを特定できませんでした（サイドパネルが開けていません）。',
        'Chrome が MV3 拡張をロードできていない可能性があります（headless 起動になっていないか、',
        'プロファイルが壊れていないかを確認してください）。',
      ].join('\n'),
    );
  }

  const panelUrl = `chrome-extension://${extensionId}/sidepanel/sidepanel.html`;
  await page.evaluateOnNewDocument(installStubs, HARNESS_TAB_KEY);

  return {
    extensionId,
    page,
    swErrors,
    swWarnings,
    swLogs,
    swAttached,
    pageErrors,

    /** ① 記録の注入 ＋ ② 対象タブの指定。storage を作り直してから読み込み直す。 */
    async prepare({ tabUrl, tabStatus = 'complete', record = null, debugDomains = [], waitFor = '#card' }) {
      await page.evaluate(
        async (cfg) => {
          localStorage.setItem(cfg.harnessTabKey, JSON.stringify({ id: cfg.tabId, url: cfg.tabUrl, status: cfg.tabStatus }));
          await chrome.storage.session.clear();
          await chrome.storage.local.clear();
          if (cfg.record) await chrome.storage.session.set({ [cfg.recordKey]: cfg.record });
          if (cfg.debugDomains.length) await chrome.storage.local.set({ [cfg.debugDomainsKey]: cfg.debugDomains });
        },
        {
          harnessTabKey: HARNESS_TAB_KEY,
          recordKey: RECORD_KEY(FAKE_TAB_ID),
          debugDomainsKey: DEBUG_DOMAINS_KEY,
          tabId: FAKE_TAB_ID,
          tabUrl,
          tabStatus,
          record,
          debugDomains,
        },
      );
      await page.goto(panelUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!el && el.hidden !== true;
        },
        { timeout: 10000 },
        waitFor,
      );
      const stub = await page.evaluate(() => window.__ccStub || '(未実行)');
      if (stub !== 'ok') throw new Error(`chrome.tabs のスタブを差し込めませんでした（状態: ${stub}）`);
    },

    /**
     * 期待の一覧を満たすまで短く待ち、満たさなければ差分を返す。
     * 非同期の描画（コピー完了・SW 往復）を素直に待てるよう、固定 sleep ではなくここで粘る。
     * @returns {Promise<string[]>} 失敗の説明（空なら全て合格）
     */
    async check(expectations, { timeoutMs = 4000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let failures = [];
      for (;;) {
        failures = [];
        for (const expectation of expectations) {
          const seen = await page.evaluate(readSelector, expectation.sel);
          const failure = checkOne(expectation, seen);
          if (failure) failures.push(failure);
        }
        if (!failures.length || Date.now() >= deadline) return failures;
        await new Promise((r) => setTimeout(r, 120));
      }
    },

    async click(selector) {
      const el = await page.$(selector);
      if (!el) throw new Error(`クリック対象が見つかりません: ${selector}`);
      await el.click();
    },

    /** ③ 捕捉したコピー内容（クリックした順） */
    clipboard() {
      return page.evaluate(() => window.__ccClipboard || []);
    },

    screenshot(path) {
      return page.screenshot({ path }).catch(() => {});
    },

    close() {
      return browser.close();
    },
  };
}
