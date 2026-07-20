import type {
  ScreenNode,
  ScreenEdge,
} from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";
import { pickLocalized, type Language } from "./i18n";

/**
 * v0.1.8:差分マップ計算。
 *
 * 前提:AI は分析ごとに ID を振り直すので、`node.id` では前回と比較できない。
 * 代わりに **画面ラベル**(userIntent → 無ければ label)を正規化した文字列で
 * マッチングする。表記ゆれ(大小・空白)は吸収するが、意味レベルの差は無視。
 *
 * 出力:
 *   - addedNodeIds:今回のノード id で、前回に対応が無かったもの(新規追加)
 *   - removedNodes:前回のノードで、今回に対応が無かったもの(削除された)
 *   - unchangedNodeIdMap:今回 id → 前回 id の対応表(将来のノード単位差分に)
 *   - addedEdges:今回のエッジ id で、前回に対応が無かったもの
 *   - removedEdges:前回のエッジで、今回に対応が無かったもの
 *   - hasChanges:上記どれかが空でなければ true
 *
 * 想定利用:再分析後に「AI が勝手に増やした / 消した画面」を可視化する。
 */

export type MapDiff = {
  addedNodeIds: Set<number>;
  removedNodes: ScreenNode[];
  unchangedNodeIdMap: Map<number, number>;
  addedEdges: Set<string>;
  removedEdges: ScreenEdge[];
  hasChanges: boolean;
};

/** 画面ラベルを比較用に正規化(小文字化・trim・全角空白削除)*/
function nodeKey(n: ScreenNode, language: Language): string {
  const src = n.userIntent ?? n.label;
  const s = pickLocalized(src, language);
  // ゆるく正規化:同じ画面と見なす閾値を上げる
  return (s ?? "").toString().toLowerCase().replace(/[\s　]+/g, "").trim();
}

/** エッジを (from-label → to-label) キーに変換(ID の揺れを吸収)*/
function edgeKey(
  e: ScreenEdge,
  nodeKeyById: Map<number, string>,
): string {
  const from = nodeKeyById.get(e.from) ?? String(e.from);
  const to = nodeKeyById.get(e.to) ?? String(e.to);
  return e.bidirectional
    ? [from, to].sort().join("<->") // 双方向は方向を無視
    : `${from}->${to}`;
}

/** 前回結果が無ければ空の差分(hasChanges=false)*/
export function emptyDiff(): MapDiff {
  return {
    addedNodeIds: new Set(),
    removedNodes: [],
    unchangedNodeIdMap: new Map(),
    addedEdges: new Set(),
    removedEdges: [],
    hasChanges: false,
  };
}

export function computeMapDiff(
  current: ScreenMapResult,
  previous: ScreenMapResult | null | undefined,
  language: Language,
): MapDiff {
  if (!previous) return emptyDiff();

  // ラベル → ノード のマップ(前回・今回)
  const prevKeyToNode = new Map<string, ScreenNode>();
  for (const n of previous.nodes) {
    const k = nodeKey(n, language);
    if (k) prevKeyToNode.set(k, n);
  }
  const currKeyToNode = new Map<string, ScreenNode>();
  for (const n of current.nodes) {
    const k = nodeKey(n, language);
    if (k) currKeyToNode.set(k, n);
  }

  const addedNodeIds = new Set<number>();
  const unchangedNodeIdMap = new Map<number, number>();
  for (const cn of current.nodes) {
    const k = nodeKey(cn, language);
    const pn = k ? prevKeyToNode.get(k) : undefined;
    if (pn) unchangedNodeIdMap.set(cn.id, pn.id);
    else addedNodeIds.add(cn.id);
  }
  const removedNodes: ScreenNode[] = [];
  for (const pn of previous.nodes) {
    const k = nodeKey(pn, language);
    if (!k || !currKeyToNode.has(k)) removedNodes.push(pn);
  }

  // エッジ差分:ID map をラベルで作って比較
  const prevIdToKey = new Map<number, string>();
  for (const n of previous.nodes) prevIdToKey.set(n.id, nodeKey(n, language));
  const currIdToKey = new Map<number, string>();
  for (const n of current.nodes) currIdToKey.set(n.id, nodeKey(n, language));

  const prevEdgeKeys = new Set<string>();
  for (const e of previous.edges) prevEdgeKeys.add(edgeKey(e, prevIdToKey));
  const currEdgeKeys = new Set<string>();
  for (const e of current.edges) currEdgeKeys.add(edgeKey(e, currIdToKey));

  const addedEdges = new Set<string>();
  for (const ce of current.edges) {
    if (!prevEdgeKeys.has(edgeKey(ce, currIdToKey))) addedEdges.add(ce.id);
  }
  const removedEdges: ScreenEdge[] = [];
  for (const pe of previous.edges) {
    if (!currEdgeKeys.has(edgeKey(pe, prevIdToKey))) removedEdges.push(pe);
  }

  return {
    addedNodeIds,
    removedNodes,
    unchangedNodeIdMap,
    addedEdges,
    removedEdges,
    hasChanges:
      addedNodeIds.size > 0 ||
      removedNodes.length > 0 ||
      addedEdges.size > 0 ||
      removedEdges.length > 0,
  };
}
