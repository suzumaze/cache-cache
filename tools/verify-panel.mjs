// サイドパネルの実機検証。`npm run verify:panel` で実行する（実 Chrome を起動するため npm test には含めない）。
//
// 何をするか: 「こういうヘッダーの記録を注入したら、パネルの DOM がこうなるはず」を下の SCENARIOS に
// 宣言的に並べ、上から順に実行する。ヘッダーは lib/ のユニットテストと同じく例示用ドメイン
// （example.com 系）で組み立てる。実サイトへのアクセスは一切しない。
//
// シナリオの足しかた:
//   1. SCENARIOS に { name, tabUrl, record, expect } を1つ追加する。
//   2. record は (now) => 記録オブジェクト の関数。now を使って receiveTime を「今」に寄せると、
//      鮮度のカウントダウンが安定する。
//   3. expect の書き方は5つだけ。
//        { sel, text: '…' }        先頭要素の文言が完全一致
//        { sel, match: /…/ }        先頭要素の文言が正規表現に一致（時刻・カウントダウン向け）
//        { sel, count: 3 }          一致する要素の件数
//        { sel, hidden: true }      先頭要素の hidden 属性
//        { sel, contains: ['…'] }   一致する全要素の文言に、指定した語がすべて出てくる
//   4. クリックを挟むなら steps に { name, click, expect, verifyClipboard } を並べる。
//
// 注意: 顧客ドメインは書かない（test/ の書き方に倣い example.com 系を使う）。

// puppeteer-core が無い環境でも Node の生のスタックではなく理由を出したいので、動的 import で受ける。
const { openPanelHarness } = await import('./panel-harness.mjs').catch((e) => {
  console.error('検証ハーネスを読み込めませんでした:', e.message);
  console.error('puppeteer-core が入っていない可能性があります。`npm install` を実行してください。');
  process.exit(1);
});

const log = (...a) => console.log(...a);
const h = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));

const ARTICLE_URL = 'https://media.example.com/news/article-42.html';
const STAGING_URL = 'https://staging.example.com/';

// L1 の出どころアイコンは sidepanel.js が SVG を組み立てる。path の d 先頭で図柄を見分ける。
const ICON = {
  computer: '#origin-icon path[d^="M20 18c1.1"]',
  cloud: '#origin-icon path[d^="M260-160"]',
  host: '#origin-icon path[d^="M160-120"]',
};

/** Fastly エッジ命中（TTL 1時間・キャッシュタグ付き）。 */
const fastlyHitHeaders = h({
  server: 'nginx',
  via: '1.1 varnish',
  'x-served-by': 'cache-nrt-rjtf7700099-NRT',
  'x-cache': 'HIT',
  'x-cache-hits': '1',
  age: '30',
  'cache-control': 'public, max-age=3600',
  'surrogate-key': 'article-42 top news',
  'content-encoding': 'br',
  'content-type': 'text/html; charset=utf-8',
});

const fastlyHit = (now, extra = {}) => ({
  url: ARTICLE_URL,
  statusCode: 200,
  ip: '151.101.1.1',
  fromCache: false,
  receiveTime: now,
  headers: fastlyHitHeaders,
  perf: { ttfbMs: 12, deliveryType: '', responseStatus: 200 },
  stylesheets: [],
  history: [],
  ...extra,
});

/** 同じURLの過去記録（service-worker.js の historyEntry と同じ形）。 */
const historyEntry = (headers, receiveTime, extra = {}) => ({
  url: ARTICLE_URL,
  statusCode: 200,
  ip: '151.101.1.1',
  fromCache: false,
  headers,
  receiveTime,
  perf: null,
  stylesheets: [],
  ...extra,
});

const browserCacheHeaders = (now) => h({
  'cache-control': 'max-age=600',
  date: new Date(now - 60_000).toUTCString(),
  age: '0',
});

