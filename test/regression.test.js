// レビュー（4観点・敵対的検証）で確定した不具合の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.js';
import { present } from '../lib/present.js';
import { freshness } from '../lib/freshness.js';
import { parseFastly } from '../lib/fastly.js';
import { toHeaderMap, ccHas } from '../lib/headers.js';
import { formatMsJa } from '../lib/format.js';
import { h, input, FIXTURES } from './fixtures.js';

const map = (obj) => toHeaderMap(h(obj));

// spec-0 / mv3-1 / ux-4: 作りたて応答に「控え」「切り替わります」と出さない
test('作りたて + max-age大 → 「今ご覧のものが最新です」（控え表現を出さない）', () => {
  const v = classify(input(h({ server: 'nginx', 'cache-control': 'private, max-age=100000', date: 'Fri, 19 Jun 2026 12:00:00 GMT', age: '0' })));
  assert.equal(v.origin.state, 'server');
  assert.equal(v.server.kind, 'fresh');
  const p = present(v);
  assert.equal(p.l1.freshness, '今ご覧のものが最新です');
  assert.doesNotMatch(p.l1.freshness, /控え|切り替わります/);
});

// spec-2: no-cache + max-age を「あとX秒で…」と誤算定しない
test('no-cache + max-age → 鮮度は不明扱い（カウントダウンしない）', () => {
  const f = freshness(map({ 'cache-control': 'no-cache, max-age=600', age: '0' }), { now: 0, receiveTime: 0 });
  assert.equal(f.mode, 'unknown');
  const v = classify(input(h({ server: 'nginx', 'cache-control': 'no-cache, max-age=600', age: '0' })));
  assert.equal(v.server.kind, 'fresh');
  assert.equal(present(v).l1.freshness, '今ご覧のものが最新です');
});

// logic-0 / ux-1: 期限切れ控えに「あと約0秒で…」と出さない
// FB(2026-06-23): Surrogate-Control 不可視の network 期限切れは、CDN内部の実効期限が見えないため
// stale と断定せず両論併記する（Fastly公式裏取り済み：Surrogate-Control は応答前に除去される）
test('ネットワークの期限切れ(Surrogate不可視) → stale断定せず両論併記', () => {
  const v = classify(input(h({
    via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT',
    'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1', 'cache-control': 'public, max-age=60', age: '3600',
  })));
  assert.equal(v.origin.state, 'network');
  assert.equal(v.freshness.mode, 'countdown');
  assert.equal(v.freshness.remainingSec, 0);
  const p = present(v);
  assert.match(p.l1.freshness, /断定できません/);
  assert.doesNotMatch(p.l1.freshness, /期限切れのキャッシュが届いています/);
  assert.doesNotMatch(p.l1.freshness, /約0秒/);
  assert.doesNotMatch(p.l1.freshness, /次の読み込みで取り直します/);
});

// ux-0: CDN不明の network で「CDN」と断定しない
test('汎用プロキシ命中 → 正式名は「CDN」と断定しない', () => {
  const p = present(classify(FIXTURES.genericProxyHit));
  const formal = p.l2.rows.find((r) => r.label === '正式名');
  assert.equal(formal.value, '共有キャッシュ（中継・提供元は不明）');
  assert.match(p.l1.lead, /提供元までは特定できませんでした/);
});

// logic-2: x-served-by が1POPだけなら（x-cache が MISS,HIT でも）別拠点のシールドと断定しない。
// 2つ目の HIT の POP が不明で、同一POP内クラスタリングの可能性を排除できないため（原則3）。
test('Fastly x-served-by が1POPだけなら shield と断定しない', () => {
  const f = parseFastly(map({ 'x-served-by': 'cache-nrt-a-NRT', 'x-cache': 'MISS, HIT' }));
  assert.equal(f.hit, true);
  assert.equal(f.servedAt, 'edge');
  assert.equal(f.pop.code, 'NRT');
  assert.equal(f.pops, 1);
});

