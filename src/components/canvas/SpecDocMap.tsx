import type {
  ScreenNode,
  ScreenEdge,
  LocalizedText,
} from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7 仕様書 PDF 用の静的マインドマップ SVG。
 *
 * MapCanvas のレイアウト計算と同じ式を使うが、interactivity(zoom/pan/drag)は
 * 全部削ぎ落とす。コンポーネントは pure に状態を持たないので、印刷時にも安定する。
 *
 * 中心ノードは持たない(MapCanvas と同じく撤去済み)。主枝 + 葉 + 関連エッジを描く。
 */
type SpecDocMapProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  language: Language;
  /** ユーザーが MapCanvas で動かした位置の差分(SVG 座標)*/
  nodeOffsets?: Map<number, { x: number; y: number }>;
};

const BRANCH_W = 172;
const BRANCH_H = 70;
const LEAF_H = 28;
const LEAF_GAP_X = 90;
const LEAF_SPACING_Y = 38;
const LEAF_FAN_X = 14;

const PALETTE = [
  { accent: "#14B8A6", border: "#5EEAD4", soft: "#CCFBF1", text: "#0D9488" },
  { accent: "#F59E0B", border: "#FCD34D", soft: "#FEF3C7", text: "#B45309" },
  { accent: "#8B5CF6", border: "#C4B5FD", soft: "#EDE9FE", text: "#6D28D9" },
  { accent: "#3B82F6", border: "#93C5FD", soft: "#DBEAFE", text: "#1D4ED8" },
  { accent: "#EC4899", border: "#F9A8D4", soft: "#FCE7F3", text: "#BE185D" },
  { accent: "#10B981", border: "#6EE7B7", soft: "#D1FAE5", text: "#047857" },
  { accent: "#06B6D4", border: "#67E8F9", soft: "#CFFAFE", text: "#0E7490" },
  { accent: "#F97316", border: "#FDBA74", soft: "#FFEDD5", text: "#C2410C" },
];
function paletteFor(id: number) {
  return PALETTE[(id - 1) % PALETTE.length];
}