const SCENARIOS = [
  {
    name: 'ネットワークキャッシュ（Fastly エッジ命中）',
    tabUrl: ARTICLE_URL,
    record: (now) => fastlyHit(now),
    expect: [
      { sel: '#origin-label', text: 'ネットワークキャッシュ' },
      { sel: '#origin-lead', text: 'ネットワーク上のキャッシュから届きました' },
      { sel: ICON.cloud, count: 1 },
      // 鮮度は1秒ごとに再描画されるカウントダウン。値そのものではなく形で見る。
      { sel: '#fresh-val', match: /^あと59分\d{1,2}秒でキャッシュの期限が切れます$/ },
      { sel: '#speed-val', text: '約12ミリ秒' },
      { sel: '#record-url', text: 'media.example.com' },
      { sel: '#record-time', match: /^\d{2}:\d{2}:\d{2} 取得$/ },
      // L2 の詳細行
      { sel: '#l2-rows .row', count: 8 },
      {
        sel: '#l2-rows .row',
        contains: [
          '正式名共有キャッシュ（CDN）',
          'ネットワークの種類Fastly',
          '最寄りの拠点東京（NRT）',
          '返ってきた場所エッジ（あなたに最も近いキャッシュ）から返されました',
          'キャッシュの切れ方時間式（最大 約1時間で期限切れ） ＋ タグ式（きっかけで個別にクリア）',
        ],
      },
      // キャッシュタグの名札
      { sel: '#l2-rows .tag', count: 3 },
      { sel: '#l2-rows .tag', contains: ['article-42', 'top', 'news'] },
      { sel: '#l2-terms .term', count: 8 },
      // L3 生ヘッダー表: 10ヘッダー ＋ CDN 見出し行1
      { sel: '#raw-table tr', count: 11 },
      { sel: '#raw-table .raw-subtitle', text: 'CDN・中継キャッシュのヘッダー' },
      { sel: '#raw-table', contains: ['x-served-by', 'cache-nrt-rjtf7700099-NRT', 'surrogate-key'] },
      // 値の読み下し（content-encoding: br）
      { sel: '.raw-gloss', count: 1 },
      { sel: '.raw-gloss', text: 'br＝Brotli' },
      // 解説はカテゴリ別にまとめて出る
      { sel: '.raw-note-group', count: 5 },
      { sel: '.raw-note-heading', contains: ['標準', '中継キャッシュ', 'CDN共通', 'Fastly独自', '一般'] },
      { sel: '.raw-note', contains: ['age —', 'x-cache —', 'x-served-by —'] },
      // notice はどちらも出ない
      { sel: '#route-notice', hidden: true },
      { sel: '#invalidation-notice', hidden: true },
      // 記録は1件だけ
      { sel: '#view-tabs .view-tab:not([hidden])', count: 1 },
      { sel: '#view-tabs .view-tab:not([hidden])', text: '現在' },
      // Fastly なので上級者向けブロックは出る。詳細ヘッダーは届いていないので印は出ない。
      { sel: '#advanced', hidden: false },
      { sel: '#debug-flag', hidden: true },
      { sel: '#debug-domains', hidden: true },
    ],
  },

  {
    name: 'ブラウザキャッシュ（速さは測定中）',
    tabUrl: 'https://staging.example.com/dashboard',
    record: (now) => ({
      url: 'https://staging.example.com/dashboard',
      statusCode: 200,
      ip: '',
      fromCache: true,
      receiveTime: now,
      headers: browserCacheHeaders(now),
      stylesheets: [],
      history: [],
    }),
    expect: [
      { sel: '#origin-label', text: 'ブラウザキャッシュ' },
      { sel: ICON.computer, count: 1 },
      { sel: '#fresh-val', match: /^あと\d{1,2}分\d{1,2}秒でキャッシュの期限が切れます$/ },
      // perf（Navigation Timing）が無いあいだは薄色のプレースホルダで枠を保つ
      { sel: '#speed-val', text: '測定中…' },
      { sel: '#speed-val.measuring', count: 1 },
      { sel: '#l2-rows .row', contains: ['正式名private cache（端末内のキャッシュ）'] },
      // Fastly ではないので上級者向けブロックは隠れる
      { sel: '#advanced', hidden: true },
    ],
  },

  {
    name: 'サーバー（作りたて）＋ URLだけ変わった注意書き',
    // タブのURLと記録のURLがずれている＝ページ内で URL だけ書き換わった状態
    tabUrl: 'https://staging.example.com/products/42',
    record: (now) => ({
      url: STAGING_URL,
      statusCode: 200,
      ip: '203.0.113.10',
      fromCache: false,
      receiveTime: now,
      headers: h({ server: 'nginx', 'cache-control': 'no-store', date: new Date(now).toUTCString() }),
      perf: { ttfbMs: 240 },
      stylesheets: [],
      history: [],
    }),
    expect: [
      { sel: '#origin-label', text: 'サーバー（作りたて）' },
      { sel: ICON.host, count: 1 },
      { sel: '#fresh-val', text: 'このページは毎回新しく読み込む設定です（キャッシュを残しません）' },
      { sel: '#speed-val', text: '約240ミリ秒' },
      { sel: '#route-notice', hidden: false },
      { sel: '#route-notice', contains: ['ページ内でURLだけが変わっています'] },
      { sel: '#invalidation-notice', hidden: true },
    ],
  },

  {
    name: '無効化（パージ）の形跡',
    // HIT で配られているのに命中回数が 0、しかも Age > 0。正常系では作れない組み合わせ。
    tabUrl: ARTICLE_URL,
    record: (now) => ({
      url: ARTICLE_URL,
      statusCode: 200,
      ip: '151.101.1.1',
      fromCache: false,
      receiveTime: now,
      headers: h({
        via: '1.1 varnish',
        'x-served-by': 'cache-nrt-rjtf7700099-NRT',
        'x-cache': 'HIT',
        'x-cache-hits': '0',
        age: '30',
        'cache-control': 'public, max-age=3600',
      }),
      stylesheets: [],
      history: [],
    }),
    expect: [
      { sel: '#origin-label', text: 'ネットワークキャッシュ' },
      { sel: '#invalidation-notice', hidden: false },
      {
        sel: '#invalidation-notice',
        contains: ['無効化（パージ）された形跡があります', '再読み込みすると、新しい版になったか確認できます'],
      },
      { sel: '#route-notice', hidden: true },
    ],
  },

  {
    name: '記録タブ（最大5件・切り替え）',
    tabUrl: ARTICLE_URL,
    // 過去記録を6件与えても、表示は5件で頭打ちになる（RECORD_LABELS の件数が正）
    record: (now) =>
      fastlyHit(now, {
        history: [
          historyEntry(browserCacheHeaders(now - 10_000), now - 10_000, { fromCache: true, ip: '' }),
          historyEntry(fastlyHitHeaders, now - 20_000),
          historyEntry(fastlyHitHeaders, now - 30_000),
          historyEntry(fastlyHitHeaders, now - 40_000),
          historyEntry(fastlyHitHeaders, now - 50_000),
          historyEntry(fastlyHitHeaders, now - 60_000),
        ],
      }),
    expect: [
      { sel: '#view-tabs .view-tab:not([hidden])', count: 5 },
      {
        sel: '#view-tabs .view-tab:not([hidden])',
        contains: ['現在', '前回', '前々回', '3つ前', '4つ前'],
      },
      { sel: '#view-tabs .view-tab.active', count: 1 },
      { sel: '#view-tabs .view-tab.active', text: '現在' },
      { sel: '#origin-label', text: 'ネットワークキャッシュ' },
    ],
    steps: [
      {
        name: '「前回」に切り替える',
        click: '#view-tabs .view-tab:nth-child(2)',
        expect: [
          { sel: '#view-tabs .view-tab.active', text: '前回' },
          { sel: '#origin-label', text: 'ブラウザキャッシュ' },
          { sel: ICON.computer, count: 1 },
          // 過去の記録を見ているあいだは、現在タブ向けの表示を出さない
          { sel: '#advanced', hidden: true },
          { sel: '#route-notice', hidden: true },
        ],
      },
      {
        name: '「現在」に戻す',
        click: '#view-tabs .view-tab:nth-child(1)',
        expect: [
          { sel: '#view-tabs .view-tab.active', text: '現在' },
          { sel: '#origin-label', text: 'ネットワークキャッシュ' },
          { sel: '#advanced', hidden: false },
        ],
      },
    ],
  },

  {
    name: 'コピー2種（エンジニア向け／AI向け）',
    tabUrl: ARTICLE_URL,
    record: (now) =>
      fastlyHit(now, {
        history: [historyEntry(fastlyHitHeaders, now - 20_000), historyEntry(fastlyHitHeaders, now - 40_000)],
      }),
    expect: [{ sel: '#view-tabs .view-tab:not([hidden])', count: 3 }],
    steps: [
      {
        name: 'エンジニアに渡す（生ヘッダー）',
        click: '#copy-headers',
        expect: [
          { sel: '#copy-status', hidden: false },
          { sel: '#copy-status', text: 'レスポンスヘッダーを 3件コピーしました' },
        ],
        verifyClipboard: (clips) => {
          const failures = [];
          if (clips.length !== 1) return [`コピー内容の件数\n      期待: 1件\n      実際: ${clips.length}件`];
          const text = clips[0];
          for (const needle of [
            'カーシュ・カーシュ 現在: ネットワークキャッシュ',
            'カーシュ・カーシュ 前々回: ネットワークキャッシュ',
            ARTICLE_URL,
            'x-cache: HIT',
            'surrogate-key: article-42 top news',
          ]) {
            if (!text.includes(needle)) failures.push(`コピー内容\n      期待: ${JSON.stringify(needle)} を含む\n      実際: 含まれていません`);
          }
          return failures;
        },
      },
      {
        name: 'AIに渡す（JSON）',
        click: '#copy-agent',
        expect: [{ sel: '#copy-status', text: 'AIに渡す形で 3件コピーしました' }],
        verifyClipboard: (clips) => {
          const failures = [];
          if (clips.length !== 2) return [`コピー内容の件数\n      期待: 2件\n      実際: ${clips.length}件`];
          const text = clips[1];
          if (!text.startsWith('# カーシュ・カーシュ: キャッシュ観測記録（AI向け）')) {
            failures.push(`AI向けコピーの見出し\n      期待: 「# カーシュ・カーシュ: キャッシュ観測記録（AI向け）」で始まる\n      実際: ${JSON.stringify(text.slice(0, 60))}`);
          }
          const fenced = text.match(/```json\n([\s\S]*?)\n```/);
          if (!fenced) return [...failures, 'AI向けコピー\n      期待: ```json ブロックを含む\n      実際: 見つかりません'];
          let report;
          try {
            report = JSON.parse(fenced[1]);
          } catch (e) {
            return [...failures, `AI向けコピーの JSON\n      期待: JSON.parse できる\n      実際: ${e.message}`];
          }
          const checks = [
            ['tool', report.tool, 'cache-cache'],
            ['url', report.url, ARTICLE_URL],
            ['recordCount', report.recordCount, 3],
            ['records.length', report.records?.length, 3],
            ['transitions.length', report.transitions?.length, 2],
            // records は古い順。最後が「現在」。
            ['records[2].label', report.records?.[2]?.label, '現在'],
            ['records[2].verdict', report.records?.[2]?.verdict, 'ネットワークキャッシュ'],
            ['records[2].observed.headers["x-cache"]', report.records?.[2]?.observed?.headers?.['x-cache'], 'HIT'],
          ];
          for (const [path, actual, expected] of checks) {
            if (actual !== expected) {
              failures.push(`AI向けコピーの ${path}\n      期待: ${JSON.stringify(expected)}\n      実際: ${JSON.stringify(actual)}`);
            }
          }
          return failures;
        },
      },
    ],
  },

  {
    name: 'Fastly-Debug（詳細ヘッダー到達 ＋ ドメイン登録）',
    tabUrl: ARTICLE_URL,
    debugDomains: ['media.example.com'],
    record: (now) => ({
      url: ARTICLE_URL,
      statusCode: 200,
      ip: '151.101.1.1',
      fromCache: false,
      receiveTime: now,
      headers: h({
        via: '1.1 varnish',
        'x-served-by': 'cache-nrt-rjtf7700099-NRT',
        'x-cache': 'HIT',
        'x-cache-hits': '4',
        age: '30',
        'surrogate-control': 'max-age=86400',
        'surrogate-key': 'article-42 top',
        'fastly-debug-ttl': '(H cache-nrt-rjtf7700099-NRT 86370.000 0.000 30)',
        'fastly-debug-path': '(D cache-nrt-rjtf7700099-NRT 1781845958)',
      }),
      stylesheets: [],
      history: [],
    }),
    expect: [
      { sel: '#origin-label', text: 'ネットワークキャッシュ' },
      { sel: '#fresh-val', text: 'あと約1日でキャッシュの期限が切れます' },
      // 印は「設定したか」ではなく「詳細ヘッダーが実際に届いたか」で出る
      { sel: '#debug-flag', hidden: false },
      { sel: '#advanced', hidden: false },
      // 登録ドメインなので、タブ単位のトグルは実態（有効）を映して固定される
      { sel: '#debug-toggle:checked', count: 1 },
      { sel: '#debug-toggle:disabled', count: 1 },
      { sel: '#debug-domain:checked', count: 1 },
      { sel: '#debug-status', hidden: false },
      { sel: '#debug-status', text: '有効です。このサイトから詳細ヘッダーが届いています。' },
      { sel: '#debug-status.ok', count: 1 },
      { sel: '#debug-domains', hidden: false },
      { sel: '.domain-chip', count: 1 },
      { sel: '.domain-chip', contains: ['media.example.com'] },
      { sel: '#l2-rows .tag', count: 2 },
    ],
    steps: [
      {
        // 「×」は Service Worker への往復（cc-set-debug-domain）。SW が動くかもここで見る。
        name: '登録を「×」で解除する',
        click: '.domain-chip .domain-remove',
        expect: [
          { sel: '.domain-chip', count: 0 },
          { sel: '#debug-domains', hidden: true },
          { sel: '#debug-toggle:checked', count: 0 },
          { sel: '#debug-toggle:disabled', count: 0 },
          { sel: '#debug-status', hidden: true },
        ],
      },
    ],
  },

  {
    name: 'Fastly-Debug（親ドメインの登録に巻き取られている）',
    tabUrl: 'https://staging.example.com/news/',
    debugDomains: ['example.com'],
    record: (now) => ({
      url: 'https://staging.example.com/news/',
      statusCode: 200,
      ip: '151.101.1.1',
      fromCache: false,
      receiveTime: now,
      headers: h({
        via: '1.1 varnish',
        'x-served-by': 'cache-nrt-rjtf7700099-NRT',
        'x-cache': 'HIT',
        'x-cache-hits': '1',
        age: '30',
        'cache-control': 'public, max-age=3600',
      }),
      stylesheets: [],
      history: [],
    }),
    expect: [
      { sel: '#debug-domain-label', text: 'example.com が登録済みのため、このドメインでも常に有効です' },
      // ここのチェックを外しても解除できないので触らせない
      { sel: '#debug-domain:disabled', count: 1 },
      { sel: '#debug-domain:checked', count: 1 },
      // 詳細ヘッダーは届いていないので、有効化しても「返っていない」と正直に出す
      { sel: '#debug-status', hidden: false },
      { sel: '#debug-status', contains: ['このサイトからは詳細ヘッダーが返っていません'] },
      { sel: '#debug-status.ok', count: 0 },
      { sel: '#debug-flag', hidden: true },
      { sel: '.domain-chip', count: 1 },
      { sel: '.domain-chip', contains: ['example.com'] },
    ],
  },
];