// logic-1: ccHas が修飾付き no-cache="..." を検出
test('ccHas は no-cache="field" / private="field" を検出する', () => {
  assert.equal(ccHas('no-cache="set-cookie"', 'no-cache'), true);
  assert.equal(ccHas('private="x"', 'private'), true);
  assert.equal(ccHas('no-cacheable', 'no-cache'), false);
  assert.equal(ccHas('max-age=0', 'no-store'), false);
});

// ux-2: formatMsJa の境界で「約1000ミリ秒」を出さない
test('formatMsJa(999.6) は秒表記になる', () => {
  const s = formatMsJa(999.6);
  assert.doesNotMatch(s, /ミリ秒/);
  assert.match(s, /秒/);
});

// mv3-2: CloudFront / Akamai でも L2「キャッシュ判定」が生値で出る
test('CloudFront / Akamai でも L2 にキャッシュ判定（生値）が出る', () => {
  const cf = present(classify(FIXTURES.cloudfrontHit)).l2.rows.find((r) => r.label === 'キャッシュ判定');
  assert.ok(cf && /cloudfront/i.test(cf.value));
  const ak = present(classify(FIXTURES.akamaiHit)).l2.rows.find((r) => r.label === 'キャッシュ判定');
  assert.ok(ak && /TCP_HIT/i.test(ak.value));
});

// spec-4: 出どころ不明なら鮮度行を出さない
test('出どころ特定不能なら鮮度行は出さない', () => {
  assert.equal(present(classify(FIXTURES.noSignal)).l1.freshness, null);
});

// ux-9: 速さは値のみ（チップキー「速さ」と重複させない）
test('速さは値のみ（「表示までの速さ」を値に含めない）', () => {
  const p = present(classify(FIXTURES.fastlyShieldTokyo));
  assert.doesNotMatch(p.l1.speed, /表示までの速さ/);
  assert.match(p.l1.speed, /ミリ秒/);
});

// 304 再確認 → 最新確認済み表示
test('ブラウザ再確認(304) → 「確認済み」表示', () => {
  assert.match(present(classify(FIXTURES.browserRevalidated)).l1.freshness, /確認済み/);
});

// FB追補: 異なるPOPを2つまたぐと「あり」、単一POP(エッジHIT/POP内クラスタリング)では断定せず「確認できません」
test('Fastly 別POP2段 → シールドはあり', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-kix-a-KIX, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1' })));
  const shield = present(v).l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /あり/);
});
test('Fastly 同一POP2ノード(クラスタリング) → シールドは確認できません', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1' })));
  const shield = present(v).l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /確認できません/);
});
test('Fastly 1段(エッジHIT) → シールドは今回は確認できません', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT', 'x-cache': 'HIT', 'x-cache-hits': '1' })));
  assert.equal(v.cdn.name, 'Fastly');
  const shield = present(v).l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /確認できません/);
});
// エッジ側の同一POPクラスタリング(SJC,SJC)は1段に畳み、別POP(NRT)を足して「2段」。
// 命中は SJC の fetch ノード＝エッジ。ノード数(3)ではなく POP 数(2)で数える。
test('Fastly エッジ側クラスタ＋別シールド → POP数で2段・エッジ命中', () => {
  const v = classify(input(h({
    via: '1.1 varnish',
    'x-served-by': 'cache-sjc-a-SJC, cache-sjc-b-SJC, cache-nrt-c-NRT',
    'x-cache': 'MISS, HIT, HIT',
    'x-cache-hits': '0, 3, 1',
  })));
  const p = present(v);
  const shield = p.l2.rows.find((r) => r.label === 'シールド');
  assert.match(shield.value, /エッジ→シールドの2段/);
  const served = p.l2.rows.find((r) => r.label === '返ってきた場所');
  assert.match(served.value, /エッジ/);
  assert.doesNotMatch(served.value, /シールド/);
});

