// 診断: 拡張ロード状況と真の拡張IDを掴む。targets を全ダンプし、
// service_worker / chrome://extensions の両経路で ID 取得を試す。
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = process.cwd();
const PROFILE = mkdtempSync(join(tmpdir(), 'cc-diag-'));
const log = (...a) => console.log(...a);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: PROFILE,
  pipe: true,
  enableExtensions: true,
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=420,820'],
});

try {
  const installedId = await browser.installExtension(EXT).catch((e) => 'ERR:' + e.message);
  log('installExtension:', installedId);

  const installed = await browser.extensions().catch((e) => ({ error: String(e) }));
  log('--- browser.extensions ---');
  if (installed instanceof Map) {
    for (const [id, ext] of installed) log(`  ${id}: ${ext.url ?? '(urlなし)'}`);
    if (!installed.size) log('  (none)');
  } else {
    log(JSON.stringify(installed, null, 2));
  }

  // SW ターゲットを少し待つ（MV3 は onInstalled で一度起動する）
  const swT = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && /service-worker\.js$/.test(t.url()),
    { timeout: 6000 },
  ).catch(() => null);
  log('SW target:', swT ? swT.url() : '(なし)');

  // 全ターゲットをダンプ
  log('--- all targets ---');
  for (const t of browser.targets()) log(`  [${t.type()}] ${t.url()}`);

  // chrome://extensions の shadow DOM から ID とロード状況
  const page = await browser.newPage();
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch((e) => log('extensions goto:', e.message));
  const info = await page.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return { error: 'no extensions-manager' };
    const list = mgr.shadowRoot?.querySelector('extensions-item-list');
    const items = list?.shadowRoot?.querySelectorAll('extensions-item') || [];
    return [...items].map((it) => {
      const sr = it.shadowRoot;
      return {
        id: it.id,
        name: sr?.querySelector('#name')?.textContent?.trim(),
        enabled: !!sr?.querySelector('#enableToggle')?.checked,
        errors: sr?.querySelector('#errors-button') ? 'has-errors-button' : 'none',
      };
    });
  }).catch((e) => ({ error: String(e) }));
  log('--- chrome://extensions ---');
  log(JSON.stringify(info, null, 2));
} catch (e) {
  log('ERROR:', e.message);
} finally {
  const keepOpenMs = Number(process.env.KEEP_OPEN_MS || 0);
  if (keepOpenMs > 0) {
    log(`=== keeping Chrome open for ${keepOpenMs}ms ===`);
    await new Promise((resolve) => setTimeout(resolve, keepOpenMs));
  }
  await browser.close();
  log('=== closed ===');
}
