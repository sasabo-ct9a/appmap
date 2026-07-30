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
 * 代わりに **fingerprint**(ラベル + 関連ファイル)で対応付ける。ラベル単体だと
 * 「設定」「詳細」など同名の画面が複数あるとき Map が後勝ちで片方消える誤判定に
 * なるため、files を含めた複合キーにする。
 *
 * 同一 fingerprint が複数ある(fingerprint でも区別できない)場合は "ambiguous" と
 * して差分計算から外し、その旨を ambiguousLabels に出す(嘘の added/removed を出すより
 * 「比較不能」と正直に伝える)。
 *
 * 出力:
 *   - addedNodeIds:今回のノード id で、前回に対応が無かったもの(新規追加)
 *   - removedNodes:前回のノードで、今回に対応が無かったもの(削除された)
 *   - unchangedNodeIdMap:今回 id → 前回 id の対応表(将来のノード単位差分に)
 *   - addedEdges:今回のエッジ id で、前回に対応が無かったもの
 *   - removedEdges:前回のエッジで、今回に対応が無かったもの
 *   - ambiguousLabels:fingerprint 衝突で比較できなかった画面ラベル
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
  /** fingerprint 衝突で比較不能だった画面ラベル(UI に「同名画面のため比較不能」と出す) */
  ambiguousLabels: string[];
  hasChanges: boolean;
};

/** 画面ラベルを比較用に正規化(小文字化・trim・全角空白削除)*/
function nodeLabel(n: ScreenNode, language: Language): string {
  const src = n.userIntent ?? n.label;
  const s = pickLocalized(src, language);
  return (s ?? "").toString().toLowerCase().replace(/[\s　]+/g, "").trim();
}

/**
 * fingerprint:ラベル + 関連ファイル(正規化・ソート)。files はパスなので言語非依存。
 * 同名でも参照ファイルが違えば別画面として区別できる。files が両方空だとラベルのみに
 * fallback するため、同名 + files 無しは衝突しうる(その場合は ambiguous 扱いになる)。
 */
function nodeFingerprint(n: ScreenNode, language: Language): string {
  const label = nodeLabel(n, language);
  const files = (n.detail?.files ?? [])
    .map((f) => f.toLowerCase().replace(/\\/g, "/").trim())
    .filter(Boolean)
    .sort();
  return `${label}||${files.join(",")}`;
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
    ambiguousLabels: [],
    hasChanges: false,
  };
}

/** fingerprint → count を数え、複数回出るものは ambiguous(区別不能)とみなす。 */
function buildFingerprintIndex(
  nodes: ScreenNode[],
  language: Language,
): { unique: Map<string, ScreenNode>; ambiguous: Set<string> } {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const fp = nodeFingerprint(n, language);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  const unique = new Map<string, ScreenNode>();
  const ambiguous = new Set<string>();
  for (const n of nodes) {
    const fp = nodeFingerprint(n, language);
    if ((counts.get(fp) ?? 0) > 1) {
      ambiguous.add(fp);
    } else {
      unique.set(fp, n);
    }
  }
  return { unique, ambiguous };
}

export function computeMapDiff(
  current: ScreenMapResult,
  previous: ScreenMapResult | null | undefined,
  language: Language,
): MapDiff {
  if (!previous) return emptyDiff();

  const prev = buildFingerprintIndex(previous.nodes, language);
  const curr = buildFingerprintIndex(current.nodes, language);

  // ambiguous(どちらかで fingerprint 衝突)は差分計算から除外。
  const ambiguousFps = new Set<string>([...prev.ambiguous, ...curr.ambiguous]);
  const ambiguousLabels: string[] = [];
  for (const n of [...previous.nodes, ...current.nodes]) {
    const fp = nodeFingerprint(n, language);
    if (ambiguousFps.has(fp)) {
      const label = nodeLabel(n, language);
      if (label && !ambiguousLabels.includes(label)) ambiguousLabels.push(label);
    }
  }

  const addedNodeIds = new Set<number>();
  const unchangedNodeIdMap = new Map<number, number>();
  for (const cn of current.nodes) {
    const fp = nodeFingerprint(cn, language);
    if (ambiguousFps.has(fp)) continue; // 比較不能はスキップ
    const pn = prev.unique.get(fp);
    if (pn) unchangedNodeIdMap.set(cn.id, pn.id);
    else addedNodeIds.add(cn.id);
  }
  const removedNodes: ScreenNode[] = [];
  for (const pn of previous.nodes) {
    const fp = nodeFingerprint(pn, language);
    if (ambiguousFps.has(fp)) continue;
    if (!curr.unique.has(fp)) removedNodes.push(pn);
  }

  // エッジ差分:ID → fingerprint map を作って比較(fingerprint で ID 揺れ吸収)
  const prevIdToFp = new Map<number, string>();
  for (const n of previous.nodes) prevIdToFp.set(n.id, nodeFingerprint(n, language));
  const currIdToFp = new Map<number, string>();
  for (const n of current.nodes) currIdToFp.set(n.id, nodeFingerprint(n, language));

  // ambiguous ノードに接続するエッジも差分から外す(誤判定回避)
  const edgeTouchesAmbiguous = (e: ScreenEdge, idToFp: Map<number, string>) =>
    ambiguousFps.has(idToFp.get(e.from) ?? "") ||
    ambiguousFps.has(idToFp.get(e.to) ?? "");

  const prevEdgeKeys = new Set<string>();
  for (const e of previous.edges) {
    if (edgeTouchesAmbiguous(e, prevIdToFp)) continue;
    prevEdgeKeys.add(edgeKey(e, prevIdToFp));
  }
  const currEdgeKeys = new Set<string>();
  for (const e of current.edges) {
    if (edgeTouchesAmbiguous(e, currIdToFp)) continue;
    currEdgeKeys.add(edgeKey(e, currIdToFp));
  }

  const addedEdges = new Set<string>();
  for (const ce of current.edges) {
    if (edgeTouchesAmbiguous(ce, currIdToFp)) continue;
    if (!prevEdgeKeys.has(edgeKey(ce, currIdToFp))) addedEdges.add(ce.id);
  }
  const removedEdges: ScreenEdge[] = [];
  for (const pe of previous.edges) {
    if (edgeTouchesAmbiguous(pe, prevIdToFp)) continue;
    if (!currEdgeKeys.has(edgeKey(pe, prevIdToFp))) removedEdges.push(pe);
  }

  return {
    addedNodeIds,
    removedNodes,
    unchangedNodeIdMap,
    addedEdges,
    removedEdges,
    ambiguousLabels,
    hasChanges:
      addedNodeIds.size > 0 ||
      removedNodes.length > 0 ||
      addedEdges.size > 0 ||
      removedEdges.length > 0,
  };
}