// #6: 切れ方は TTL/タグの手がかりがあるときだけ出す（無ければ断定せず黙る・ノイズ回避）
test('Surrogate-Key あり → 切れ方にタグ式が出る', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'surrogate-key': 'product-1 catalog' })));
  const row = present(v).l2.rows.find((r) => r.label === 'キャッシュの切れ方');
  assert.ok(row && /タグ式/.test(row.value));
});
test('TTL・タグとも手がかり無し → 切れ方行は出さない', () => {
  const row = present(classify(FIXTURES.fastlyShieldTokyo)).l2.rows.find((r) => r.label === 'キャッシュの切れ方');
  assert.equal(row, undefined);
});

// FB再調整: Vary は「見る人で変わる」軸だけ表示。Accept-Encoding のみなら行を出さない
test('Vary が Accept-Encoding のみ → 条件別キャッシュ行は出さない', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT', 'x-cache': 'HIT', vary: 'Accept-Encoding' })));
  const row = present(v).l2.rows.find((r) => r.label === '条件別キャッシュ（Vary）');
  assert.equal(row, undefined);
});
test('Vary に端末種別 → 条件別キャッシュ行が出る（圧縮方式は除外）', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT', 'x-cache': 'HIT', vary: 'X-Device-Type, Accept-Encoding' })));
  const row = present(v).l2.rows.find((r) => r.label === '条件別キャッシュ（Vary）');
  assert.ok(row);
  assert.match(row.value, /端末の種類/);
  assert.doesNotMatch(row.value, /圧縮方式/);
});

// FB(2026-06-23): Surrogate-Control 不可視の network 期限切れは「期限切れからの経過」を断定せず判定保留に
test('ネットワークの期限切れ(Surrogate不可視) → 判定保留行（経過時間は断定しない）', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1', 'cache-control': 'public, max-age=60', age: '3600' })));
  const p = present(v);
  assert.equal(p.l2.rows.find((r) => r.label === '期限切れからの経過'), undefined, '断定的な経過行は出さない');
  const hold = p.l2.rows.find((r) => r.label === 'ネットワーク側の鮮度');
  assert.ok(hold && /判定保留/.test(hold.value), '判定保留行が出る');
  assert.ok(p.l2.terms.some((t) => t.term === 'Surrogate-Control'), 'Surrogate-Control 用語補足が出る');
});

// FB(2026-06-23): Surrogate-Control が見えて、その実効期限も超過していれば stale と断定し経過時間を出す
test('ネットワークの期限切れ(Surrogate可視で超過) → stale断定と経過時間が出る', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1', 'surrogate-control': 'max-age=300', 'cache-control': 'public, max-age=60', age: '3600' })));
  assert.equal(v.origin.state, 'network');
  assert.equal(v.freshness.lifetimeSec, 300, 'freshness は Surrogate-Control を実効期限に使う');
  const p = present(v);
  assert.match(p.l1.freshness, /期限切れのキャッシュが届いています/);
  const overdue = p.l2.rows.find((r) => r.label === '期限切れからの経過');
  assert.ok(overdue, '期限切れからの経過 行が出る');
  assert.ok(p.l2.terms.some((t) => t.term === 'stale'), 'stale 用語補足が出る');
});

// 実機(2026-06-23)で方針更新: ブラウザキャッシュが期限切れ(stale)で配信された＝ブラウザは stale を
// そのまま使わず再検証(304)して使った。「次の読み込みで取り直します」ではなく再確認あり扱いにする。
test('ブラウザキャッシュの期限切れ(fromCache) → 再検証済み（再確認あり）', () => {
  const v = classify(input(h({ 'cache-control': 'max-age=60', age: '3600' }), { fromCache: true, ip: '' }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
  const p = present(v);
  assert.match(p.l1.freshness, /確認済み/);
  assert.doesNotMatch(p.l1.freshness, /次の読み込みで取り直します/);
});

// #6: キャッシュの切れ方（TTL=時間式）を最大期間つきでL2に出す
test('L2 「キャッシュの切れ方」に時間式（最大）が出る', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1', 'cache-control': 'public, max-age=300', age: '60' })));
  const row = present(v).l2.rows.find((r) => r.label === 'キャッシュの切れ方');
  assert.ok(row);
  assert.match(row.value, /時間式/);
  assert.match(row.value, /最大/);
  assert.match(row.value, /5分/);
});

// fromCache:false なら（CDN HITヘッダーがあっても）本体はネットワーク由来＝ネットワーク扱い。
// fromCache の有無でブラウザキャッシュと取り違えない（誤検出を防ぐ）。
test('fromCache:false + CDN HIT → ネットワーク扱い', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-rjtt7900083-NRT', 'x-cache': 'HIT', 'x-cache-hits': '1', age: '5', 'cache-control': 'max-age=120' }), { fromCache: false, statusCode: 200, ip: '199.232.150.132' }));
  assert.equal(v.origin.state, 'network');
});

