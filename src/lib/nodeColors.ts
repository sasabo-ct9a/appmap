import type { ScreenNode, ScreenEdge } from "../types/screen";
import { pickLocalized, type Language } from "./i18n";

/**
 * v0.1.7:AI が付ける node.id は分析ごとに変わるので、id 直参照でパレット色を
 * 決めると再解析ごとに色がシャッフルされる。中心度(degree)+ label 順で
 * 安定インデックスを算出し、それを介して色を決めることで
 *   - 中心的(=connectivity が高い)要素は常にパレット先頭色(teal)
 *   - 順位が同じなら label のロケール順で決定
 * となり、同じ意味の要素はどの分析でも同じ色になる。
 */

export const NODE_PALETTE = [
  { fill: "#14B8A6", accent: "#14B8A6", soft: "#CCFBF1", border: "#5EEAD4", text: "#0D9488" },
  { fill: "#F59E0B", accent: "#F59E0B", soft: "#FEF3C7", border: "#FCD34D", text: "#B45309" },
  { fill: "#8B5CF6", accent: "#8B5CF6", soft: "#EDE9FE", border: "#C4B5FD", text: "#6D28D9" },
  { fill: "#3B82F6", accent: "#3B82F6", soft: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8" },
  { fill: "#EC4899", accent: "#EC4899", soft: "#FCE7F3", border: "#F9A8D4", text: "#BE185D" },
  { fill: "#10B981", accent: "#10B981", soft: "#D1FAE5", border: "#6EE7B7", text: "#047857" },
  { fill: "#06B6D4", accent: "#06B6D4", soft: "#CFFAFE", border: "#67E8F9", text: "#0E7490" },
  { fill: "#F97316", accent: "#F97316", soft: "#FFEDD5", border: "#FDBA74", text: "#C2410C" },
];

export type NodeColor = (typeof NODE_PALETTE)[number];

export function paletteAt(index: number): NodeColor {
  return NODE_PALETTE[((index % NODE_PALETTE.length) + NODE_PALETTE.length) % NODE_PALETTE.length];
}

/**
 * 全ノードを degree 降順 + ロケール順で並べた「安定インデックス」を返す。
 * entryPoint は先頭に固定(index=0)。
 */
export function computeStableColorIndex(
  nodes: ScreenNode[],
  edges: ScreenEdge[],
  language: Language,
): Map<number, number> {
  const map = new Map<number, number>();
  if (nodes.length === 0) return map;

  const entry = nodes.find((n) => n.isEntryPoint);
  const others = entry ? nodes.filter((n) => n.id !== entry.id) : [...nodes];

  const degreeOf = (id: number) =>
    edges.reduce(
      (a, e) => a + (e.from === id ? 1 : 0) + (e.to === id ? 1 : 0),
      0,
    );
  const stableLabel = (n: ScreenNode) => {
    const src = n.userIntent ?? n.label;
    const s = pickLocalized(src, language);
    return s || String(n.id);
  };

  others.sort((a, b) => {
    const dd = degreeOf(b.id) - degreeOf(a.id);
    if (dd !== 0) return dd;
    return stableLabel(a).localeCompare(stableLabel(b), "ja");
  });

  let idx = 0;
  if (entry) {
    map.set(entry.id, idx++);
  }
  for (const n of others) {
    map.set(n.id, idx++);
  }
  return map;
}
