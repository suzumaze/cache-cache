// 判定結果(verdict) → 画面表示用のビューモデルへ変換する。
// L1=要点(専門語なし) / L2=詳細＋用語補足 / badge=ツールバー用。文言は SPEC §11 に準拠。
import { formatDurationJa, formatCountdownJa, formatAgoJa, formatMsJa, formatDateTimeJa } from './format.js';

// 色の軸は「出どころのカテゴリ」。緑はネットワーク（CDN）＝配信の動作確認で HIT が期待どおり、
// 赤はサーバーまで抜けた、青はあなたの端末（ローカル。序列の外なので価値中立の色）。
// 既知の割り切り: stale 配信も HIT なので緑が「成功」を含意しすぎる場面がある（board.md 2026-07-21）。
const COLOR = {
  browser: '#2563EB',
  network: '#15803D', // green-700。白文字で4.5:1を確保するため600より一段濃く
  server: '#DC2626',
  unknown: '#6B7280',
};

// バッジは頭文字1字（B=Browser/C=CDN/S=Server/?=不明）。漢字は十数pxで潰れるため
// アルファベットにし、色が判別しづらい人向けの非色チャネルも兼ねる。文字色は白統一
// （緑を#15803Dに濃くした上で、白は全背景 4.5:1 以上: 青4.9/緑4.55/赤4.8/グレー4.8）。
const BADGE_TEXT = '#FFFFFF';

// 用語辞書（L2 で必要な分だけ添える）
const TERMS = {
  'CDN': 'Content Delivery Network。世界各地の拠点から代理で配信する仕組み。',
  '共有キャッシュ': '複数の人で共用される、ネットワーク上のキャッシュ（CDN・プロキシ）。',
  'エッジ': '利用者に最も近いCDNの拠点。',
  'シールド': 'サーバーの手前にいて、アクセス集中からサーバーを守るCDN拠点（盾）。エッジの後ろでキャッシュを集約する。',
  'POP': 'CDNの拠点（Point of Presence）。最寄りの拠点が応答する。',
  'private cache': 'あなたの端末内だけに保存されるキャッシュ。',
  'オリジン': 'サーバー。すべてのキャッシュの元になる場所。',
  'Vary': '条件ごとに別々のキャッシュを作る指定（端末・言語・ログイン状態など）。',
  'stale': '有効期限を過ぎたまま配信されているキャッシュ。ネットワーク側が新しくするまで続くことがある。',
  'Surrogate-Control': 'CDN専用のキャッシュ期限の指定。Fastly等はブラウザへ送る前に削除するため、CDN内部の本当の期限はブラウザからは見えない。',
  '表示までの速さ': '要求してから最初の1バイトが届くまでの実測時間。PageSpeed Insights 等が言う TTFB は名前解決・接続の時間も含むため、同じ「TTFB」でも値が違う。',
  'TTL': 'Time To Live。キャッシュの有効期間（秒）。これを過ぎると期限切れになる「時間式」の指定。',
  'パージ': '時間切れを待たず、狙ったキャッシュを消すこと（イベント式の無効化）。Fastly は Surrogate-Key 単位でできる。',
};

const VARY_LABEL = {
  'accept-encoding': '圧縮方式',
  'x-device-type': '端末の種類',
  'user-agent': 'ブラウザの種類',
  'accept-language': '言語',
  'accept': '受け取り形式',
  'cookie': 'ログイン状態など',
  'origin': '送信元',
  '*': 'すべての条件',
};

function humanizeVary(list) {
  return list.map((t) => VARY_LABEL[t] || t).join('・');
}

const formatPop = (p) => (p.city ? `${p.city}（${p.code}）` : p.code);

// Vary のうち「見る人で内容が変わる」＝ユーザーに意味のある軸。Accept-Encoding（圧縮）など
// ほぼ常駐する技術的ノイズは除外する（圧縮方式だけ示しても対処不能で無意味なため）。
const MEANINGFUL_VARY = new Set(['x-device-type', 'user-agent', 'accept-language', 'cookie', 'accept', 'origin', '*']);

