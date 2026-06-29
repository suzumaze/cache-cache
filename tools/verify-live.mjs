// ライブ検証: 実サイトの生レスポンスヘッダーを curl で取得し、拡張UIと同一の
// present(classify(recordToInput(...))) パイプラインに通して、実出力を表示する。
// 使い方: node tools/verify-live.mjs [URL]
import { execSync } from 'node:child_process';
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';

const url = process.argv[2] || process.env.VERIFY_URL || 'https://www.fastly.com/jp/';

function fetchHeaders(u) {
  const out = execSync(`curl -sS -D - -o /dev/null --max-time 12 ${JSON.stringify(u)}`, { encoding: 'utf8' });
  const blocks = out.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//m.test(b));
  const last = blocks[blocks.length - 1] || out;
  const lines = last.split(/\r?\n/).filter(Boolean);
  const statusLine = lines.shift() || '';
  const statusCode = parseInt((statusLine.match(/\s(\d{3})(?:\s|$)/) || [])[1], 10) || null;
  const headers = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return { headers, statusCode };
}

const { headers, statusCode } = fetchHeaders(url);
const now = Date.now();
// 実Chrome の webRequest 相当: ネットワーク到達なので ip あり・fromCache false。
// 速さ(ttfbMs)は content script(Performance API)由来のため、このハーネスでは N/A。
const v = classify({ headers, statusCode, ip: '151.101.0.1', fromCache: false, receiveTime: now, now });
const p = present(v);

console.log(`\n=== ${url}  (HTTP ${statusCode}) ===`);
console.log('--- L1（要点） ---');
console.log('  出どころ :', p.l1.icon, p.l1.label);
console.log('  説明     :', p.l1.lead);
console.log('  鮮度     :', p.l1.freshness);
console.log('  速さ     :', p.l1.speed ?? '(このハーネスではN/A: 実拡張はPerformance APIで取得)');
console.log('  バッジ   :', p.badge.text, p.badge.color);
console.log('--- L2（詳細） ---');
for (const r of p.l2.rows) console.log('  ', r.label + '：', r.value, r.note ? `（${r.note}）` : '');
if (p.l2.terms.length) {
  console.log('--- 用語補足 ---');
  for (const t of p.l2.terms) console.log('  ', t.term + '：' + t.def);
}
console.log('--- キャッシュ関連の生ヘッダー ---');
for (const h of headers) {
  if (/^(x-cache|x-served-by|x-cache-hits|age|via|vary|x-timer|cache-control|surrogate-control|cf-cache-status|x-amz-cf|server|date|expires)/i.test(h.name)) {
    console.log('  ', h.name + ':', h.value);
  }
}
