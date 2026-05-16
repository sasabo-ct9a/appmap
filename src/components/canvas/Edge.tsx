import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { NODE_WIDTH, NODE_HEIGHT } from "./NodeTile";

/**
 * ノード間の関係線(CLAUDE.md §10.5.3、DARK モード、Phase 3 polish 版)。
 *
 * Phase 3 Step 3-5 polish:
 *   - ストロークを **Soft Grid → Electric Teal**(0.7 不透明度で抑え目)
 *   - **bidirectional のときだけ破線**(dashed)で視覚的に区別
 *   - 矢印 marker は MapCanvas の `<defs>` で Teal 塗りに更新済み
 *   - `drop-shadow` で淡い Teal の glow(近未来感)
 *
 * 矩形ノード境界までのオフセット計算は変更なし(NODE_WIDTH/HEIGHT が
 * polish で 120×48 → 140×56 に拡大したが、計算式は同じ)。
 */
type EdgeProps = {
  edge: ScreenEdge;
  nodes: ScreenNode[];
  /**
   * SVG `<marker>` id。Phase 3 polish v5 で 2 つの MapCanvas を重ねるとき、
   * 同じ id を持つ marker が複数あると参照がぶつかるため、呼び出し側で固有 id を渡す。
   * 省略時は `"arrow"`(単一 SVG モード後方互換)。
   */
  arrowMarkerId?: string;
};

const ARROW_GAP = 4;

function Edge({ edge, nodes, arrowMarkerId = "arrow" }: EdgeProps) {
  const fromNode = nodes.find((n) => n.id === edge.from);
  const toNode = nodes.find((n) => n.id === edge.to);
  if (!fromNode || !toNode) return null;

  // depth をまたぐエッジは「親→子のコネクタ」として扱い、破線で区別。
  // bidirectional もすでに破線扱いだが、depth-cross の方を優先(より重要な階層遷移)。
  const fromDepth = fromNode.depth ?? 0;
  const toDepth = toNode.depth ?? 0;
  const isDepthCrossing = fromDepth !== toDepth;

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

  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      className="stroke-electric-teal"
      strokeOpacity={isDepthCrossing ? 0.65 : 0.9}
      strokeWidth={isDepthCrossing ? 1.5 : 2}
      strokeDasharray={
        isDepthCrossing
          ? "3 5" // 階層をまたぐ:細かい破線で「縦コネクタ」感
          : edge.bidirectional
            ? "6 5"
            : undefined
      }
      markerEnd={`url(#${arrowMarkerId})`}
      markerStart={edge.bidirectional ? `url(#${arrowMarkerId})` : undefined}
      style={{ filter: "drop-shadow(0 0 4px rgba(20, 184, 166, 0.6))" }}
    />
  );
}

export default Edge;