/** 出どころ → L1 の見出し・一文・バッジ */
function originView(v) {
  const st = v.origin.state;
  if (st === 'browser') {
    return v.origin.revalidated
      ? { icon: 'computer', label: 'ブラウザキャッシュ（再確認あり）', lead: 'あなたのパソコンのキャッシュを使い、最新かどうかの確認だけ取りに行きました', badge: { text: 'B', color: COLOR.browser, textColor: BADGE_TEXT } }
      : { icon: 'computer', label: 'ブラウザキャッシュ', lead: 'あなたのパソコンに残っていたキャッシュです（一番速い）', badge: { text: 'B', color: COLOR.browser, textColor: BADGE_TEXT } };
  }
  if (st === 'network') {
    const lead = v.cdn?.name
      ? 'ネットワーク上のキャッシュから届きました'
      : 'ネットワーク上のキャッシュから届いたようです（提供元までは特定できませんでした）';
    return { icon: 'cloud', label: 'ネットワークキャッシュ', lead, badge: { text: 'C', color: COLOR.network, textColor: BADGE_TEXT } };
  }
  if (st === 'server') {
    const k = v.server?.kind;
    if (k === 'server-cache') return { icon: 'host', label: 'サーバー（用意していたキャッシュ）', lead: 'サーバーが用意していたキャッシュから届きました', badge: { text: 'S', color: COLOR.server, textColor: BADGE_TEXT } };
    if (k === 'fresh') return { icon: 'host', label: 'サーバー（作りたて）', lead: 'サーバーがその場で作った最新の内容が届きました', badge: { text: 'S', color: COLOR.server, textColor: BADGE_TEXT } };
    return { icon: 'host', label: 'サーバー', lead: 'サーバーから届きました（その場で作ったか、用意していた控えかまでは分かりませんでした）', badge: { text: 'S', color: COLOR.server, textColor: BADGE_TEXT } };
  }
  return { icon: 'help', label: '特定できませんでした', lead: '今回は出どころを特定できませんでした（再読み込みで分かることがあります）', badge: { text: '?', color: COLOR.unknown, textColor: BADGE_TEXT } };
}

/** 鮮度 → L1 の一文。出どころの状態に応じ、キャッシュ由来でない時はキャッシュ表現・カウントダウンを避ける（原則3）。 */
function freshnessView(v) {
  const f = v.freshness;
  if (!f) return null;
  const st = v.origin.state;
  const kind = v.server?.kind;
  if (st === 'unknown') return null; // 出どころすら不明なら鮮度行は出さない

  // 再確認済み（304）は最新であることが確認できている。
  // 確認先が中間キャッシュ止まりかオリジンまで到達したかは断定しない。
  if (st === 'browser' && v.origin.revalidated) return '最新か確認済みです';

  if (f.mode === 'no-store') return 'このページは毎回新しく読み込む設定です（キャッシュを残しません）';

  const servedFromCache = st === 'browser' || st === 'network' || (st === 'server' && kind === 'server-cache');

  // キャッシュ由来でない（サーバーが今作った／直接届いた）→ キャッシュ表現・カウントダウンを使わない
  if (!servedFromCache) {
    if (st === 'server' && kind === 'fresh') return '今ご覧のものが最新です';
    if (f.ageKnown && f.ageSec >= 1) return `${formatAgoJa(f.ageSec)}に用意されたデータです`;
    return '今ご覧のものが最新です';
  }

  if (f.mode === 'countdown') {
    if (f.remainingSec <= 1) {
      // 期限切れ。出どころで意味が違う。ネットワークキャッシュ(CDN)では、ブラウザに見える有効期限
      // (max-age)を過ぎていても、CDN内部の実効期限(Surrogate-Control)は応答前に除去され見えないため、
      // 本当に古いかは断定できない（両論併記・原則3）。ただし Surrogate-Control が見える(デバッグ時)なら
      // freshness はそれを実効期限に使った上での期限切れ＝実効TTL超過なので stale と断定してよい。
      if (st === 'network') {
        // Surrogate-Control の max-age が実際に実効期限を決めた(lifetimeSource==='surrogate')ときだけ
        // stale 断定できる。それ以外(max-age 由来や、no-store 等で max-age を持たない Surrogate-Control)は
        // CDN内部の実効期限が見えず断定できない（両論併記・原則3）。
        return v.freshness?.lifetimeSource === 'surrogate'
          ? '期限切れのキャッシュが届いています（ネットワーク側が新しくするまで続くことがあります）'
          : 'ブラウザ向けの有効期限は過ぎていますが、ネットワーク側ではまだ最新として配っている可能性もあり、古いかは断定できません';
      }
      return '有効期限が切れています（次の読み込みで取り直します）';
    }
    return `あと${formatCountdownJa(f.remainingSec)}でキャッシュの期限が切れます`;
  }
  if (f.mode === 'created') {
    return f.createdAt ? `${formatDateTimeJa(f.createdAt)}に作られたキャッシュです` : 'しばらく更新されない設定のキャッシュです';
  }
  // mode === 'unknown'（キャッシュ由来）
  if (f.ageKnown) {
    const ago = formatAgoJa(f.ageSec);
    return ago === 'たった今'
      ? 'たった今保存されたキャッシュです（有効期限は非公開）'
      : `${ago}にキャッシュ（有効期限は非公開）`;
  }
  return '有効期限などの情報は見つかりませんでした';
}

