import { describe, it, expect } from "vitest";
import {
  orderRingNodes,
  countRingCrossings,
  ringBasePosition,
  pillBoundaryPoint,
  buildEdgeSeparation,
  ringEdgePath,
} from "../mapLayout";
import type { ScreenEdge } from "../../types/screen";

const edge = (from: number, to: number): ScreenEdge => ({
  id: `${from}-${to}`,
  from,
  to,
});
const label = (n: { id: number }) => String(n.id);

describe("orderRingNodes", () => {
  // サンプル:entry=1(中心)、others=2,3,4,5。edges 1-2,2-3,3-4,3-5(木)。
  //   リング上のエッジは 2-3,3-4,3-5(1-2 は入口=中心への放射なので除外)。
  const others = [2, 3, 4, 5].map((id) => ({ id }));
  const edges = [edge(1, 2), edge(2, 3), edge(3, 4), edge(3, 5)];

  it("決定的:入力順を変えても同じ並びになる", () => {
    const a = orderRingNodes(others, edges, { labelOf: label }).map((n) => n.id);
    const shuffled = [5, 2, 4, 3].map((id) => ({ id }));
    const b = orderRingNodes(shuffled, edges, { labelOf: label }).map((n) => n.id);
    expect(b).toEqual(a);
  });

  it("木なので交差0にできる", () => {
    const ordered = orderRingNodes(others, edges, { labelOf: label }).map(
      (n) => n.id,
    );
    expect(countRingCrossings(ordered, edges)).toBe(0);
  });

  it("兄弟(3 の子 4,5)が隣接スロットに並ぶ", () => {
    const ordered = orderRingNodes(others, edges, { labelOf: label }).map(
      (n) => n.id,
    );
    expect(Math.abs(ordered.indexOf(4) - ordered.indexOf(5))).toBe(1);
  });

  it("0/1 ノードでも throw しない", () => {
    expect(orderRingNodes([], edges, { labelOf: label })).toEqual([]);
    expect(
      orderRingNodes([{ id: 9 }], edges, { labelOf: label }).map((n) => n.id),
    ).toEqual([9]);
  });
});

describe("countRingCrossings", () => {
  it("交互に並ぶ 2 弦は交差1、並べ替えれば0", () => {
    const edges = [edge(10, 30), edge(20, 40)];
    expect(countRingCrossings([10, 20, 30, 40], edges)).toBe(1);
    expect(countRingCrossings([10, 30, 20, 40], edges)).toBe(0);
  });
});

describe("buildEdgeSeparation", () => {
  it("同回廊の平行エッジに index/count を割り当てる", () => {
    const slot = new Map([
      [2, 0],
      [3, 1],
    ]);
    const edges: ScreenEdge[] = [
      edge(2, 3),
      { id: "dup", from: 2, to: 3 },
    ];
    const sep = buildEdgeSeparation(edges, (id) => slot.get(id));
    expect(sep.get("2-3")?.count).toBe(2);
    expect(sep.get("dup")?.count).toBe(2);
    expect(
      [sep.get("2-3")!.index, sep.get("dup")!.index].sort(),
    ).toEqual([0, 1]);
  });

  it("単独エッジは count 1", () => {
    const slot = new Map([
      [2, 0],
      [3, 1],
    ]);
    const sep = buildEdgeSeparation([edge(2, 3)], (id) => slot.get(id));
    expect(sep.get("2-3")).toEqual({ index: 0, count: 1 });
  });
});

describe("pillBoundaryPoint", () => {
  it("矩形境界上に乗る", () => {
    const p = pillBoundaryPoint(0, 0, 10, 5, 100, 0, 0);
    expect(p.x).toBeCloseTo(10, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });
});

describe("ringBasePosition", () => {
  it("R=0(ノード0)でも中心に返る", () => {
    const p = ringBasePosition(50, 50, 0, 0, 0);
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(50);
  });
});

describe("ringEdgePath", () => {
  const parseControl = (d: string): { x: number; y: number } => {
    const m = d.match(/Q\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    return { x: Number(m![1]), y: Number(m![2]) };
  };

  it("放射エッジ(入口)はほぼ直線(制御点が端点線の近く)", () => {
    const d = ringEdgePath({
      from: { x: 0, y: 0 },
      to: { x: 0, y: 100 },
      mapCenter: { x: 0, y: 0 },
      R: 100,
      halfW: 20,
      halfH: 10,
      isEntryFrom: true,
      isEntryTo: false,
      index: 0,
      count: 1,
    });
    expect(Math.abs(parseControl(d).x)).toBeLessThan(10);
  });

  it("対極のリング間エッジ(直線が中心を跨ぐ)は外へ膨らんで入口ピルを避ける", () => {
    const d = ringEdgePath({
      from: { x: -100, y: 0 },
      to: { x: 100, y: 0 },
      mapCenter: { x: 0, y: 0 },
      R: 100,
      halfW: 20,
      halfH: 10,
      isEntryFrom: false,
      isEntryTo: false,
      index: 0,
      count: 1,
    });
    const c = parseControl(d);
    // 直線なら y=0 のはずだが、中心を跨ぐので y 方向に膨らむ。
    expect(Math.abs(c.y)).toBeGreaterThan(30);
  });

  it("中心を跨がないリング間エッジは直線(制御点が中点=端点と同じ y)", () => {
    const d = ringEdgePath({
      from: { x: 0, y: -100 },
      to: { x: 60, y: -100 },
      mapCenter: { x: 0, y: 0 },
      R: 100,
      halfW: 20,
      halfH: 10,
      isEntryFrom: false,
      isEntryTo: false,
      index: 0,
      count: 1,
    });
    const c = parseControl(d);
    expect(c.y).toBeCloseTo(-100, 0);
  });

  it("有効な quadratic path を返す", () => {
    const d = ringEdgePath({
      from: { x: 10, y: 10 },
      to: { x: 200, y: 50 },
      mapCenter: { x: 100, y: 100 },
      R: 100,
      halfW: 20,
      halfH: 10,
      isEntryFrom: false,
      isEntryTo: false,
      index: 0,
      count: 1,
    });
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain(" Q ");
  });
});
