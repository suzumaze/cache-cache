// 判定結果(verdict) → 画面表示用のビューモデルへ変換する。
// L1=要点(専門語なし) / L2=詳細＋用語補足 / badge=ツールバー用。文言は SPEC §11 に準拠。
import { formatDurationJa, formatAgoJa, formatMsJa, formatDateTimeJa } from './format.js';

const COLOR = {
  browser: '#16A34A',
  network: '#CA8A04',
  server: '#DC2626',
  unknown: '#6B7280',
};

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
  '表示までの速さ': '要求してから最初の1バイトが返るまでの実測時間（TTFB）。',
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
      ? { icon: 'computer', label: 'ブラウザキャッシュ（再確認あり）', lead: 'あなたのパソコンのキャッシュを使い、最新かどうかの確認だけ取りに行きました', badge: { text: '家', color: COLOR.browser, textColor: '#FFFFFF' } }
      : { icon: 'computer', label: 'ブラウザキャッシュ', lead: 'あなたのパソコンに残っていたキャッシュです（一番速い）', badge: { text: '家', color: COLOR.browser, textColor: '#FFFFFF' } };
  }
  if (st === 'network') {
    const lead = v.cdn?.name
      ? 'ネットワーク上のキャッシュから届きました'
      : 'ネットワーク上のキャッシュから届いたようです（提供元までは特定できませんでした）';
    return { icon: 'cloud', label: 'ネットワークキャッシュ', lead, badge: { text: '網', color: COLOR.network, textColor: '#111827' } };
  }
  if (st === 'server') {
    const k = v.server?.kind;
    if (k === 'server-cache') return { icon: 'host', label: 'サーバー（用意していたキャッシュ）', lead: 'サーバーが用意していたキャッシュから届きました', badge: { text: '源', color: COLOR.server, textColor: '#FFFFFF' } };
    if (k === 'fresh') return { icon: 'host', label: 'サーバー（作りたて）', lead: 'サーバーがその場で作った最新の内容が届きました', badge: { text: '新', color: COLOR.server, textColor: '#FFFFFF' } };
    return { icon: 'host', label: 'サーバー', lead: 'サーバーから直接届きました（キャッシュがあったかどうかまでは分かりませんでした）', badge: { text: '源', color: COLOR.server, textColor: '#FFFFFF' } };
  }
  return { icon: 'help', label: '特定できませんでした', lead: '今回は出どころを特定できませんでした（再読み込みで分かることがあります）', badge: { text: '?', color: COLOR.unknown, textColor: '#FFFFFF' } };
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
    return `あと${formatDurationJa(f.remainingSec)}でキャッシュの期限が切れます`;
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
// Fastly はエッジ（利用者寄り）→シールド（サーバー寄り）の多段構成で、
// X-Cache は [エッジ, シールド...] の順に各段の結果が並ぶ（SPEC §5）。
function fastlyStageName(index, total, kind = '拠点') {
  if (index === 0) return `エッジ（あなたに最も近い${kind}）`;
  if (total <= 2) return `シールド（サーバー寄りの${kind}）`;
  if (index === total - 1) return `シールド${index}（サーバー寄りの${kind}）`;
  return `シールド${index}（中間${kind === 'キャッシュ' ? 'の' : ''}${kind}）`;
}

function cacheJudgeNote(v) {
  const states = v.cdn?.states;
  if (states?.length >= 2) {
    const total = Math.max(v.cdn.layers || 0, states.length);
    const parts = states.map((s, i) => `${fastlyStageName(i, total)}＝${s}（${s.includes('HIT') ? '見つかった' : '無かった'}）`);
    const servedIndex = v.cdn.servedIndex;
    let tail;
    if (v.cdn.servedAt === 'shield') tail = `最も近い段には無く、${fastlyStageName(servedIndex ?? 1, total)}で見つかりました`;
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

  // シールド構成（サーバー寄りの追加キャッシュ）。Fastly のみ。多段が観測できれば「あり」、
  // 1段のみなら エッジHIT 等でシールドが隠れるため断定しない（原則3）。
  if (v.cdn?.name === 'Fastly') {
    rows.push(v.cdn.layers >= 2
      ? { label: 'シールド', value: v.cdn.layers === 2 ? 'あり（エッジ→シールドの2段）' : `あり（エッジ＋シールド${v.cdn.layers - 1}段の${v.cdn.layers}段）`, note: 'サーバーの手前でアクセス集中を受け止める共有キャッシュです' }
      : { label: 'シールド', value: '今回は確認できません', note: '今回はエッジで完結したため、シールドの有無は判定できません' });
    addTerm('シールド');
  }

  // Fastly: どの段から返ってきたか（エッジ/シールド）。MISS/HIT の段ごとの根拠は note に集約。
  if (v.cdn?.servedAt) {
    const servedIndex = v.cdn.servedAt === 'edge' ? 0 : (v.cdn.servedIndex ?? 1);
    const where = `${fastlyStageName(servedIndex, v.cdn.layers || 1, 'キャッシュ')}から返されました`;
    rows.push({ label: '返ってきた場所', value: where, note: cacheJudgeNote(v) });
    addTerm(v.cdn.servedAt === 'shield' ? 'シールド' : 'エッジ');
  }

  // 拠点（POP都市）。利用者に最も近い「入口（エッジ）」と、実際に「命中した拠点」を分けて示す。
  // 多段で命中したときは両方出す（エッジとシールドが同じ都市のこともある）。それ以外は入口を1つ示す。
  if (v.cdn?.hit && v.cdn?.layers >= 2 && v.cdn?.pop && v.cdn?.edgePop) {
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
  const hasSurrogateKey = (v.raw?.headers || []).some((hh) => String(hh.name).toLowerCase() === 'surrogate-key');
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

  return {
    badge: o.badge,
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