/** 出どころ別の「正式名・一言定義」 */
function formalName(v) {
  const st = v.origin.state;
  if (st === 'browser') return { value: 'private cache（端末内のキャッシュ）', term: 'private cache' };
  if (st === 'network') return v.cdn?.name
    ? { value: '共有キャッシュ（CDN）', term: '共有キャッシュ' }
    : { value: '共有キャッシュ（中継・提供元は不明）', term: '共有キャッシュ' };
  if (st === 'server') {
    const k = v.server?.kind;
    if (k === 'server-cache') return { value: 'オリジン側キャッシュ', term: 'オリジン' };
    if (k === 'fresh') return { value: 'オリジンで都度生成', term: 'オリジン' };
    return { value: 'オリジン（内訳は不明）', term: 'オリジン' };
  }
  return null;
}

// HIT/MISS が「どの段で見つかった／見つからなかったか」を説明する。
// 段(tier)は POP 単位（同一POP内のクラスタリングは1段に畳み済み）。エッジ（利用者寄り）→
// シールド（サーバー寄り）の順に並ぶ。
function fastlyStageName(index, total, kind = '拠点') {
  if (index === 0) return `エッジ（あなたに最も近い${kind}）`;
  if (total <= 2) return `シールド（サーバー寄りの${kind}）`;
  if (index === total - 1) return `シールド${index}（サーバー寄りの${kind}）`;
  return `シールド${index}（中間${kind === 'キャッシュ' ? 'の' : ''}${kind}）`;
}

function cacheJudgeNote(v) {
  const tiers = v.cdn?.tiers;
  // 2つ以上の POP をまたぐときだけ段ごとの HIT/MISS を説明する。単一 POP（クラスタリング含む）は
  // 「東京の中で見つかった」等に過ぎず、ノード単位の MISS→HIT を段として提示しない。
  if (tiers?.length >= 2) {
    const total = tiers.length;
    const parts = tiers.map((t, i) => `${fastlyStageName(i, total)}＝${t.hit ? 'HIT（見つかった）' : 'MISS（無かった）'}`);
    let tail;
    if (v.cdn.servedAt === 'shield') tail = `最も近い段には無く、${fastlyStageName(v.cdn.servedTier ?? 1, total)}で見つかりました`;
    else if (v.cdn.servedAt === 'edge') tail = '最も近い段で見つかりました';
    else tail = 'どの段にも無く、サーバーまで取りに行きました';
    return `近い順にキャッシュを探した結果です。${parts.join(' / ')}。${tail}。`;
  }
  return 'HIT＝この拠点にキャッシュがあった／MISS＝無くてサーバーへ取りに行った、を配信側が記録した値です。';
}

