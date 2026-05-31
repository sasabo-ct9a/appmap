import type { ScreenNode } from "../../types/screen";
import { t, type Language } from "../../lib/i18n";

/**
 * 1 ノード分の SVG 描画(CLAUDE.md §10.5.2、DARK モード、Phase 3 polish v3)。
 *
 * Polish v3: 立体感を 3 つのテクニックで強化:
 *   1. **常時 drop shadow**: ノードが背景から浮いている感(elevation)
 *   2. **3-stop グラデーション**(MapCanvas で定義): 上が明るく、中央、下が深い
 *      → 「上から光が当たっている」curvature 感
 *   3. **上端内側の白ハイライト線**: 光の反射感を演出するベベル風
 *
 * 選択時はベース drop-shadow と Teal glow を同時適用(filter を 2 個重ねる)。
 *
 * 構成要素:
 *   - メイン rect: グラデーション fill + 外側ストローク
 *   - 上端内側に 1px 白(8% 不透明度)のハイライト → 光反射
 *   - 上端 Teal アクセントライン → ブランド色のテック装飾
 *   - 中央仕切り線 → 上下 2 行の構造化
 *   - タイトル(text-sm 13px Medium)+ パス副題(11px mono)
 */
export const NODE_WIDTH = 140;
export const NODE_HEIGHT = 64;

type NodeTileProps = {
  node: ScreenNode;
  selected: boolean;
  onClick: (id: number) => void;
  /**
   * SVG `<defs>` グラデーション id。複数 MapCanvas インスタンスでの id 衝突回避用。
   */
  gradientId?: string;
  /**
   * §3.3 + クイックウィン 2 対応:ノーコード語切替モード。
   * true かつ node.userIntent があるとき、技術的な label の代わりに
   * userIntent をタイル中央に表示する(ユーザー視点のフレーズ)。
   */
  noCodeMode?: boolean;
  /**
   * v0.1.2 ドラッグ機能(A 案):マウスダウンを親(MapCanvas)に伝搬する。
   * 親側で document 全体の mousemove / mouseup を捕捉してドラッグ処理する設計。
   */
  onMouseDown?: (e: React.MouseEvent, nodeId: number) => void;
  /** v0.1.6: UI 言語(エントリーポイントバッジの JA/EN 切替に使用)。 */
  language: Language;
};

/**
 * SVG 上での文字列の **概算描画幅**(px)。
 *   - CJK(全角)= 1 文字 ≈ 1em
 *   - ASCII / 半角 = 1 文字 ≈ 0.55em(プロポーショナルフォントの平均)
 *
 *  fontSize を引数に取り、文字種ごとに em 比率を変えて加算。
 *  textLength の発動判定とバッジ幅計算の両方で使う(同じ尺度で揃える)。
 */
function approxTextWidth(text: string, fontSize: number): number {
  const cjkRe = /[　-鿿＀-￯]/;
  let w = 0;
  for (const ch of text) {
    w += cjkRe.test(ch) ? fontSize : fontSize * 0.55;
  }
  return w;
}