function estimateTextWidth(text: string, isJa: boolean): number {
  return text.length * (isJa ? 12 : 7) + 32;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function SpecDocMap({
  nodes,
  edges,
  language,
  nodeOffsets,
}: SpecDocMapProps) {
  if (nodes.length === 0) return null;
  const offsetFor = (id: number) =>
    nodeOffsets?.get(id) ?? { x: 0, y: 0 };

  const N = nodes.length;
  const entry = nodes.find((n) => n.isEntryPoint);
  const othersRaw = entry ? nodes.filter((n) => n.id !== entry.id) : nodes;

  // 交差削減:連結ノード同士を隣接させる greedy 順序
  const otherIds = new Set(othersRaw.map((n) => n.id));
  const adjacency = new Map<number, Set<number>>();
  for (const e of edges) {
    if (!otherIds.has(e.from) || !otherIds.has(e.to)) continue;
    adjacency.set(e.from, (adjacency.get(e.from) ?? new Set()).add(e.to));
    adjacency.set(e.to, (adjacency.get(e.to) ?? new Set()).add(e.from));
  }
  const degree = (id: number) => adjacency.get(id)?.size ?? 0;
  const ordered: ScreenNode[] = [];
  const visited = new Set<number>();
  if (othersRaw.length > 0) {
    const start = [...othersRaw].sort(
      (a, b) => degree(b.id) - degree(a.id),
    )[0];
    ordered.push(start);
    visited.add(start.id);
    while (ordered.length < othersRaw.length) {
      const last = ordered[ordered.length - 1];
      const neighbors = adjacency.get(last.id) ?? new Set();
      let next: ScreenNode | null = null;
      for (const n of othersRaw) {
        if (visited.has(n.id)) continue;
        if (!neighbors.has(n.id)) continue;
        if (!next || degree(n.id) > degree(next.id)) next = n;
      }
      if (!next) {
        for (const n of othersRaw) {
          if (visited.has(n.id)) continue;
          if (!next || degree(n.id) > degree(next.id)) next = n;
        }
      }
      if (!next) break;
      ordered.push(next);
      visited.add(next.id);
    }
  }
  const others = ordered;
  const M = others.length;
  const leafCap = N >= 10 ? 4 : N >= 7 ? 5 : 7;
  const R_branch = M > 0 ? Math.max(220, 110 + M * 36) : 0;
  const leafOuterReach = BRANCH_W / 2 + LEAF_GAP_X + 200;
  const reach = R_branch + leafOuterReach;
  const W = Math.max(1100, reach * 2 + 120);
  const heightForLeaves = leafCap * LEAF_SPACING_Y + 80;
  const H = Math.max(620, reach * 2 + heightForLeaves * 0.4);
  const cx = W / 2;
  const cy = H / 2;

  type BranchPos = { x: number; y: number; angle: number };
  type LeafPos = { x: number; y: number; w: number; label: string };
  const branchPositions = new Map<number, BranchPos>();
  const leafPositions = new Map<number, LeafPos[]>();

  // 中心にエントリーポイント(葉なし)
  if (entry) {
    const off = offsetFor(entry.id);
    branchPositions.set(entry.id, { x: cx + off.x, y: cy + off.y, angle: 0 });
    leafPositions.set(entry.id, []);
  }

  // 周囲のノードを放射状に
  others.forEach((node, i) => {
    const angleDeg = M > 0 ? -135 + (360 / M) * i : 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const off = offsetFor(node.id);
    const bx = cx + R_branch * Math.cos(angleRad) + off.x;
    const by = cy + R_branch * Math.sin(angleRad) + off.y;
    branchPositions.set(node.id, { x: bx, y: by, angle: angleRad });

    const leafSourceAll: LocalizedText[] =
      node.subActions && node.subActions.length > 0
        ? node.subActions
        : node.detail.dataUsed ?? [];
    const leafSource = leafSourceAll.slice(0, leafCap);

    const isJa = language === "ja";
    const isRight = Math.cos(angleRad) >= 0;
    const sign = isRight ? 1 : -1;
    const baseColumnX = bx + sign * (BRANCH_W / 2 + LEAF_GAP_X);
    const K = leafSource.length;
    const leaves = leafSource.map((leaf, k) => {
      const label = pickLocalized(leaf, language);
      const w = estimateTextWidth(label, isJa);
      const offset = k - (K - 1) / 2;
      const leafY = by + offset * LEAF_SPACING_Y;
      const leafX = baseColumnX + sign * Math.abs(offset) * LEAF_FAN_X;
      return { x: leafX, y: leafY, w, label };
    });
    leafPositions.set(node.id, leaves);
  });

  // ユーザーがノードを動かした分も含めて viewBox を再計算(全要素を内包するよう拡張)
  let minX = 0,
    minY = 0,
    maxX = W,
    maxY = H;
  branchPositions.forEach((b) => {
    minX = Math.min(minX, b.x - BRANCH_W / 2 - 20);
    minY = Math.min(minY, b.y - BRANCH_H / 2 - 40);
    maxX = Math.max(maxX, b.x + BRANCH_W / 2 + 20);
    maxY = Math.max(maxY, b.y + BRANCH_H / 2 + 20);
  });
  leafPositions.forEach((leaves) => {
    leaves.forEach((leaf) => {
      minX = Math.min(minX, leaf.x - leaf.w / 2 - 10);
      minY = Math.min(minY, leaf.y - LEAF_H / 2 - 10);
      maxX = Math.max(maxX, leaf.x + leaf.w / 2 + 10);
      maxY = Math.max(maxY, leaf.y + LEAF_H / 2 + 10);
    });
  });
  const vbX = minX;
  const vbY = minY;
  const vbW = maxX - minX;
  const vbH = maxY - minY;

  return (
    <div className="spec-doc-map">
      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}
        aria-label={language === "ja" ? "アプリ構造マインドマップ" : "App mind map"}
      >
        {/* 関連エッジ(実線、控えめ)*/}
        <g>
          {edges.map((edge) => {
            const fromB = branchPositions.get(edge.from);
            const toB = branchPositions.get(edge.to);
            if (!fromB || !toB) return null;
            const fromP = paletteFor(edge.from);
            const midX = (fromB.x + toB.x) / 2;
            const midY = (fromB.y + toB.y) / 2;
            const dx = midX - cx;
            const dy = midY - cy;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const pushOut = 80;
            const pullX = midX + (dx / d) * pushOut;
            const pullY = midY + (dy / d) * pushOut;
            return (
              <path
                key={edge.id}
                d={`M ${fromB.x} ${fromB.y} Q ${pullX} ${pullY} ${toB.x} ${toB.y}`}
                fill="none"
                stroke={fromP.accent}
                strokeOpacity={0.35}
                strokeWidth={1.4}
                strokeLinecap="round"
              />
            );
          })}
        </g>

        {/* 主枝 → 葉(色付きライン)*/}
        <g>
          {nodes.map((node) => {
            const b = branchPositions.get(node.id);
            const leaves = leafPositions.get(node.id);
            if (!b || !leaves) return null;
            const p = paletteFor(node.id);
            const isRight = b.x >= cx;
            const sign = isRight ? 1 : -1;
            const branchEdgeX = b.x + sign * (BRANCH_W / 2 - 4);
            const branchEdgeY = b.y;
            return leaves.map((leaf, i) => {
              const leafEdgeX = leaf.x - sign * (leaf.w / 2);
              const leafEdgeY = leaf.y;
              const midX = (branchEdgeX + leafEdgeX) / 2;
              const midY = (branchEdgeY + leafEdgeY) / 2;
              return (
                <path
                  key={`leaf-${node.id}-${i}`}
                  d={`M ${branchEdgeX} ${branchEdgeY} Q ${midX} ${midY} ${leafEdgeX} ${leafEdgeY}`}
                  fill="none"
                  stroke={p.accent}
                  strokeOpacity={0.5}
                  strokeWidth={1.3}
                  strokeDasharray="3 4"
                  strokeLinecap="round"
                />
              );
            });
          })}
        </g>

        {/* 葉チップ */}
        <g>
          {nodes.map((node) => {
            const leaves = leafPositions.get(node.id);
            if (!leaves) return null;
            const p = paletteFor(node.id);
            return leaves.map((leaf, i) => (
              <g key={`chip-${node.id}-${i}`}>
                <rect
                  x={leaf.x - leaf.w / 2}
                  y={leaf.y - LEAF_H / 2}
                  width={leaf.w}
                  height={LEAF_H}
                  rx={LEAF_H / 2}
                  fill={p.soft}
                  stroke={p.border}
                  strokeWidth={1}
                />
                <text
                  x={leaf.x}
                  y={leaf.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={p.text}
                  fontSize="11.5"
                  fontWeight="600"
                >
                  {leaf.label}
                </text>
              </g>
            ));
          })}
        </g>

        {/* 主枝ピル */}
        <g>
          {nodes.map((node) => {
            const b = branchPositions.get(node.id);
            if (!b) return null;
            const p = paletteFor(node.id);
            const title = pickLocalized(node.userIntent ?? node.label, language);
            const subtitle = pickLocalized(node.detail.title, language);
            const x = b.x - BRANCH_W / 2;
            const y = b.y - BRANCH_H / 2;
            return (
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width={BRANCH_W}
                  height={BRANCH_H}
                  rx={BRANCH_H / 2}
                  fill={p.soft}
                  stroke={p.border}
                  strokeWidth={2}
                />
                <text
                  x={b.x}
                  y={b.y - 8}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={p.text}
                  fontSize="15"
                  fontWeight="700"
                >
                  {truncate(title, 11)}
                </text>
                <text
                  x={b.x}
                  y={b.y + 13}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#64748b"
                  fontSize="10.5"
                >
                  {truncate(subtitle, 16)}
                </text>
                {node.isEntryPoint && (
                  <g>
                    <rect
                      x={b.x - 36}
                      y={y - 18}
                      width={72}
                      height={16}
                      rx={8}
                      fill={p.accent}
                    />
                    <text
                      x={b.x}
                      y={y - 9}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="white"
                      fontSize="9"
                      fontWeight="700"
                    >
                      {language === "ja" ? "▶ はじまり" : "▶ START"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export default SpecDocMap;