// ---- 実行 ----
const SHOT_DIR = '/tmp';

let harness;
try {
  harness = await openPanelHarness({ onLog: log });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

log(`拡張ロード OK / ID: ${harness.extensionId}`);
log('');

let passed = 0;
const failedScenarios = [];

try {
  for (const scenario of SCENARIOS) {
    const errorsBefore = harness.pageErrors.length;
    const failures = [];
    try {
      await harness.prepare({
        tabUrl: scenario.tabUrl,
        record: scenario.record(Date.now()),
        debugDomains: scenario.debugDomains || [],
      });
      failures.push(...(await harness.check(scenario.expect)));

      for (const step of scenario.steps || []) {
        await harness.click(step.click);
        const stepFailures = await harness.check(step.expect || []);
        if (step.verifyClipboard) stepFailures.push(...step.verifyClipboard(await harness.clipboard()));
        failures.push(...stepFailures.map((f) => `［${step.name}］${f}`));
      }
    } catch (e) {
      failures.push(`実行エラー\n      ${e.message}`);
    }

    const newPageErrors = harness.pageErrors.slice(errorsBefore);
    for (const err of newPageErrors) failures.push(`パネル側のコンソールエラー\n      ${err}`);

    if (failures.length) {
      failedScenarios.push(scenario.name);
      log(`✗ ${scenario.name}`);
      for (const f of failures) log(`    - ${f}`);
      const shot = `${SHOT_DIR}/cc-panel-fail-${failedScenarios.length}.png`;
      await harness.screenshot(shot);
      log(`    （そのときの画面: ${shot}）`);
    } else {
      passed += 1;
      log(`✓ ${scenario.name}`);
    }
  }

  log('');
  log(`シナリオ: ${passed}/${SCENARIOS.length} 合格`);

  // ④ Service Worker のコンソール。監視できた SW の数も出す（0 なら「エラー無し」は何も言っていない）。
  const swScope = `監視できた SW ${harness.swAttached.length}個 / 受け取ったログ ${harness.swLogs.length}件`;
  if (harness.swErrors.length) {
    log(`Service Worker: エラー ${harness.swErrors.length}件（${swScope}）`);
    for (const e of harness.swErrors) log(`    - ${e}`);
  } else if (!harness.swAttached.length) {
    log('Service Worker: 監視できませんでした（SW が一度も起動していない可能性。エラーの有無は不明）');
  } else {
    log(`Service Worker: エラー無し（${swScope}）`);
  }
  if (harness.swWarnings.length) {
    log(`Service Worker: 警告 ${harness.swWarnings.length}件（失敗扱いにはしない）`);
    for (const w of harness.swWarnings) log(`    - ${w}`);
  }

  if (failedScenarios.length || harness.swErrors.length) {
    log('');
    if (failedScenarios.length) log(`失敗したシナリオ: ${failedScenarios.join(' / ')}`);
    process.exitCode = 1;
  }
} finally {
  await harness.close();
}
