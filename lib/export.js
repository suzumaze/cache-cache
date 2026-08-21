// 観測記録をエージェント（AI）に渡すための書き出し。
// 人間向けの共有テキストが「届いたヘッダーをそのまま並べる」のに対し、こちらは複数記録の
// 突き合わせに要る値を計算済みで持たせる。狙いは、受け取った側が生ヘッダーから受信時刻・Age・
// HIT回数・ノードを手で拾って引き算する作業を無くすこと。
//
// 原則3（正直さ）の適用: derived / transitions は observed からの引き算だけで、推測を含まない。
// 「stale だ」「パージされた」等の断定は一切書かない（それらは1応答からは判定できない）。
// 判断材料を揃えるところまでが役割で、結論は受け取った側が出す。
import { classify } from './classify.js';
import { present } from './present.js';
import { recordToInput } from './record.js';
import { toHeaderMap, get, parseAge, parseHttpDate, splitList } from './headers.js';
import { parseTimerVE, parseDebugTtl, parseDebugPath } from './fastly.js';

// Age は秒単位の整数で、受信時刻の記録とも1秒未満のズレが出る。誕生時刻がこの幅で一致すれば
// 「同じ控え」とみなす。厳密一致を求めると、同一の控えでも丸めだけで別物と誤判定するため。
const SAME_OBJECT_TOLERANCE_SEC = 2;

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** 生ヘッダー配列 → {小文字名: 値} 。同名は ", " 結合（toHeaderMap と同じ規則）。 */
function headersObject(rec) {
  const o = {};
  for (const [name, value] of toHeaderMap(rec?.headers || [])) o[name] = value;
  return o;
}

/** 1件の記録から、観測値だけで決まる値を計算する。 */
function derive(rec, now) {
  const map = toHeaderMap(rec?.headers || []);
  const verdict = classify(recordToInput(rec, now));
  const ageSec = parseAge(map);
  const receivedAtMs = rec?.receiveTime ?? null;
  // 控えの誕生時刻 = 受信時刻 − Age。記録間でこれが一致すれば、同じ控えが配られ続けている。
  const bornAtMs = ageSec != null && receivedAtMs != null ? receivedAtMs - ageSec * 1000 : null;
  // Age がオリジン側キャッシュの世代起点で連鎖しているか（objectBornAt ≒ last-modified）。
  // true のとき objectBornAt は CDN の控えではなくコンテンツの世代を指すため、sameObject では
  // CDN の控えの同一性を判定できない（board.md 2026-07-21・実サイトの本番側で実測）。
  const lastModifiedMs = parseHttpDate(get(map, 'last-modified'));
  const ageOriginAnchored = bornAtMs != null && lastModifiedMs != null
    ? Math.abs(bornAtMs - lastModifiedMs) <= SAME_OBJECT_TOLERANCE_SEC * 1000
    : null;
  const nodes = splitList(get(map, 'x-served-by'));
  // Fastly-Debug 有効時のみ。無効なら null のままで、無い情報を作らない。
  const debugTtl = parseDebugTtl(get(map, 'fastly-debug-ttl'));
  const debugPath = parseDebugPath(get(map, 'fastly-debug-path'));
  const fastlyDebug = debugTtl || debugPath
    ? {
        state: debugTtl?.state ?? null,
        // 残りTTL。正なら期限内。0以下なら時間切れ。パージと時間切れの区別はこれが要。
        ttlRemainingSec: debugTtl?.ttlRemainingSec ?? null,
        graceSec: debugTtl?.graceSec ?? null,
        // Fastly 自身が持つ age と、Age ヘッダーの突き合わせ用
        debugAgeSec: debugTtl?.ageSec ?? null,
        // 控えが作られた時刻。objectBornAt（受信時刻−Age）と独立に照合できる
        objectFetchedAt: iso(debugPath?.fetchedAtMs ?? null),
        fetchNode: debugPath?.fetchNode ?? null,
        deliveryNode: debugPath?.deliveryNode ?? null,
        cacheKeyDigest: get(map, 'fastly-debug-digest'),
      }
    : null;
  return {
    bornAtMs,
    verdict,
    derived: {
      origin: verdict.origin?.state ?? null,
      cdn: verdict.cdn?.name ?? null,
      ageSec,
      objectBornAt: iso(bornAtMs),
      ageOriginAnchored,
      // x-cache / x-cache-hits / x-served-by は同じ並び（利用者寄り→サーバー寄り）
      nodes,
      cacheStates: splitList(get(map, 'x-cache')).map((s) => s.toUpperCase()),
      hits: splitList(get(map, 'x-cache-hits')).map((n) => parseInt(n, 10)),
      serverMs: parseTimerVE(get(map, 'x-timer')),
      ttfbMs: rec?.perf?.ttfbMs ?? null,
      fastlyDebug,
    },
  };
}

/** サーバー寄り（＝控えを持っている段）の HIT回数。x-cache-hits の末尾。 */
function servedHits(hits) {
  return Array.isArray(hits) && hits.length ? hits[hits.length - 1] : null;
}

