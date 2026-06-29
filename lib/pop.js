// CDN の POP（拠点）コード → 地名（日本語）。代表的な空港コードのみ収録。
// 見つからなければ null を返す（推測で断定しない＝SPEC 原則3）。
// 注: POP コード・ノードID は時系列で変わるため、地名表示のみに使う（比較には使わない）。
const CITY = {
  NRT: '東京', HND: '東京', TYO: '東京', KIX: '大阪', ITM: '大阪', NGO: '名古屋',
  FUK: '福岡', CTS: '札幌', OKA: '那覇',
  ICN: 'ソウル', GMP: 'ソウル', HKG: '香港', TPE: '台北', SIN: 'シンガポール',
  BKK: 'バンコク', KUL: 'クアラルンプール', BOM: 'ムンバイ', DEL: 'デリー', MAA: 'チェンナイ',
  SYD: 'シドニー', MEL: 'メルボルン', AKL: 'オークランド',
  LHR: 'ロンドン', LCY: 'ロンドン', CDG: 'パリ', FRA: 'フランクフルト', AMS: 'アムステルダム',
  MAD: 'マドリード', MXP: 'ミラノ', ARN: 'ストックホルム', DUB: 'ダブリン', WAW: 'ワルシャワ',
  VIE: 'ウィーン', ZRH: 'チューリッヒ', CPH: 'コペンハーゲン', HEL: 'ヘルシンキ', OSL: 'オスロ',
  LAX: 'ロサンゼルス', SJC: 'サンノゼ', SFO: 'サンフランシスコ', SEA: 'シアトル', PDX: 'ポートランド',
  ORD: 'シカゴ', DFW: 'ダラス', IAD: 'アッシュバーン', EWR: 'ニューアーク', JFK: 'ニューヨーク',
  LGA: 'ニューヨーク', BOS: 'ボストン', ATL: 'アトランタ', MIA: 'マイアミ', DEN: 'デンバー',
  PHX: 'フェニックス', YYZ: 'トロント', YVR: 'バンクーバー',
  GRU: 'サンパウロ', GIG: 'リオデジャネイロ', EZE: 'ブエノスアイレス', SCL: 'サンティアゴ',
  JNB: 'ヨハネスブルグ', CPT: 'ケープタウン', DXB: 'ドバイ', TLV: 'テルアビブ',
};

/** 3〜4文字の POP コードから地名を返す。未知なら null。 */
export function popCity(code) {
  if (!code) return null;
  return CITY[String(code).toUpperCase()] ?? null;
}

/** Fastly の x-served-by セグメント "cache-nrt-rjtf7700076-NRT" から POP コード "NRT" を抽出。 */
export function popCodeOf(segment) {
  if (!segment) return null;
  const tail = String(segment).match(/-([A-Z]{3,4})$/);
  if (tail) return tail[1];
  const parts = String(segment).split('-');
  if (parts.length >= 2 && /^[a-z]{3,4}$/i.test(parts[1])) return parts[1].toUpperCase();
  return null;
}
