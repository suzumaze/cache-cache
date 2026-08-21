// 実 Chrome（puppeteer-core）で拡張を起動するための共通処理。
// tools/verify-browser.mjs（ライブURLの通し検証）と tools/verify-panel.mjs（パネルDOMの検証）が使う。
// MV3 拡張は headless ではロードされないため、どちらも headful 起動（Chrome のウィンドウが開く）。
import puppeteer from 'puppeteer-core';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 環境要因（Chrome 未インストール等）は、分かる言葉にしてここで止める。 */
export function assertChromeAvailable(chromePath = CHROME) {
  if (existsSync(chromePath)) return;
  throw new Error(
    [
      `Google Chrome が見つかりません: ${chromePath}`,
      'この検証は実物の Chrome を起動して行います（MV3 拡張は headless ではロードされないため、',
      '検証中は Chrome のウィンドウが開きます。想定どおりの挙動です）。',
      'Chrome を別の場所に入れている場合は、環境変数 CHROME_PATH でパスを指定してください。',
    ].join('\n'),
  );
}

/**
 * 検証用に拡張を一時ディレクトリへ複製する。
 * optional_host_permissions（利用者に都度尋ねる形）のままだと権限ダイアログが出て自動化できないので、
 * 複製側の manifest だけ host_permissions に <all_urls> を移す。配布物には一切影響しない。
 */
export function prepareExtensionForVerification(sourceDir) {
  const out = mkdtempSync(join(tmpdir(), 'cc-ext-'));
  for (const name of ['manifest.json', 'service-worker.js', 'content', 'lib', 'sidepanel', 'icons']) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) continue;
    cpSync(src, join(out, name), { recursive: true });
  }
  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), '<all_urls>'])];
  delete manifest.optional_host_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  mkdirSync(join(out, 'content'), { recursive: true });
  return out;
}

// unpacked 拡張IDの算出: SHA256(絶対パス) 先頭16バイト→各hex桁を a..p に写像
export function idFromPath(p) {
  const h = createHash('sha256').update(p).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function realSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** installExtension の戻り値とパス由来IDを、重複を除いて候補に並べる。 */
export function extensionIdCandidates(installedId, extDir) {
  return [...new Set([installedId, idFromPath(realSafe(extDir)), idFromPath(extDir)].filter(Boolean))];
}

/** headful・使い捨てプロファイルで Chrome を起動する。 */
export function launchChrome({ windowSize = '420,820', profileDir = null } = {}) {
  assertChromeAvailable();
  return puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: profileDir || mkdtempSync(join(tmpdir(), 'cc-prof-')),
    pipe: true,
    enableExtensions: true,
    args: ['--no-first-run', '--no-default-browser-check', `--window-size=${windowSize}`],
  });
}

/**
 * 候補IDでサイドパネルを順に開き、実際に描画できたものを拡張IDとして採用する。
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} candidates
 * @param {(id: string, ok: boolean) => void} onTry 候補ごとの結果通知（ログ用）
 * @returns {Promise<string|null>}
 */
export async function resolveExtensionId(page, candidates, onTry = () => {}) {
  for (const id of candidates) {
    const ok = await page
      .goto(`chrome-extension://${id}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded', timeout: 12000 })
      .then(() => page.$('#origin-label'))
      .then((el) => !!el)
      .catch(() => false);
    onTry(id, ok);
    if (ok) return id;
  }
  return null;
}