export function present(v) {
  const o = originView(v);
  const rows = [];
  const usedTerms = new Set();
  const addTerm = (t) => { if (t && TERMS[t]) usedTerms.add(t); };

  // 正式名
  const fn = formalName(v);
  if (fn) { rows.push({ label: '正式名', value: fn.value }); addTerm(fn.term); }

  if (v.origin.state === 'browser' && v.origin.revalidated) {
    rows.push({
      label: '最新確認',
      value: 'あり（本体は端末内のキャッシュ）',
      note: 'サーバーに最新かどうかだけ確認し、本体はブラウザキャッシュから使いました',
    });
    const signals = [];
    if (v.raw?.responseStatus === 304) signals.push('Performance responseStatus=304');
    if (v.raw?.transferSize === 300) signals.push('Performance transferSize=300');
    if (!signals.length) signals.push('期限切れ/毎回確認の設定から推定');
    rows.push({
      label: '判定の根拠',
      value: signals.join(' / '),
      note: 'If-None-Match などの送信ヘッダーはChromeが拡張に渡さないため、送信内容は表示しません',
    });
    if (v.revalidation) {
      const where = [
        v.revalidation.name || 'ネットワーク経由',
        v.revalidation.pop ? formatPop(v.revalidation.pop) : null,
        v.revalidation.ip || null,
      ].filter(Boolean).join(' / ');
      rows.push({
        label: '確認先の手がかり',
        value: where,
        note: '本体の出どころではなく、最新確認の通信で見えた手がかりです',
      });
      if (v.revalidation.name && v.revalidation.name !== '中継キャッシュ') addTerm('CDN');
      if (v.revalidation.pop) addTerm('POP');
    }
  }

  // CDN / ネットワークの種類
  if (v.cdn?.name) {
    rows.push({ label: 'ネットワークの種類', value: `${v.cdn.name}` });
    addTerm('CDN');
  } else if (v.cdn?.generic) {
    rows.push({ label: 'ネットワークの種類', value: '中継キャッシュ（提供者は不明）' });
  }

  // シールド構成（サーバー寄りの追加キャッシュ）。Fastly のみ。異なる POP を2つ以上またいだ
  // ときだけ「あり」。単一 POP（＝同一拠点。POP内クラスタリングで2ノード見えても地理的には1拠点）
  // ではシールドの有無を断定しない（原則3）。
  if (v.cdn?.name === 'Fastly') {
    rows.push(v.cdn.pops >= 2
      ? { label: 'シールド', value: v.cdn.pops === 2 ? 'あり（エッジ→シールドの2段）' : `あり（エッジ＋シールド${v.cdn.pops - 1}段の${v.cdn.pops}段）`, note: '「シールド」はサーバーの手前でアクセス集中を受け止める、別拠点の共有キャッシュです。異なる拠点（POP）が2つ以上見えたため「あり」と判定しました。' }
      : { label: 'シールド', value: '今回は判定できません', note: '「シールド」はサーバーの手前に置く“別拠点”のキャッシュです。今回は同じ拠点（POP）の中で完結したため、その先にシールドがあるかは分かりません。配信ノードが複数並んでいても、同じ拠点内の負荷分散であれば別拠点のシールドとは限りません。' });
    addTerm('シールド');
  }

  // Fastly: どの段から返ってきたか（エッジ/シールド）。MISS/HIT の段ごとの根拠は note に集約。
  if (v.cdn?.servedAt) {
    const total = v.cdn.pops || 1;
    const servedTier = v.cdn.servedAt === 'edge' ? 0 : (v.cdn.servedTier ?? 1);
    const where = `${fastlyStageName(servedTier, total, 'キャッシュ')}から返されました`;
    rows.push({ label: '返ってきた場所', value: where, note: cacheJudgeNote(v) });
    addTerm(v.cdn.servedAt === 'shield' ? 'シールド' : 'エッジ');
  }

  // 拠点（POP都市）。別拠点のシールドで命中したときだけ「入口（エッジ）」と「命中した拠点」を
  // 分けて示す。同一拠点で完結（エッジ命中／クラスタリング）なら同じ都市の二重表示を避け、入口を1つ示す。
  if (v.cdn?.servedAt === 'shield' && v.cdn?.pop && v.cdn?.edgePop) {
    rows.push({ label: '最寄りの拠点', value: formatPop(v.cdn.edgePop), note: '利用者に最も近い入口' });
    rows.push({ label: '見つかった拠点', value: formatPop(v.cdn.pop), note: '実際にキャッシュがあった拠点' });
    addTerm('POP');
  } else {
    const p = v.cdn?.edgePop || v.cdn?.pop;
    if (p) { rows.push({ label: '最寄りの拠点', value: formatPop(p) }); addTerm('POP'); }
  }

  // HIT/MISS の生値。Fastly（servedAt 判明）は「返ってきた場所」に集約済みなので出さない（重複・難読の解消）。
  // 段が読めない他CDN（CloudFront/Akamai 等）だけ、L2 唯一の命中情報として生値を示す。
  if (!v.cdn?.servedAt) {
    const judgeNote = cacheJudgeNote(v);
    if (v.cdn?.states?.length) rows.push({ label: 'キャッシュ判定', value: v.cdn.states.join(', '), note: judgeNote });
    else if (v.cdn?.status) rows.push({ label: 'キャッシュ判定', value: v.cdn.status, note: judgeNote });
    else if (v.cdn?.xcache) rows.push({ label: 'キャッシュ判定', value: v.cdn.xcache, note: judgeNote });
  }

  // 条件別キャッシュ（Vary）。「見る人で変わる」軸だけ意味がある。圧縮など技術的ノイズは
  // 除外し、残らなければ行ごと出さない。
  const meaningfulVary = (v.vary || []).filter((t) => MEANINGFUL_VARY.has(t));
  if (meaningfulVary.length) {
    rows.push({ label: '条件別キャッシュ（Vary）', value: humanizeVary(meaningfulVary), note: '同じURLでも、見る人の端末や言語などの条件ごとに別々のキャッシュ（鮮度も別）になります' });
    addTerm('Vary');
  }

  // キャッシュの切れ方（無効化方式）を端的に1行で示す。時間式(TTL)＝一定時間で期限切れ／
  // イベント式(タグ=パージ)＝きっかけで個別にクリア。手がかりが無ければ断定せず黙る（原則3）。
  // Surrogate-Key は Fastly が通常ストリップするため、返る（Fastly-Debug 等）ときだけタグ式を示す。
  const ttlSec = v.freshness?.lifetimeSec;
  const hasTtl = ttlSec != null && Number.isFinite(ttlSec) && ttlSec > 0;
  const tags = v.tags || [];
  const hasSurrogateKey = tags.length > 0;
  if (hasTtl || hasSurrogateKey) {
    const ttlPart = hasTtl ? `時間式（最大 ${formatDurationJa(ttlSec)}で期限切れ）` : '';
    const tagPart = hasSurrogateKey ? 'タグ式（きっかけで個別にクリア）' : '';
    const note = hasTtl && hasSurrogateKey
      ? '時間でも切れ、特定のキャッシュだけ狙った無効化（パージ）にも対応しています'
      : hasTtl
        ? 'この時間を過ぎると期限切れになります'
        : '時間ではなく、更新などのきっかけで狙って無効化（パージ）する方式です';
    rows.push({ label: 'キャッシュの切れ方', value: [ttlPart, tagPart].filter(Boolean).join(' ＋ '), note });
    addTerm('TTL');
    if (hasSurrogateKey) addTerm('パージ');
  }

  // キャッシュタグの中身。同じタグの重複は畳んで見やすくするが、原文は L3 の生ヘッダーに残る。
  if (hasSurrogateKey) {
    rows.push({
      label: 'キャッシュタグ',
      tags,
      note: 'このページのキャッシュに付いた名札です。同じ名札の付いたキャッシュだけを狙って消せます（パージ）。同じ名札が重なっている分はまとめています（元の値は下の「レスポンスヘッダー」でそのまま確認できます）',
    });
  }

  // ネットワークキャッシュの期限切れ。Surrogate-Control（CDN内部の実効期限）が見えていれば、それを
  // 超過した＝stale と確定でき、超過時間も示す。見えない通常時は、CDN内部の実効期限が分からず stale か
  // 断定できないため、stale 断定の代わりに「判定保留」を両論併記で示す（原則3）。
  if (v.origin.state === 'network' && v.freshness?.mode === 'countdown' && v.freshness.remainingSec <= 1) {
    if (v.freshness.lifetimeSource === 'surrogate' && v.freshness.lifetimeSec != null) {
      addTerm('stale');
      const overdue = v.freshness.ageSec - v.freshness.lifetimeSec;
      if (overdue >= 1) rows.push({ label: '期限切れからの経過', value: formatDurationJa(overdue), note: '有効期限を過ぎたキャッシュ（stale）が、この時間ぶん配信され続けています' });
    } else {
      addTerm('Surrogate-Control');
      rows.push({ label: 'ネットワーク側の鮮度', value: '判定保留', note: 'ブラウザ向けの有効期限は過ぎていますが、CDNは内部用の別の期限（Surrogate-Control）でまだ新しいものとして配っていることがあります。その期限はブラウザに届かないため、本当に期限切れかはこの画面からは確定できません' });
    }
  }

  // 表示までの速さ（実測）。L1のチップは「速さ ○○ミリ秒」としか出ないため、何を測った値なのかを
  // ここで名乗る。計測は responseStart - requestStart で、名前解決・接続は含まない。PageSpeed
  // Insights 等の TTFB は responseStart - startTime（接続前も込み）で、同じ名前でも別物になる。
  if (v.speed?.ttfbMs != null) {
    rows.push({
      label: '表示までの速さ',
      value: formatMsJa(v.speed.ttfbMs),
      note: '要求してから最初の1バイトが届くまでの実測値です。名前解決や接続にかかった時間、本文の受信や画面の描画は含みません。出どころがキャッシュのときは、その控えが返る速さであってサーバーの速さではありません',
    });
  }

  // サーバーでの生成時間（Fastly MISS 時の VE）
  if (v.speed?.serverMs != null) {
    rows.push({ label: 'サーバーでの生成時間', value: formatMsJa(v.speed.serverMs), note: 'CDNがサーバーから取り直した際の目安' });
  }

  // 受信ステータス。ブラウザキャッシュは本体をネットワークから受信しておらず、webRequest は
  // キャッシュ済み応答（304再検証でも）を 200 と報告するだけなので、出すと「サーバーが200を返した」
  // と誤解させる。ネットワーク／サーバー由来のときだけ出す（原則3）。
  if (v.raw?.statusCode != null && v.origin.state !== 'browser') rows.push({ label: '受信ステータス', value: String(v.raw.statusCode) });

  // チップのキーが「速さ」なので値は実測値のみ（「表示までの速さ」の語は L2 用語補足で説明）
  const speedText = v.speed?.ttfbMs != null ? formatMsJa(v.speed.ttfbMs) : null;
  if (speedText) addTerm('表示までの速さ');

  // Fastly-Debug が「実際に効いたか」。トグルやドメイン登録の状態ではなく、詳細ヘッダーが
  // 本当に届いたかで見る。多くの本番サイトは Fastly-Debug を無効化しており、有効にしても
  // 返らない（SPEC §10）。設定と実態を取り違えさせないため、応答そのものを根拠にする。
  const debugActive = (v.raw?.headers || []).some((hh) => /^fastly-debug-/i.test(String(hh.name)));

  return {
    badge: o.badge,
    debugActive,
    l1: {
      icon: o.icon,
      label: o.label,
      lead: o.lead,
      freshness: freshnessView(v),
      speed: speedText,
    },
    l2: {
      rows,
      terms: [...usedTerms].map((t) => ({ term: t, def: TERMS[t] })),
    },
  };
}
