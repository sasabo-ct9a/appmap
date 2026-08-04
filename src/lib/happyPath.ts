import type { ScreenMapResult } from "./claudeCli";

/** 流れの再生プラン。stages = 入口からたどれる本流(距離ごと)、detached = 入口から
 *  たどり着けない要素(本流の外)。detached を捨てず別枠で持つことで「流れに入らない
 *  要素も補足する」正直さを保つ。 */
export type ReplayPlan = {
  /** 入口から同じ距離の要素をまとめたステージ列。近い順。 */
  stages: number[][];
  /** 入口から前向きにたどり着けない要素の id(準備系・独立フローなど)。id 昇順。 */
  detached: number[];
};

/**
 * 流れの再生(ステージ分割)。
 *
 * 入口(最初に見る要素)からの「距離(入口から何ステップ先か)」で要素をまとめ、
 * 近い順にステージの配列を返す。1 ステージ = 入口から同じ距離にある要素の集合。
 *
 * なぜ一本道ではなくステージか:
 *   実際のアプリは「データ取得 → 動画取得(Pexels)と(Pixabay)に分かれる」のように
 *   途中で枝分かれする。一本道を貪欲にたどると片方の枝を黙って捨ててしまい、
 *   構造を偽って伝える(= AppMap が最も避けるべき「分かった気にさせるが実物と違う」)。
 *   同じ距離の要素を 1 ステージにまとめれば、分岐はそのステージで複数要素が同時に
 *   光るので、枝分かれを正直に見せられる(CLAUDE.md §3.2 段階的開示 + as-built の正直さ)。
 *
 * 設計:
 *   - 入口は isEntryPoint → 無ければ入次数 0(どこからも遷移されない要素)→ depth/id 最小。
 *   - 距離は入口からの最短ホップ数(BFS)。双方向エッジは両向きに通れる。
 *   - 入口からたどり着けない要素は本流(stages)に混ぜず detached に分ける(順序を捏造しない)。
 *     呼び出し側が「流れに入らない要素」として別途補足できるようにする。
 *   - グラフは小さい(≤ 15)ので厳密さより予測可能性を優先。各ステージ内は id 昇順で決定的。
 */
export function computeReplaySteps(screens: ScreenMapResult): ReplayPlan {
  const nodes = screens.nodes;
  if (nodes.length === 0) return { stages: [], detached: [] };

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 入次数(どれだけ他から遷移されてくるか)。入口候補の判定に使う。
  const incoming = new Map<number, number>();
  for (const e of screens.edges) {
    if (!byId.has(e.to)) continue;
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }

  // 出発点を決める:明示 entry → 入次数 0 → depth/id 最小。
  const start =
    nodes.find((n) => n.isEntryPoint) ??
    [...nodes]
      .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.id - b.id)
      .find((n) => (incoming.get(n.id) ?? 0) === 0) ??
    nodes[0];

  // 隣接リスト:片方向は前向きのみ、双方向は両向きに通れる。
  const adj = new Map<number, number[]>();
  const link = (from: number, to: number) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  };
  for (const e of screens.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    link(e.from, e.to);
    if (e.bidirectional) link(e.to, e.from);
  }
  for (const list of adj.values()) list.sort((a, b) => a - b);

  // 入口からの最短ホップ数を BFS で求める。
  const dist = new Map<number, number>();
  dist.set(start.id, 0);
  const queue: number[] = [start.id];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const d = dist.get(cur)!;
    for (const to of adj.get(cur) ?? []) {
      if (!dist.has(to)) {
        dist.set(to, d + 1);
        queue.push(to);
      }
    }
  }

  // 距離ごとにまとめてステージ配列に。各ステージ内は id 昇順で決定的。
  const maxD = Math.max(...dist.values());
  const stages: number[][] = [];
  for (let d = 0; d <= maxD; d++) {
    const ids: number[] = [];
    for (const [id, dd] of dist) if (dd === d) ids.push(id);
    if (ids.length) stages.push(ids.sort((a, b) => a - b));
  }

  // 入口からたどり着けなかった要素 = 本流の外(準備系・独立フローなど)。
  const detached = nodes
    .filter((n) => !dist.has(n.id))
    .map((n) => n.id)
    .sort((a, b) => a - b);

  return { stages, detached };
}