// 実機(2026-06-23): fromCache:true なら ip が入っていても（CDN由来ヘッダーが残っていても）ブラウザ
// キャッシュ。旧 `!ip` 条件は ip 付きの fromCache を弾いて x-cache:HIT を network と誤判定していた。
// 条件付きGETを送っていなければ再確認なし。
test('fromCache:true + ip + CDNヘッダー → ブラウザキャッシュ(再確認なし)、network誤判定しない', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-rjtt7900083-NRT', 'x-cache': 'HIT', 'x-cache-hits': '3', age: '74', 'cache-control': 'max-age=120' }), { fromCache: true, statusCode: 200, ip: '146.75.114.132' }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, false);
  assert.equal(v.cdn, null, 'CDN(エッジ等)は判定しない');
  const p = present(v);
  assert.match(p.l1.label, /ブラウザキャッシュ/);
  assert.doesNotMatch(p.l1.label, /再確認あり/);
  assert.equal(p.l2.rows.find((r) => r.label === '受信ステータス'), undefined, 'ブラウザキャッシュでは受信ステータスを出さない');
});

// 実機(2026-06-23): fromCache:true で期限切れ(stale)＝ブラウザはstaleをそのまま使わず再検証(304)して
// 使ったと推論し、再確認あり扱い。webRequestはif-modified-sinceを渡さず304も200に統合する（DevTools=304
// でも webRequest からは観測できない）ため、staleなブラウザキャッシュ配信が再検証の状況証拠になる。
test('fromCache:true + 期限切れ(stale) → ブラウザキャッシュ(再確認あり)と推論', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-rjtt7900083-NRT', 'x-cache': 'HIT', age: '134', 'cache-control': 'max-age=120' }), { fromCache: true, statusCode: 200, ip: '146.75.114.132' }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
  const p = present(v);
  assert.match(p.l1.label, /再確認あり/);
  assert.match(p.l1.freshness, /確認済み/);
});