/** 隣り合う2件の突き合わせ。ここも引き算だけで、意味づけはしない。 */
function transition(a, b) {
  const elapsedSec = a.receivedAtMs != null && b.receivedAtMs != null
    ? Math.round((b.receivedAtMs - a.receivedAtMs) / 1000)
    : null;
  const ageDeltaSec = a.derived.ageSec != null && b.derived.ageSec != null
    ? b.derived.ageSec - a.derived.ageSec
    : null;
  const bornAtDeltaSec = a.bornAtMs != null && b.bornAtMs != null
    ? Math.round((b.bornAtMs - a.bornAtMs) / 1000)
    : null;
  const sameObject = bornAtDeltaSec == null ? null : Math.abs(bornAtDeltaSec) <= SAME_OBJECT_TOLERANCE_SEC;
  const sameNodes = a.derived.nodes.length && b.derived.nodes.length
    ? a.derived.nodes.join(',') === b.derived.nodes.join(',')
    : null;
  // HIT回数の後退。別の控え・別のノードなら別勘定なので、そもそも比較が成立しない＝null にする
  // （「数が減った」と「同じ控えのカウンタが逆行した」は別物。後者だけが異常を意味する）。
  const from = servedHits(a.derived.hits);
  const to = servedHits(b.derived.hits);
  // オリジン錨の記録が混ざるときは、sameObject が CDN の控えの同一性を保証しないので比較しない
  const anchored = a.derived.ageOriginAnchored === true || b.derived.ageOriginAnchored === true;
  const comparable = sameObject === true && sameNodes === true && from != null && to != null && !anchored;
  return {
    from: a.label,
    to: b.label,
    elapsedSec,
    ageDeltaSec,
    bornAtDeltaSec,
    // 誕生時刻が一致＝同じ控えが配られ続けた。ズレていれば別の控えに入れ替わった。
    sameObject,
    // ノードが違えば HIT回数が別勘定の可能性があり、hits の比較が成立しない
    sameNodes,
    hitsFrom: a.derived.hits,
    hitsTo: b.derived.hits,
    hitsDecreased: comparable ? to < from : null,
  };
}

/**
 * @param {{label:string, record:object}[]} entries 新しい順（現在→過去）
 * @param {number} now
 * @returns {string} 貼り付け用テキスト（説明＋JSON）
 */
export function buildAgentReport(entries, now = Date.now()) {
  // 時系列で読めるよう古い順に反転する。ラベル（現在・前回…）は各記録に付いたまま。
  const ordered = [...(entries || [])].filter((e) => e?.record?.url).reverse();
  const analyzed = ordered.map(({ label, record }) => {
    const { bornAtMs, verdict, derived } = derive(record, now);
    let l1 = null;
    try {
      l1 = present(verdict).l1?.label ?? null;
    } catch (_) {}
    return {
      label,
      receivedAtMs: record.receiveTime ?? null,
      bornAtMs,
      derived,
      json: {
        label,
        receivedAt: iso(record.receiveTime ?? null),
        verdict: l1,
        derived,
        observed: {
          url: record.url,
          statusCode: record.statusCode ?? null,
          fromCache: !!record.fromCache,
          headers: headersObject(record),
        },
      },
    };
  });

  const transitions = analyzed.slice(0, -1).map((a, i) => transition(a, analyzed[i + 1]));

  const report = {
    tool: 'cache-cache',
    url: analyzed[0]?.json.observed.url ?? null,
    exportedAt: iso(now),
    recordCount: analyzed.length,
    records: analyzed.map((a) => a.json),
    transitions,
  };

  // 冒頭は受け取るAIへの依頼。データだけ貼られたAIは総花的な要約に流れやすいので、時系列の解釈と
  // 異常の指摘を明示的に求め、あわせて原則3（事実と推測の分離・判定不能の明言）を受け取り側にも課す。
  return [
    '# カーシュ・カーシュ: キャッシュ観測記録（AI向け）',
    '',
    'あなたはHTTPキャッシュとCDNに詳しいエンジニアです。以下は、ブラウザ拡張が同じURLへの複数回のアクセスで観測したレスポンスヘッダーと、観測値から機械的に計算した差分です。次の観点で分析してください。',
    '',
    '1. 時系列で何が起きたか（各記録の出どころ、同じ控えが配られ続けたのか・別の控えに入れ替わったのか）',
    '2. 異常や不整合の指摘（HIT回数の後退、経過時間とAge増分のずれ、など）',
    '3. 事実（観測と引き算）と推測を分ける。推測には根拠と確度を添え、このデータから判定できないことは「判定できない」と明言する',
    '4. 曖昧さが残る場合、それを切り分けるために次に何を観測すべきかの提案',
    '',
    '## データの読み方',
    '',
    '- records は古い順。observed は届いたそのままの値、derived は observed からの計算のみ。',
    '- transitions は隣り合う記録の差分。elapsedSec は実際の経過秒、ageDeltaSec は Age の増分。',
    `- objectBornAt = 受信時刻 − Age。sameObject はこれが ±${SAME_OBJECT_TOLERANCE_SEC}秒 で一致するか（＝同じ控えが配られ続けたか）。`,
    '- nodes / cacheStates / hits は同じ並び（利用者寄り→サーバー寄り）。sameNodes が false なら hits の比較は成立しません。',
    '- hitsDecreased は「同じ控えが同じノードで配られているのに HIT回数が後退した」か。比較が成立しないときは null。',
    '- ageOriginAnchored は objectBornAt が last-modified と±2秒で一致するか。true のとき Age はオリジン側キャッシュの世代起点で連鎖しており、objectBornAt は CDN の控えではなくコンテンツの世代を指します（sameObject で CDN の控えの同一性は判定できず、hitsDecreased は null になります）。',
    '- derived.ttfbMs は responseStart − requestStart（要求送信から最初の1バイトまで）。PageSpeed Insights や CrUX の TTFB は responseStart − startTime で名前解決・接続も含む別定義なので、そのまま突き合わせないでください。',
    '- derived.fastlyDebug は Fastly-Debug 有効時のみ。ttlRemainingSec が正なら期限内、0以下なら時間切れ。',
    '- 推測は含みません。stale・パージの有無は1応答からは判定できないため、判断は受け取った側で行ってください。',
    '',
    '## 観測データ',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    '質問があればこの下に書き足してください。特に無ければ、上記の観点で分析してください。',
  ].join('\n');
}
