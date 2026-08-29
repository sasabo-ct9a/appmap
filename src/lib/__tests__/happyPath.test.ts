import { describe, expect, it } from "vitest";
import {
  computeReplaySteps,
  computeReplayStepsFine,
  edgeFlowRole,
} from "../happyPath";
import type { ScreenMapResult } from "../claudeCli";
import type { ScreenNode, ScreenEdge } from "../../types/screen";

function node(
  id: number,
  opts: { entry?: boolean; depth?: number } = {},
): ScreenNode {
  return {
    id,
    label: `N${id}`,
    isEntryPoint: opts.entry,
    depth: opts.depth,
    position: { x: 0, y: 0 },
    detail: { title: `N${id}`, body: "", bodyNoCode: "" },
  };
}
function edge(from: number, to: number, bidi = false): ScreenEdge {
  return { id: `${from}-${to}`, from, to, bidirectional: bidi };
}
function result(nodes: ScreenNode[], edges: ScreenEdge[]): ScreenMapResult {
  return { nodes, edges };
}

describe("computeReplaySteps", () => {
  it("一本道は 1 要素ずつのステージになる(流れ外なし)", () => {
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2), edge(2, 3)],
    );
    expect(computeReplaySteps(r)).toEqual({
      stages: [[1], [2], [3]],
      detached: [],
    });
  });

  it("枝分かれは同じステージにまとまる(捨てない)", () => {
    // 1 → 2、2 から 3 と 4 に分岐 → 3 と 4 は同じステージ [3,4]
    // ユーザーの実例(データ取得 → 動画取得 Pexels / Pixabay)そのもの。
    const r = result(
      [node(1, { entry: true }), node(2), node(3), node(4)],
      [edge(1, 2), edge(2, 3), edge(2, 4)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2], [3, 4]]);
  });

  it("分岐後に合流しても最短距離でまとまる", () => {
    // 2 で分岐(3,4)→ 5 で合流。5 は入口から距離 3。
    const r = result(
      [
        node(1, { entry: true }),
        node(2),
        node(3),
        node(4),
        node(5),
      ],
      [edge(1, 2), edge(2, 3), edge(2, 4), edge(3, 5), edge(4, 5)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2], [3, 4], [5]]);
  });

  it("双方向エッジは両向きに通れる", () => {
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2), edge(2, 3, true)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2], [3]]);
  });

  it("entry 未指定なら入次数 0 の要素を入口にする", () => {
    const r = result(
      [node(3), node(1), node(2)],
      [edge(1, 2), edge(2, 3)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2], [3]]);
  });

  it("entry 未指定・全て双方向で入次数 0 が無くても depth/id 最小を入口にする", () => {
    // 2 <-> 1(双方向)。前方向だけ数えると 2 が入次数 0 に見えるが、双方向なので
    // 実質どちらも流入あり → 配列順(先頭 2)でなく depth/id 最小の 1 を入口にする。
    const r = result([node(2), node(1)], [edge(2, 1, true)]);
    expect(computeReplaySteps(r).stages).toEqual([[1], [2]]);
  });

  it("ループがあっても無限に回らない", () => {
    const r = result(
      [node(1, { entry: true }), node(2)],
      [edge(1, 2), edge(2, 1)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2]]);
  });

  it("入口からたどり着けない要素は detached に分ける(本流に混ぜない)", () => {
    // 3 はどこともつながらない孤立要素 → stages に入れず detached に。
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2)],
    );
    const plan = computeReplaySteps(r);
    expect(plan.stages).toEqual([[1], [2]]);
    expect(plan.detached).toEqual([3]);
    expect(plan.stages.flat()).not.toContain(3);
  });

  it("入口へ向かう一方通行しか無い要素も detached(逆流を捏造しない)", () => {
    // 3 → 1(entry)。入口から 3 へ前向きに行く道は無い → detached。
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2), edge(3, 1)],
    );
    const plan = computeReplaySteps(r);
    expect(plan.stages).toEqual([[1], [2]]);
    expect(plan.detached).toEqual([3]);
  });

  it("単一要素・エッジ無しでも壊れない", () => {
    expect(computeReplaySteps(result([node(1)], []))).toEqual({
      stages: [[1]],
      detached: [],
    });
    expect(
      computeReplaySteps(result([node(1, { entry: true }), node(2)], [])),
    ).toEqual({ stages: [[1]], detached: [2] });
    expect(computeReplaySteps(result([], []))).toEqual({
      stages: [],
      detached: [],
    });
  });

  it("サンプル型(入口→2ステップ→双方向のサブ)で入口が先頭に来る", () => {
    // 1(entry)→2→3、3<->4、3<->5 → 4 と 5 は同じ距離でまとまる
    const r = result(
      [node(1, { entry: true }), node(2), node(3), node(4), node(5)],
      [edge(1, 2), edge(2, 3), edge(3, 4, true), edge(3, 5, true)],
    );
    expect(computeReplaySteps(r).stages).toEqual([[1], [2], [3], [4, 5]]);
  });
});

