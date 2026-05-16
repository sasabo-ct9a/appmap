import type { ScreenNode } from "../../types/screen";

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
   * SVG `<defs>` グラデーション id。Phase 3 polish v5 で 2 つの MapCanvas を
   * 同時描画するようになり、id が衝突するため呼び出し側から固有 id を渡す。
   * 省略時は従来通り `"node-gradient"`(単一 SVG モード後方互換)。
   */
  gradientId?: string;
  /**
   * §3.3 + クイックウィン 2 対応:ノーコード語切替モード。
   * true かつ node.userIntent があるとき、技術的な label の代わりに
   * userIntent をタイル中央に表示する(ユーザー視点のフレーズ)。
   */
  noCodeMode?: boolean;
};

function NodeTile({
  node,
  selected,
  onClick,
  gradientId = "node-gradient",
  noCodeMode = false,
}: NodeTileProps) {
  const x = node.position.x;
  const y = node.position.y;
  const cx = x + NODE_WIDTH / 2;

  // クイックウィン 2: noCodeMode かつ userIntent あり → userIntent を主表示。
  // それ以外は技術的 label を表示。
  // Codex review Med #5 対応:長すぎる文字列でタイル(140px)からはみ出すのを防ぐ。
  // 12 文字超は末尾を「…」で省略。短いラベルはそのまま。
  const MAX_LABEL_CHARS = 12;
  const rawLabel =
    noCodeMode && node.userIntent ? node.userIntent : node.label;
  const mainLabel =
    rawLabel.length > MAX_LABEL_CHARS
      ? rawLabel.slice(0, MAX_LABEL_CHARS - 1) + "…"
      : rawLabel;

  // Drop-shadow を常時、選択時はそれに Teal glow を重ねる(filter 2 個)。
  // 階層(depth)はキャンバスの背景プレーンが担当するので、NodeTile 側では
  // スケール / 不透明度を変えない(全ノード フルサイズ・フル不透明)。
  const filter = selected
    ? "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.5)) drop-shadow(0 0 14px rgba(20, 184, 166, 0.7))"
    : "drop-shadow(0 4px 10px rgba(0, 0, 0, 0.45))";

  return (
    <g
      onClick={() => onClick(node.id)}
      className="cursor-pointer"
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
        textLength={mainLabel.length > 8 ? NODE_WIDTH - 24 : undefined}
      >
        {rawLabel !== mainLabel && <title>{rawLabel}</title>}
        {mainLabel}
      </text>
      {/* クイックウィン 3: エントリーポイントの「▶ まずここ」マーカー(ノード上端外側) */}
      {node.isEntryPoint && (
        <g pointerEvents="none">
          <rect
            x={x + NODE_WIDTH - 64}
            y={y - 14}
            width={60}
            height={14}
            rx={7}
            className="fill-electric-teal"
            opacity="0.95"
          />
          <text
            x={x + NODE_WIDTH - 34}
            y={y - 7}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-charcoal select-none"
            fontSize="9"
            fontWeight="700"
          >
            ▶ まずここ
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