// Cmd+R 等の強制再検証では、期限内のキャッシュでも 304 になることがある。webRequest は 200 に
// 統合するが、Resource Timing の validated cache は transferSize=300 として観測できる。
test('fromCache:true + transferSize=300 → 期限内でも再確認あり', () => {
  const v = classify(input(h({ 'cache-control': 'max-age=3600', age: '10' }), {
    fromCache: true,
    statusCode: 200,
    ip: '146.75.114.132',
    deliveryType: 'cache',
    transferSize: 300,
    encodedBodySize: 12000,
  }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
  assert.match(present(v).l1.label, /再確認あり/);
});

test('ブラウザ再確認あり → L2 に最新確認と確認先の手がかりが出る', () => {
  const v = classify(input(h({
    via: '1.1 varnish',
    'x-served-by': 'cache-nrt-a-NRT',
    'x-cache': 'HIT',
    'cache-control': 'max-age=3600',
    age: '10',
  }), {
    fromCache: true,
    statusCode: 200,
    ip: '199.232.150.132',
    deliveryType: 'cache',
    transferSize: 300,
    encodedBodySize: 632584,
  }));
  assert.equal(v.revalidation.name, 'Fastly');
  assert.equal(v.revalidation.ip, '199.232.150.132');
  const rows = present(v).l2.rows;
  const check = rows.find((r) => r.label === '最新確認');
  assert.ok(check);
  assert.match(check.value, /本体は端末内/);
  const target = rows.find((r) => r.label === '確認先の手がかり');
  assert.ok(target);
  assert.match(target.value, /Fastly/);
  assert.match(target.value, /199\.232\.150\.132/);
  assert.match(target.note, /本体の出どころではなく/);
});

test('Performance responseStatus=304 → 再確認あり', () => {
  const v = classify(input(h({ 'cache-control': 'max-age=3600', age: '10' }), {
    fromCache: false,
    statusCode: 200,
    ip: '146.75.114.132',
    deliveryType: 'cache',
    responseStatus: 304,
    transferSize: 300,
  }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
});

// deliveryType=cache は Performance API 側のブラウザキャッシュ根拠。ip が残っていても CDN HIT と
// 誤判定せず、fromCache と同じくブラウザキャッシュを優先する。
test('deliveryType:cache + ip + CDNヘッダー → ブラウザキャッシュ', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-rjtt7900083-NRT', 'x-cache': 'HIT', 'x-cache-hits': '3', age: '10', 'cache-control': 'max-age=120' }), {
    fromCache: false,
    statusCode: 200,
    ip: '146.75.114.132',
    deliveryType: 'cache',
    transferSize: 0,
    encodedBodySize: 12000,
  }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, false);
  assert.equal(v.cdn, null, 'CDNヘッダーはキャッシュされた中身として扱う');
});

// レビュー#1(2026-06-23): s-maxage/Surrogate-Controlは共有キャッシュ専用でブラウザには効かない(RFC9111)。
// ブラウザキャッシュの鮮度は max-age で見る。s-maxage短/max-age長 を「期限切れ→再確認あり」と誤断定しない。
test('ブラウザキャッシュ + s-maxage短/max-age長 → fresh（再確認ありと誤断定しない）', () => {
  const v = classify(input(h({ 'cache-control': 's-maxage=10, max-age=3600', age: '100' }), { fromCache: true, statusCode: 200, ip: '146.75.114.132' }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, false);
  assert.equal(v.freshness.lifetimeSec, 3600, 'private は max-age を実効期限に使う');
  assert.doesNotMatch(present(v).l1.label, /再確認あり/);
});

// レビュー#3(2026-06-23): no-cache は「使う前に必ず再検証」。fromCache配信＝再検証済み＝再確認あり。
test('ブラウザキャッシュ + no-cache → 再確認あり（毎回再検証のため）', () => {
  const v = classify(input(h({ 'cache-control': 'no-cache', age: '30' }), { fromCache: true, statusCode: 200, ip: '146.75.114.132' }));
  assert.equal(v.origin.state, 'browser');
  assert.equal(v.origin.revalidated, true);
  assert.match(present(v).l1.freshness, /確認済み/);
});

// レビュー#4/#5(2026-06-23): Surrogate-Controlが存在しても max-age を持たない(no-store等)なら実効期限は
// Cache-Control由来。lifetimeSource!=='surrogate' なので stale断定せず判定保留にする(偽陽性防止)。
test('network + Surrogate-Control(max-age無し) → stale断定せず判定保留', () => {
  const v = classify(input(h({ via: '1.1 varnish', 'x-served-by': 'cache-nrt-a-NRT, cache-nrt-b-NRT', 'x-cache': 'MISS, HIT', 'x-cache-hits': '0, 1', 'surrogate-control': 'no-store', 'cache-control': 'public, max-age=60', age: '3600' })));
  assert.equal(v.origin.state, 'network');
  assert.equal(v.freshness.lifetimeSource, 'max-age', 'no-store の Surrogate-Control は実効期限に使われない');
  const p = present(v);
  assert.doesNotMatch(p.l1.freshness, /期限切れのキャッシュが届いています/);
  assert.match(p.l1.freshness, /断定できません/);
  assert.equal(p.l2.rows.find((r) => r.label === '期限切れからの経過'), undefined);
  assert.ok(p.l2.rows.find((r) => r.label === 'ネットワーク側の鮮度'), '判定保留行が出る');
});