describe("computeReplayStepsFine", () => {
  it("枝分かれも 1 要素ずつ別ステップになる(層版と違い潰さない)", () => {
    // 1 → 2,3,4 の分岐。層版なら [[1],[2,3,4]]。細かい版は 1 つずつ。
    const r = result(
      [node(1, { entry: true }), node(2), node(3), node(4)],
      [edge(1, 2), edge(1, 3), edge(1, 4)],
    );
    expect(computeReplayStepsFine(r).stages).toEqual([[1], [2], [3], [4]]);
  });

  it("各ステップは必ず 1 要素、全要素が 1 回ずつ現れる", () => {
    const r = result(
      [node(1, { entry: true }), node(2), node(3), node(4), node(5)],
      [edge(1, 2), edge(2, 3), edge(2, 4), edge(3, 5), edge(4, 5)],
    );
    const stages = computeReplayStepsFine(r).stages;
    expect(stages.every((s) => s.length === 1)).toBe(true);
    expect(stages.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("BFS の発見順に並ぶ(一本道)", () => {
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2), edge(2, 3)],
    );
    expect(computeReplayStepsFine(r).stages).toEqual([[1], [2], [3]]);
  });

  it("入口からたどり着けない要素は detached(本流に混ぜない)", () => {
    const r = result(
      [node(1, { entry: true }), node(2), node(3)],
      [edge(1, 2)],
    );
    const plan = computeReplayStepsFine(r);
    expect(plan.stages).toEqual([[1], [2]]);
    expect(plan.detached).toEqual([3]);
  });

  it("空でも壊れない", () => {
    expect(computeReplayStepsFine(result([], []))).toEqual({
      stages: [],
      detached: [],
    });
  });
});

describe("edgeFlowRole", () => {
  const active = new Set([2, 3]); // 今のステージ
  const passed = new Set([1]); // 通過済み

  it("前段→今段(順方向)は到達線・逆向きでない", () => {
    expect(edgeFlowRole(1, 2, active, passed)).toEqual({
      arriving: true,
      reversed: false,
    });
  });

  it("今段→前段(逆向き格納/双方向)は到達線・逆向きで描く", () => {
    expect(edgeFlowRole(2, 1, active, passed)).toEqual({
      arriving: true,
      reversed: true,
    });
  });

  it("同ステージどうし(両端 active)は到達線にしない", () => {
    expect(edgeFlowRole(2, 3, active, passed)).toEqual({
      arriving: false,
      reversed: false,
    });
  });

  it("まだ先の要素(未到達)を含む線は到達線にしない", () => {
    expect(edgeFlowRole(2, 9, active, passed)).toEqual({
      arriving: false,
      reversed: false,
    });
  });

  it("集合が null / undefined でも壊れない", () => {
    expect(edgeFlowRole(1, 2, null, null)).toEqual({
      arriving: false,
      reversed: false,
    });
  });
});
