import type { ScreenNode } from "../../types/screen";
import { t, pickLocalized, type Language } from "../../lib/i18n";

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
// v0.1.7 デザイン刷新:厚いタイル → 軽量ガラス。寸法を 120×52 に縮小して密集時の視認性確保。
export const NODE_WIDTH = 120;
export const NODE_HEIGHT = 52;

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
  // v0.1.7 デザイン刷新:エントリーポイントは「光点 + 短いラベル」表示に変更。
  // 旧 pill 型バッジは撤廃したので幅計算は不要。テキストだけ取得。
  const badgeText = T.nodeTile.entryPointBadge;
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
  const LABEL_BUDGET = NODE_WIDTH - 20; // 100px = タイル幅 - 左右 padding(120-20)
  // v0.1.7 多言語化:LocalizedText から現在の UI 言語の文字列を取り出す。
  const labelSource =
    noCodeMode && node.userIntent ? node.userIntent : node.label;
  const rawLabel = pickLocalized(labelSource, language);
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

  // v0.1.7 デザイン刷新:
  // - 通常時:soft drop-shadow + teal glow を控えめに(浮遊感)
  // - 選択時:teal glow 強化(focus 効果)
  // - 外側ストロークは透明度低めの teal 単色(以前のグレー → ブランド色寄せ)
  const filter = selected
    ? "drop-shadow(0 6px 18px rgba(0, 0, 0, 0.45)) drop-shadow(0 0 20px rgba(20, 184, 166, 0.55))"
    : "drop-shadow(0 4px 10px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 6px rgba(20, 184, 166, 0.08))";

  return (
    <g
      onClick={() => onClick(node.id)}
      onMouseDown={(e) => onMouseDown?.(e, node.id)}
      className="cursor-grab active:cursor-grabbing"
      style={{ filter }}
    >
      {/* メイン:ガラス調グラデ fill + ソフトな teal ストローク */}
      <rect
        x={x}
        y={y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={12}
        fill={`url(#${gradientId})`}
        className={`transition-all ${
          selected ? "stroke-electric-teal" : "stroke-electric-teal hover:stroke-off-white"
        }`}
        strokeOpacity={selected ? 0.95 : 0.22}
        strokeWidth={selected ? 1.5 : 1}
      />
      {/* 上端 1px Teal ハイライト(細い反射感) */}
      <line
        x1={x + 14}
        y1={y + 4}
        x2={x + NODE_WIDTH - 14}
        y2={y + 4}
        className="stroke-electric-teal"
        strokeWidth={1}
        strokeOpacity={selected ? 0.7 : 0.25}
        pointerEvents="none"
      />
      {/* タイトル(中央寄り、新サイズの中央 y = 22)— noCodeMode 時は userIntent。
          v0.1.7: 仕切り線 + path 副題を撤廃して可読性 ↑、ガラス感 ↑。 */}
      <text
        x={cx}
        y={y + 26}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-off-white select-none pointer-events-none"
        fontSize="13"
        fontWeight="500"
        letterSpacing="0.01em"
        lengthAdjust="spacingAndGlyphs"
        textLength={needsCompression ? NODE_WIDTH - 20 : undefined}
      >
        {rawLabel !== mainLabel && <title>{rawLabel}</title>}
        {mainLabel}
      </text>
      {/* v0.1.7 デザイン刷新:エントリーポイントを node 上端中央に「光る点 + 短いラベル」で表現。
          (旧:大きな pill 型バッジで圧迫感あり) */}
      {node.isEntryPoint && (
        <g pointerEvents="none">
          {/* 小さな光る点(輝度高めで存在主張) */}
          <circle
            cx={x + NODE_WIDTH / 2}
            cy={y - 8}
            r={3}
            className="fill-electric-teal"
            style={{ filter: "drop-shadow(0 0 6px rgba(20,184,166,0.85))" }}
          />
          {/* ラベル(点の右に並ぶ) */}
          <text
            x={x + NODE_WIDTH / 2 + 8}
            y={y - 7}
            dominantBaseline="middle"
            className="fill-electric-teal select-none"
            fontSize="9"
            fontWeight="700"
            letterSpacing="0.08em"
            opacity="0.9"
          >
            {badgeText}
          </text>
        </g>
      )}
    </g>
  );
}

export default NodeTile;
