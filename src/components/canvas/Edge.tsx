import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { NODE_WIDTH, NODE_HEIGHT } from "./NodeTile";

/**
 * ノード間の関係線(CLAUDE.md §10.5.3、DARK モード)。
 *
 * v0.1.2 で「ホーム画面 → サブ 4 画面」のような fan-out で起点が密集する
 * 問題を解消するため、cross-depth エッジは送信元ノードの下辺(or 上辺)に
 * 起点を **均等分散** して描画する。
 *   - target.x 昇順でソートしたインデックスを MapCanvas が事前計算
 *   - 起点 X = ノード左 + spread の N 等分目盛り
 *   - 1 本だけならノード中央を使う(後方互換)
 *
 * 同 depth エッジは従来通りノード中心 → 中心の direction-based boundary 計算。
 */
type EdgeProps = {
  edge: ScreenEdge;
  nodes: ScreenNode[];
  /**
   * SVG `<marker>` id。複数 MapCanvas インスタンスでの id 衝突回避用。省略時は "arrow"。
   */
  arrowMarkerId?: string;
  /** このエッジが、送信元ノードから出る outgoing edges のうち何番目か(target.x ソート済み)。 */
  fromIndex?: number;
  /** 同送信元から出る outgoing edges の総数。 */
  fromTotal?: number;
  /** このエッジが、受信先ノードに入る incoming edges のうち何番目か(source.x ソート済み)。 */
  toIndex?: number;
  /** 同受信先に入る incoming edges の総数。 */
  toTotal?: number;
};

const ARROW_GAP = 4;
/** ノード幅のうち、起点分散に使える内側マージン(左右 14px ずつ空ける)。 */
const ANCHOR_INSET = 14;

/**
 * ノードの上辺(or 下辺)で N 本のエッジを均等分散させた x 座標を返す。
 *   - total が 1 のときはノード中央
 *   - total が複数のときは [node.x + 14, node.x + NODE_WIDTH - 14] を N 等分
 */
function distributedAnchorX(nodeX: number, index: number, total: number): number {
  if (total <= 1) return nodeX + NODE_WIDTH / 2;
  const left = nodeX + ANCHOR_INSET;
  const right = nodeX + NODE_WIDTH - ANCHOR_INSET;
  // (index + 0.5) / total を [0, 1] に取り、left-right に線形補間
  const t = (index + 0.5) / total;
  return left + (right - left) * t;
}

function Edge({
  edge,
  nodes,
  arrowMarkerId = "arrow",
  fromIndex = 0,
  fromTotal = 1,
  toIndex = 0,
  toTotal = 1,
}: EdgeProps) {
  const fromNode = nodes.find((n) => n.id === edge.from);
  const toNode = nodes.find((n) => n.id === edge.to);
  if (!fromNode || !toNode) return null;

  const fromDepth = fromNode.depth ?? 0;
  const toDepth = toNode.depth ?? 0;
  const isDepthCrossing = fromDepth !== toDepth;

  // v0.1.7 デザイン刷新:
  //   - stroke を 2 → 1.5px、cross-depth は 1.5 → 1.2px に細身化
  //   - グラデーション edge-gradient を使い、出発側薄→終点側濃で進行方向を視覚化
  //   - bidirectional 用の点線パターンも軽量化(6/5 → 5/4)
  const commonStrokeProps = {
    stroke: "url(#edge-gradient)",
    strokeOpacity: isDepthCrossing ? 0.5 : 0.85,
    strokeWidth: isDepthCrossing ? 1.2 : 1.5,
    strokeLinecap: "round" as const,
    strokeDasharray: isDepthCrossing
      ? "3 5"
      : edge.bidirectional
        ? "5 4"
        : undefined,
    markerEnd: `url(#${arrowMarkerId})`,
    markerStart: edge.bidirectional ? `url(#${arrowMarkerId})` : undefined,
    style: { filter: "drop-shadow(0 0 5px rgba(20, 184, 166, 0.35))" },
  };

  // ──────────────────────────────────────────────────
  // Cross-depth(階層跨ぎ):起点・終点を分散して扇形展開
  // ──────────────────────────────────────────────────
  if (isDepthCrossing) {
    const goingDown = toDepth > fromDepth;

    // 起点 = 送信元の下辺(下方向)or 上辺(上方向)、X は分散
    const x1 = distributedAnchorX(fromNode.position.x, fromIndex, fromTotal);
    const y1 = goingDown
      ? fromNode.position.y + NODE_HEIGHT + ARROW_GAP
      : fromNode.position.y - ARROW_GAP;

    // 終点 = 受信先の上辺(下方向)or 下辺(上方向)、X は分散
    const x2 = distributedAnchorX(toNode.position.x, toIndex, toTotal);
    const y2 = goingDown
      ? toNode.position.y - ARROW_GAP
      : toNode.position.y + NODE_HEIGHT + ARROW_GAP;

    return <line x1={x1} y1={y1} x2={x2} y2={y2} {...commonStrokeProps} />;
  }

  // ──────────────────────────────────────────────────
  // 同 depth(同プレーン内):従来通り中心 → 中心の境界計算
  // ──────────────────────────────────────────────────
  const fromCx = fromNode.position.x + NODE_WIDTH / 2;
  const fromCy = fromNode.position.y + NODE_HEIGHT / 2;
  const toCx = toNode.position.x + NODE_WIDTH / 2;
  const toCy = toNode.position.y + NODE_HEIGHT / 2;

  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;

  const ux = dx / len;
  const uy = dy / len;

  const tx = ux !== 0 ? NODE_WIDTH / 2 / Math.abs(ux) : Infinity;
  const ty = uy !== 0 ? NODE_HEIGHT / 2 / Math.abs(uy) : Infinity;
  const t = Math.min(tx, ty) + ARROW_GAP;

  const x1 = fromCx + ux * t;
  const y1 = fromCy + uy * t;
  const x2 = toCx - ux * t;
  const y2 = toCy - uy * t;

  return <line x1={x1} y1={y1} x2={x2} y2={y2} {...commonStrokeProps} />;
}

export default Edge;