function NodeTile({
  node,
  selected,
  onClick,
  gradientId = "node-gradient",
  noCodeMode = false,
  onMouseDown,
  language,
}: NodeTileProps) {
  const T = t(language);
  // バッジ幅は実描画幅(CJK / Latin 別)+ 左右 padding(計 18px)で算出。
  // 旧 `length * 5.6` は Latin 前提だった → CJK(▶ まずここ など)で過小だった。
  const badgeText = T.nodeTile.entryPointBadge;
  const badgeWidth = approxTextWidth(badgeText, 9) + 18;
  const x = node.position.x;
  const y = node.position.y;
  const cx = x + NODE_WIDTH / 2;

  // クイックウィン 2: noCodeMode かつ userIntent あり → userIntent を主表示。
  // それ以外は技術的 label を表示。
  //
  // ラベル幅の扱い(v0.1.6 後修正、両言語 + 混在文字列対応):
  //   1. 文字数ではなく **実描画幅** で判断する(approxTextWidth)
  //   2. truncate: 概算幅がタイル余地(LABEL_BUDGET)の 1.5 倍を超えたら末尾 …
  //   3. textLength 圧縮: 概算幅 > LABEL_BUDGET のときだけ発動
  //      → 「1 画面を深く見る」のような混在 CJK でも、実幅がタイル内なら圧縮しない
  //      → 英語でも CJK でも、自然描画で収まるなら textLength は付けない
  const FONT_SIZE = 13;
  const LABEL_BUDGET = NODE_WIDTH - 24; // 116px = タイル幅 - 左右 padding
  const rawLabel =
    noCodeMode && node.userIntent ? node.userIntent : node.label;
  const rawWidth = approxTextWidth(rawLabel, FONT_SIZE);
  // truncate: 自然描画で LABEL_BUDGET の 1.5 倍を超えるなら末尾を「…」で省略。
  // 圧縮で何とかなる範囲(< 1.5x)はそのまま見せる(可読性 > 完全フィット)。
  const TRUNC_LIMIT = LABEL_BUDGET * 1.5;
  let mainLabel = rawLabel;
  if (rawWidth > TRUNC_LIMIT) {
    let acc = 0;
    let cut = rawLabel.length;
    for (let i = 0; i < rawLabel.length; i++) {
      acc += approxTextWidth(rawLabel[i], FONT_SIZE);
      if (acc > TRUNC_LIMIT - FONT_SIZE) {
        cut = i;
        break;
      }
    }
    mainLabel = rawLabel.slice(0, cut) + "…";
  }
  // 圧縮 textLength は、自然幅が予算超過のときだけ。
  const mainWidth = approxTextWidth(mainLabel, FONT_SIZE);
  const needsCompression = mainWidth > LABEL_BUDGET;

  // Drop-shadow を常時、選択時はそれに Teal glow を重ねる(filter 2 個)。
  // 階層(depth)はキャンバスの背景プレーンが担当するので、NodeTile 側では
  // スケール / 不透明度を変えない(全ノード フルサイズ・フル不透明)。
  const filter = selected
    ? "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.5)) drop-shadow(0 0 14px rgba(20, 184, 166, 0.7))"
    : "drop-shadow(0 4px 10px rgba(0, 0, 0, 0.45))";

  return (
    <g
      onClick={() => onClick(node.id)}
      onMouseDown={(e) => onMouseDown?.(e, node.id)}
      className="cursor-grab active:cursor-grabbing"
      style={{ filter }}
    >
      {/* メイン:グラデーション fill + 外ストローク */}
      <rect
        x={x}
        y={y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={14}
        fill={`url(#${gradientId})`}
        className={`transition-colors ${
          selected
            ? "stroke-electric-teal"
            : "stroke-soft-grid hover:stroke-off-white"
        }`}
        strokeOpacity={selected ? 1 : 0.4}
        strokeWidth={selected ? 2 : 1}
      />
      {/* 上端内側の白ハイライト(光反射、bevel 感) */}
      <line
        x1={x + 16}
        y1={y + 2}
        x2={x + NODE_WIDTH - 16}
        y2={y + 2}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={1}
        strokeLinecap="round"
        pointerEvents="none"
      />
      {/* 上端 Teal アクセントライン(ブランド色テック装飾) */}
      <line
        x1={x + 14}
        y1={y + 5}
        x2={x + NODE_WIDTH - 14}
        y2={y + 5}
        className="stroke-electric-teal"
        strokeWidth={1}
        strokeOpacity={selected ? 0.9 : 0.35}
        pointerEvents="none"
      />
      {/* 中央仕切り線(タイトル / path 副題の境界) */}
      <line
        x1={x + 12}
        y1={y + 33}
        x2={x + NODE_WIDTH - 12}
        y2={y + 33}
        className="stroke-soft-grid"
        strokeWidth={1}
        strokeOpacity={0.18}
        pointerEvents="none"
      />
      {/* タイトル(上半分中央)— noCodeMode 時は userIntent を表示。
          Med #5: rawLabel が短く済むよう truncate 済み。<title> は SVG の
          ホバーツールチップで省略前の全文を見せる安全弁。lengthAdjust + textLength で
          想定外の長文や太字幅にもタイル幅を超えないよう保険をかける。 */}
      <text
        x={cx}
        y={y + 19}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-off-white select-none pointer-events-none"
        fontSize="13"
        fontWeight="500"
        lengthAdjust="spacingAndGlyphs"
        textLength={needsCompression ? NODE_WIDTH - 24 : undefined}
      >
        {rawLabel !== mainLabel && <title>{rawLabel}</title>}
        {mainLabel}
      </text>
      {/* クイックウィン 3: エントリーポイントのバッジ(ノード上端外側)。
          v0.1.6: 文字数に応じて幅と位置を動的計算(EN は JA より長い)。 */}
      {node.isEntryPoint && (
        <g pointerEvents="none">
          <rect
            x={x + NODE_WIDTH - badgeWidth - 4}
            y={y - 14}
            width={badgeWidth}
            height={14}
            rx={7}
            className="fill-electric-teal"
            opacity="0.95"
          />
          <text
            x={x + NODE_WIDTH - badgeWidth / 2 - 4}
            y={y - 7}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-charcoal select-none"
            fontSize="9"
            fontWeight="700"
          >
            {badgeText}
          </text>
        </g>
      )}
      {/* パス副題(下半分中央、mono 11px) */}
      <text
        x={cx}
        y={y + 48}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-soft-grid select-none pointer-events-none"
        fontFamily="ui-monospace, 'Cascadia Code', 'Consolas', monospace"
        fontSize="11"
        opacity="0.75"
      >
        /screen/{node.id}
      </text>
    </g>
  );
}

export default NodeTile;
