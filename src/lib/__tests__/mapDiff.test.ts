import { describe, expect, it } from "vitest";
import { computeMapDiff } from "../mapDiff";
import type { ScreenMapResult } from "../claudeCli";
import type { ScreenNode } from "../../types/screen";

function node(
  id: number,
  label: string,
  files: string[] = [],
): ScreenNode {
  return {
    id,
    label,
    position: { x: 0, y: 0 },
    detail: {
      title: label,
      body: "",
      bodyNoCode: "",
      files,
    },
  };
}

function result(nodes: ScreenNode[]): ScreenMapResult {
  return { nodes, edges: [] };
}

describe("computeMapDiff", () => {
  it("returns empty diff when previous is null", () => {
    const diff = computeMapDiff(result([node(1, "Home")]), null, "ja");
    expect(diff.hasChanges).toBe(false);
  });

  it("matches identical maps (no changes)", () => {
    const prev = result([node(1, "Home", ["a.ts"]), node(2, "Settings", ["b.ts"])]);
    const curr = result([node(10, "Home", ["a.ts"]), node(20, "Settings", ["b.ts"])]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.hasChanges).toBe(false);
    expect(diff.addedNodeIds.size).toBe(0);
    expect(diff.removedNodes.length).toBe(0);
  });

  it("distinguishes same-label screens by files (fingerprint)", () => {
    // 「設定」が 2 つあるが files が違うので別画面として区別できる
    const prev = result([
      node(1, "設定", ["user-settings.ts"]),
      node(2, "設定", ["app-settings.ts"]),
    ]);
    const curr = result([
      node(10, "設定", ["user-settings.ts"]),
      node(20, "設定", ["app-settings.ts"]),
    ]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.hasChanges).toBe(false);
    expect(diff.ambiguousLabels).toHaveLength(0);
  });

  it("flags ambiguous when same label AND same/no files collide", () => {
    // 「詳細」が files 無しで 2 つ → fingerprint も衝突 → ambiguous
    const prev = result([node(1, "詳細"), node(2, "詳細")]);
    const curr = result([node(10, "詳細"), node(20, "詳細")]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.ambiguousLabels).toContain("詳細");
    // ambiguous なので added/removed に誤って出さない
    expect(diff.addedNodeIds.size).toBe(0);
    expect(diff.removedNodes.length).toBe(0);
  });

  it("detects a genuinely added screen", () => {
    const prev = result([node(1, "Home", ["a.ts"])]);
    const curr = result([node(10, "Home", ["a.ts"]), node(20, "New", ["new.ts"])]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.hasChanges).toBe(true);
    expect(diff.addedNodeIds.has(20)).toBe(true);
  });

  it("detects a genuinely removed screen", () => {
    const prev = result([node(1, "Home", ["a.ts"]), node(2, "Old", ["old.ts"])]);
    const curr = result([node(10, "Home", ["a.ts"])]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.hasChanges).toBe(true);
    expect(diff.removedNodes.map((n) => n.id)).toContain(2);
  });

  it("single screen with empty files is NOT ambiguous", () => {
    // files 空でも 1 つしかなければ衝突しない → ambiguous にしない(誤判定回帰ガード)
    const prev = result([node(1, "Home"), node(2, "設定")]);
    const curr = result([node(10, "Home"), node(20, "設定")]);
    const diff = computeMapDiff(curr, prev, "ja");
    expect(diff.ambiguousLabels).toHaveLength(0);
    expect(diff.hasChanges).toBe(false);
  });
});
