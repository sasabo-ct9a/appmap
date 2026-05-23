import type { ScreenNode } from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";

/**
 * 2 つの ScreenMapResult を比較してノード単位の差分を出す(v0.1.4 比較モード)。
 *
 * マッチ戦略:
 *   - `sameFolder=true` のとき:同じフォルダの再分析を想定し、**node.id** で一致判定
 *   - `sameFolder=false` のとき:別フォルダ同士、**label の正規化文字列** で一致判定
 *     (大小・前後空白を無視、完全一致のみ。曖昧マッチは将来課題)
 *
 * フィールド比較(modified 判定):
 *   - label / detail.title / detail.body / detail.bodyNoCode / depth /
 *     detail.files(配列の中身を sort して比較)/ detail.dataUsed / userIntent / isEntryPoint
 *
 * 注意:
 *   - source.appSummary は別フィールドなので summary 比較も別途返す
 *   - edges の diff も付随的に出す(数値カウントのみ、対象ペアは出さない)
 */

export type DiffMatchedNode = {
  base: ScreenNode;
  compare: ScreenNode;
  changedFields: string[];
};

export type ScreenDiffResult = {
  /** base のみに存在 = compare から見て「削除された」 */
  onlyInBase: ScreenNode[];
  /** compare のみに存在 = base から見て「追加された」(別フォルダなら「相手だけにある」) */
  onlyInCompare: ScreenNode[];
  /** 両方にあり、内容が変わったもの */
  modified: DiffMatchedNode[];
  /** 両方にあり、内容が一致するもの */
  unchanged: DiffMatchedNode[];
  /** appSummary 同士の比較。changed=true なら変化あり */
  summaryDiff: {
    changed: boolean;
    base: string | undefined;
    compare: string | undefined;
  };
  /** エッジ数の差分(数値のみ) */
  edgeCountDiff: {
    base: number;
    compare: number;
    delta: number;
  };
  /** マッチ戦略(UI 表示用) */
  matchedBy: "id" | "label";
};

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

function fieldsChanged(a: ScreenNode, b: ScreenNode): string[] {
  const changed: string[] = [];
  if (a.label !== b.label) changed.push("label");
  if ((a.userIntent ?? "") !== (b.userIntent ?? "")) changed.push("userIntent");
  if ((a.depth ?? 0) !== (b.depth ?? 0)) changed.push("depth");
  if (!!a.isEntryPoint !== !!b.isEntryPoint) changed.push("isEntryPoint");
  if (a.detail.title !== b.detail.title) changed.push("title");
  if (a.detail.body !== b.detail.body) changed.push("body");
  if (a.detail.bodyNoCode !== b.detail.bodyNoCode) changed.push("bodyNoCode");

  const aFiles = (a.detail.files ?? []).slice().sort().join("|");
  const bFiles = (b.detail.files ?? []).slice().sort().join("|");
  if (aFiles !== bFiles) changed.push("files");

  const aData = (a.detail.dataUsed ?? []).slice().sort().join("|");
  const bData = (b.detail.dataUsed ?? []).slice().sort().join("|");
  if (aData !== bData) changed.push("dataUsed");

  const aHint = a.detail.changeHint
    ? `${a.detail.changeHint.safety}|${a.detail.changeHint.note}`
    : "";
  const bHint = b.detail.changeHint
    ? `${b.detail.changeHint.safety}|${b.detail.changeHint.note}`
    : "";
  if (aHint !== bHint) changed.push("changeHint");

  return changed;
}

export function computeScreenDiff(
  base: ScreenMapResult,
  compare: ScreenMapResult,
  sameFolder: boolean,
): ScreenDiffResult {
  const matchedBy: "id" | "label" = sameFolder ? "id" : "label";

  // base/compare それぞれのキーセットを作る
  const keyOf = (n: ScreenNode) =>
    matchedBy === "id" ? String(n.id) : normalizeLabel(n.label);

  const baseMap = new Map<string, ScreenNode>();
  for (const n of base.nodes) baseMap.set(keyOf(n), n);
  const compareMap = new Map<string, ScreenNode>();
  for (const n of compare.nodes) compareMap.set(keyOf(n), n);

  const onlyInBase: ScreenNode[] = [];
  const onlyInCompare: ScreenNode[] = [];
  const modified: DiffMatchedNode[] = [];
  const unchanged: DiffMatchedNode[] = [];

  for (const [k, baseNode] of baseMap.entries()) {
    const compareNode = compareMap.get(k);
    if (!compareNode) {
      onlyInBase.push(baseNode);
      continue;
    }
    const changedFields = fieldsChanged(baseNode, compareNode);
    const entry: DiffMatchedNode = {
      base: baseNode,
      compare: compareNode,
      changedFields,
    };
    if (changedFields.length === 0) {
      unchanged.push(entry);
    } else {
      modified.push(entry);
    }
  }

  for (const [k, compareNode] of compareMap.entries()) {
    if (!baseMap.has(k)) onlyInCompare.push(compareNode);
  }

  return {
    onlyInBase,
    onlyInCompare,
    modified,
    unchanged,
    summaryDiff: {
      changed: (base.appSummary ?? "") !== (compare.appSummary ?? ""),
      base: base.appSummary,
      compare: compare.appSummary,
    },
    edgeCountDiff: {
      base: base.edges.length,
      compare: compare.edges.length,
      delta: base.edges.length - compare.edges.length,
    },
    matchedBy,
  };
}

/**
 * フィールド名(internal)を日本語の表示ラベルに変換。
 * DiffPanel で「何が変わったか」を人間向けに見せる用。
 */
export function fieldLabel(field: string): string {
  switch (field) {
    case "label":
      return "ラベル";
    case "userIntent":
      return "ユーザー行動";
    case "depth":
      return "階層";
    case "isEntryPoint":
      return "起点マーク";
    case "title":
      return "タイトル";
    case "body":
      return "説明文(技術版)";
    case "bodyNoCode":
      return "説明文(ノーコード版)";
    case "files":
      return "対応ファイル";
    case "dataUsed":
      return "使うデータ";
    case "changeHint":
      return "変更目安";
    default:
      return field;
  }
}
