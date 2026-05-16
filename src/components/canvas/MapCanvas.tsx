import type { ScreenNode, ScreenEdge } from "../../types/screen";
import NodeTile, { NODE_HEIGHT } from "./NodeTile";
import Edge from "./Edge";

/**
 * SVG マップ全体(CLAUDE.md §10.5.1、DARK モード、機能拡張:単一 SVG モード)。
 *
 * 旧 v5 では「N 枚の MapCanvas を CSS 3D 回転して積み重ねる」構造だったが、
 * 階層をまたぐエッジが viewBox でぶつ切りされる(両プレーンに stub だけ出る)
 * 問題があった。
 *
 * 新構造:
 *   - 単一 SVG に N 枚の「フロア(背景 rect)」を縦に並べる
 *   - 全ノードと全エッジを同じ座標系で描画 → 矢印は階層を無視して直線で繋がる
 *   - CSS 3D 回転は廃止(直線連続を優先)
 *   - フロア間に明確な隙間(PLANE_GAP)、各フロアは縦に広め(PLANE_HEIGHT)
 *
 * 階層数(numPlanes)はノードの maxDepth + 1 で自動算出。
 * ノードの y 座標は depth から自動計算するため、AI 側 / sampleScreens 側の
 * `position.y` の値は無視される(x と depth だけが効く)。
 */
type MapCanvasProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  selectedNodeId: number | null;
  onNodeClick: (id: number) => void;
  /** §3.3 対応:プレーンラベルをノーコード語に切り替える。 */
  noCodeMode?: boolean;
};

const PLANE_HEIGHT = 150; // 1 フロアの SVG 内高さ(縦に広めに)
const PLANE_GAP = 28; // フロア間の隙間

/** 各 depth で、ノードの top y(SVG 座標)を求める。 */
function nodeYForDepth(depth: number): number {
  const planeTop = depth * (PLANE_HEIGHT + PLANE_GAP);
  return planeTop + (PLANE_HEIGHT - NODE_HEIGHT) / 2;
}

/** depth に応じたフロア背景色(明 → 暗のグラデ)。 */
function planeBgFill(depth: number): string {
  const t = Math.min(1, depth * 0.35);
  const r = Math.round(46 - 36 * t);
  const g = Math.round(63 - 47 * t);
  const b = Math.round(85 - 59 * t);
  const a = 0.78 + t * 0.04;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** depth に応じたフロア枠線(深いほど薄く)。 */
function planeStrokeColor(depth: number): string {
  return `rgba(229, 231, 235, ${Math.max(0.08, 0.22 - depth * 0.05)})`;
}

/**
 * 階層プレーンの日本語ラベル(統一版)。
 *
 * 旧:noCodeMode で「主フロー」「主な画面」など切替えていたが、ターゲットユーザー
 * 全員「コードを読みたくない」(§2)前提なので、構造ラベルは常に同じクリーンな
 * 語彙で統一。「フロー」のような技術用語を避け、「メイン/サブ/詳細/深層」に。
 */
function planeLabel(depth: number): string {
  if (depth === 0) return "メイン";
  if (depth === 1) return "サブ";
  if (depth === 2) return "詳細";
  return "深層";
}

function MapCanvas({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  noCodeMode = false,
}: MapCanvasProps) {
  // 階層数 = max depth + 1。データから動的に決める。
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
  const numPlanes = maxDepth + 1;
  const totalHeight =
    numPlanes * PLANE_HEIGHT + (numPlanes - 1) * PLANE_GAP;
  const viewBox = `0 0 800 ${totalHeight}`;

  // ノードの y を depth から再計算(AI / サンプル の元 y 値は無視)。
  // x はそのまま使う。これにより N 階層どれでもフロアとノード位置が一致する。
  const positionedNodes = nodes.map((n) => ({
    ...n,
    position: {
      x: n.position.x,
      y: nodeYForDepth(n.depth ?? 0),
    },
  }));

  return (
    <svg
      viewBox={viewBox}
      className="w-full h-auto"
      role="img"
      aria-label="アプリ構造マップ"
    >
      <defs>
        {/* 背景ドットパターン */}
        <pattern
          id="dot-grid"
          x="0"
          y="0"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="7" cy="7" r="0.9" fill="#E5E7EB" fillOpacity="0.15" />
        </pattern>

        {/* ノードタイル用 3-stop グラデ:上が明るく、下が深い立体感 */}
        <linearGradient id="node-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2E3F55" />
          <stop offset="0.35" stopColor="#1A2331" />
          <stop offset="1" stopColor="#060A12" />
        </linearGradient>

        {/* 矢印 marker(両端再利用、orient="auto-start-reverse" で逆向き対応) */}
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
          className="fill-electric-teal"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      {/* N 枚のフロア背景(後ろのレイヤー) */}
      {Array.from({ length: numPlanes }).map((_, d) => {
        const planeY = d * (PLANE_HEIGHT + PLANE_GAP);
        const label = planeLabel(d);
        return (
          <g key={`plane-${d}`} aria-label={`${label} 層`}>
            {/* 床本体 */}
            <rect
              x={8}
              y={planeY + 8}
              width={784}
              height={PLANE_HEIGHT - 16}
              rx={14}
              fill={planeBgFill(d)}
              stroke={planeStrokeColor(d)}
              strokeWidth="1"
            />
            {/* ドットグリッド */}
            <rect
              x={8}
              y={planeY + 8}
              width={784}
              height={PLANE_HEIGHT - 16}
              rx={14}
              fill="url(#dot-grid)"
            />
            {/* 上端 Teal アクセント */}
            <line
              x1={28}
              y1={planeY + 10}
              x2={772}
              y2={planeY + 10}
              className="stroke-electric-teal"
              strokeWidth={1}
              strokeOpacity={Math.max(0.15, 0.6 - d * 0.15)}
            />
            {/* フロアラベル */}
            <text
              x={24}
              y={planeY + 28}
              className="fill-electric-teal select-none pointer-events-none"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.05em"
              opacity="0.72"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* エッジ層:階層を無視して全エッジを直線で繋ぐ */}
      <g aria-label="リンク線">
        {edges.map((edge) => (
          <Edge key={edge.id} edge={edge} nodes={positionedNodes} />
        ))}
      </g>

      {/* ノード層(前面)— noCodeMode を流して userIntent を主表示できるように */}
      <g aria-label="画面一覧">
        {positionedNodes.map((node) => (
          <NodeTile
            key={node.id}
            node={node}
            selected={node.id === selectedNodeId}
            onClick={onNodeClick}
            noCodeMode={noCodeMode}
          />
        ))}
      </g>
    </svg>
  );
}

export default MapCanvas;
