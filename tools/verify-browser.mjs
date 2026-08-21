// 実Chrome(puppeteer-core)で拡張を駆動する検証ハーネス。
//  ① 拡張ロード（拡張IDをパスから算出し、サイドパネルが開けるIDを特定）
//  ② サイドパネル実描画（ESM import 解決・console エラー無し）＋スクショ
//  ③ ブラウザ内で実 lib を import しライブURLのヘッダーで正しい出力か
//  ④ ページ→runtime.sendMessage で SW を起こし、host権限付与→対象URL→storage 捕捉
import { execSync } from 'node:child_process';
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';
import { recordToInput } from '../lib/record.js';
// 拡張の複製・ID算出・Chrome 起動は tools/verify-panel.mjs と共通（tools/chrome-harness.mjs）。
import { extensionIdCandidates, launchChrome, prepareExtensionForVerification, resolveExtensionId } from './chrome-harness.mjs';

const SHOT = '/tmp/cc-shot';
const SOURCE_EXT = process.cwd();
const EXT = prepareExtensionForVerification(SOURCE_EXT);
const TARGET_URL = process.env.VERIFY_URL || 'https://www.fastly.com/jp/';
const log = (...a) => console.log(...a);

function liveHeaders(url) {
  const out = execSync(`curl -sS -D - -o /dev/null --max-time 12 ${JSON.stringify(url)}`, { encoding: 'utf8' });
  const blocks = out.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//m.test(b));
  const last = blocks[blocks.length - 1] || out;
  const lines = last.split(/\r?\n/).filter(Boolean);
  lines.shift();
  return lines.map((l) => { const i = l.indexOf(':'); return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : null; }).filter(Boolean);
}

const headers = liveHeaders(TARGET_URL);
// headless では Chrome が MV3 拡張をロードしないため headful で起動（検証用・一時プロファイル）
let browser;
try {
  browser = await launchChrome();
} catch (e) {
  log(e.message);
  process.exit(1);
}

try {
  const installedId = await browser.installExtension(EXT).catch((e) => {
    log('拡張インストール失敗:', e.message);
    return null;
  });
  const candidates = extensionIdCandidates(installedId, EXT);

  // ① 候補IDでサイドパネルを開いて拡張を特定
  const page = await browser.newPage();
  await page.setViewport({ width: 380, height: 760, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const extId = await resolveExtensionId(page, candidates, (id, ok) => {
    log(`   候補ID ${id}: ${ok ? '一致（サイドパネル描画）' : '不一致'}`);
  });
  if (!extId) throw new Error('拡張IDを特定できず（headlessで未ロードの可能性）');
  log('① 拡張ロード OK / ID:', extId);

  // ② 描画状態 + スクショ + console
  await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`, { waitUntil: 'networkidle0', timeout: 15000 });
  const stateShown = await page.evaluate(() => {
    for (const id of ['permission', 'empty', 'card']) { const el = document.getElementById(id); if (el && !el.hidden) return id; }
    return '(none)';
  });
  await page.screenshot({ path: `${SHOT}-panel-initial.png` });
  log('② サイドパネル描画 OK / 表示状態:', stateShown, '/ console:', errors.length ? errors : 'エラー無し');

  // ③ ブラウザ内で実 lib を import → ライブURL判定
  const inBrowser = await page.evaluate(async (hdrs) => {
    const { classify } = await import('../lib/classify.js');
    const { present } = await import('../lib/present.js');
    const v = classify({ headers: hdrs, statusCode: 200, ip: '151.101.0.1', fromCache: false, receiveTime: Date.now(), now: Date.now() });
    const p = present(v);
    return { label: p.l1.label, lead: p.l1.lead, fresh: p.l1.freshness, badge: p.badge.text, servedAt: v.cdn?.servedAt, popCity: v.cdn?.pop?.city, cdn: v.cdn?.name };
  }, headers).catch((e) => ({ error: String(e) }));
  log('③ ブラウザ内 lib（ライブURL）:', JSON.stringify(inBrowser));

  // ④ SW を起こす → host権限付与 → 対象URLへナビゲート → storage 捕捉
  await page.evaluate(() => { try { chrome.runtime.sendMessage({ type: 'wake' }); } catch (_) {} });
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && /service-worker\.js$/.test(t.url()), { timeout: 8000 }).catch(() => null);
  log('④ SW 起動:', swT ? 'OK' : '起こせず');
  if (swT) {
    const worker = await swT.worker();
    const grant = await worker.evaluate(async () => {
      try {
        if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true;
        return await chrome.permissions.request({ origins: ['<all_urls>'] });
      } catch (e) {
        return 'ERR:' + e.message;
      }
    });
    log('   host権限:', grant);
    if (grant === true) {
      const scripts = await worker.evaluate(async () => {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['cc-perf'] }).catch(() => []);
        if (!existing.length) {
          await chrome.scripting.registerContentScripts([
            {
              id: 'cc-perf',
              js: ['content/perf.js'],
              matches: ['<all_urls>'],
              runAt: 'document_end',
              allFrames: false,
              persistAcrossSessions: true,
            },
          ]);
          return 'registered-for-verification';
        }
        return 'already-registered';
      }).catch((e) => 'ERR:' + e.message);
      log('   content script:', scripts);

      const targetPage = await browser.newPage();
      await targetPage.goto(TARGET_URL, { waitUntil: 'load', timeout: 25000 }).catch((e) => log('   target goto:', e.message));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const finalUrl = targetPage.url();
      const rec = await worker.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === targetUrl || t.url?.startsWith(targetUrl));
        if (!tab) return null;
        const k = 'tab_' + tab.id;
        return (await chrome.storage.session.get(k))[k] || null;
      }, finalUrl).catch((e) => ({ error: String(e) }));
      log('   webRequest 捕捉 record:', rec && rec.headers ? JSON.stringify({ url: rec.url, statusCode: rec.statusCode, fromCache: rec.fromCache, headerCount: rec.headers.length }) : JSON.stringify(rec));
      if (rec && rec.headers) {
        const p = present(classify(recordToInput(rec)));
        const out = { badge: p.badge, label: p.l1.label, fresh: p.l1.freshness, perf: rec.perf ?? null };
        log('   実捕捉ヘッダーの判定:', JSON.stringify(out));
      }
    }
  }
} catch (e) {
  log('ERROR:', e.message);
} finally {
  const keepOpenMs = Number(process.env.KEEP_OPEN_MS || 0);
  if (keepOpenMs > 0) {
    log(`=== keeping Chrome open for ${keepOpenMs}ms ===`);
    await new Promise((resolve) => setTimeout(resolve, keepOpenMs));
  }
  await browser.close();
  log('=== browser closed ===');
}
