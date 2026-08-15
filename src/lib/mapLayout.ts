/**
 * マップ(マインドマップ)のレイアウト + エッジ描画の純粋ロジック。
 *
 * MapCanvas(本体)/ SpecDocMap(PDF 出力)/ ImpactMap(インパクト表示)の 3 つが
 * 同じ配置・エッジ計算を持っており、以前は各コンポーネントに verbatim で重複していた。
 * その重複が「つながり(エッジ)が重なる」バグの温床だったため、ここに一元化する。
 *
 * 重なりの根本原因は「並び順の最適化」と「実際の描画」の不一致だった:
 *   - 並び順はリング上の直線弦の交差を最小化していた。
 *   - しかしエッジは中心同士を結び、中心から外へ固定量だけ膨らませて描いていた
 *     (エッジごとの分離ゼロ)。
 * ここでは (1) つながったノードを隣に並べる木構造 DFS + 2-opt、(2) 端点をピル境界へ寄せ、
 * リング間エッジは角度差に比例して外側へ膨らませ(中心を回り込む)、平行エッジは扇状に
 * 分離する描画、を提供して両者を一致させる。
 *
 * すべて純粋・決定的(Math.random 不使用)で、React にも i18n にも依存しない
 * (ラベルは呼び出し側が labelOf で渡す)。これにより DOM 無し・LLM 枠無しで
 * vitest から検証できる。
 */
import type { ScreenEdge } from "../types/screen";

// ---------------------------------------------------------------------------
// 並び順(リング上のスロット順)
// ---------------------------------------------------------------------------

/**
 * リング上の並び(スロット順)で、直線弦の交差数を数える。
 * 入口ノードは中心に置かれ orderedIds に含まれないため、その放射エッジは自動的に除外される
 * (pos が undefined になり skip される)。テストからも使うので export。
 */
export function countRingCrossings(
  orderedIds: number[],
  edges: ScreenEdge[],
): number {
  const pos = new Map<number, number>();
  orderedIds.forEach((id, i) => pos.set(id, i));
  const chords: Array<[number, number]> = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    chords.push([Math.min(a, b), Math.max(a, b)]);
  }
  let c = 0;
  for (let i = 0; i < chords.length; i++) {
    for (let j = i + 1; j < chords.length; j++) {
      const [a, b] = chords[i];
      const [x, y] = chords[j];
      // 円環上で 2 弦が交差 ⇔ 端点が交互に並ぶ
      if ((a < x && x < b && b < y) || (x < a && a < y && y < b)) c++;
    }
  }
  return c;
}

/** リング間エッジの「総弧長」(スロットの円環距離の和)。2-opt の第2指標。 */
function totalArc(orderedIds: number[], edges: ScreenEdge[]): number {
  const M = orderedIds.length;
  if (M === 0) return 0;
  const pos = new Map<number, number>();
  orderedIds.forEach((id, i) => pos.set(id, i));
  let sum = 0;
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (a === undefined || b === undefined) continue;
    const diff = Math.abs(a - b);
    sum += Math.min(diff, M - diff);
  }
  return sum;
}

/**
 * リング(周囲)ノードを、つながりが隣接するように決定的に並べ替える。
 *
 * 手順:
 *   1. リングノード間の無向隣接を作る(入口=中心への放射エッジは除く)。
 *   2. 木構造 DFS 前順で初期順を作る(部分木が連続した弧を占める→親子エッジが隣接)。
 *   3. 2-opt で仕上げる。主指標=交差数、同点は総弧長(つながりを角度的に近づける)。
 *      厳密改善のみ採用・≤20 パスなので決定的。
 */
export function orderRingNodes<T extends { id: number }>(
  others: T[],
  edges: ScreenEdge[],
  opts: { labelOf: (n: T) => string },
): T[] {
  const M = others.length;
  if (M <= 1) return [...others];

  const byId = new Map<number, T>();
  others.forEach((n) => byId.set(n.id, n));
  const otherIds = new Set(others.map((n) => n.id));

  const adjacency = new Map<number, Set<number>>();
  for (const e of edges) {
    if (!otherIds.has(e.from) || !otherIds.has(e.to) || e.from === e.to) continue;
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
    adjacency.get(e.from)!.add(e.to);
    adjacency.get(e.to)!.add(e.from);
  }
  const degree = (id: number) => adjacency.get(id)?.size ?? 0;

  // 決定的な基準順:次数降順 → label 昇順。DFS の根/子選択とフォールバックに使う。
  const rank = (a: T, b: T) => {
    const dd = degree(b.id) - degree(a.id);
    if (dd !== 0) return dd;
    return opts.labelOf(a).localeCompare(opts.labelOf(b), "ja");
  };
  const sortedAll = [...others].sort(rank);

  // 木構造 DFS 前順:つながった部分木を連続配置し、親子エッジを隣接させる。
  const visited = new Set<number>();
  const order: T[] = [];
  const stack: T[] = [];
  for (const root of sortedAll) {
    if (visited.has(root.id)) continue;
    stack.push(root);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      order.push(node);
      // 子を rank 順で「逆順に」積むと、pop で rank 昇順(=前順)に展開される。
      const children = [...(adjacency.get(node.id) ?? [])]
        .map((id) => byId.get(id))
        .filter((n): n is T => !!n && !visited.has(n.id))
        .sort(rank);
      for (let k = children.length - 1; k >= 0; k--) stack.push(children[k]);
    }
  }

  // 2-opt 仕上げ(交差数優先、同点は総弧長)。
  const optimized = order.map((n) => n.id);
  const costOf = (ids: number[]) =>
    countRingCrossings(ids, edges) * 100000 + totalArc(ids, edges);
  let best = costOf(optimized);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 20) {
    improved = false;
    for (let i = 0; i < optimized.length - 1; i++) {
      for (let j = i + 1; j < optimized.length; j++) {
        [optimized[i], optimized[j]] = [optimized[j], optimized[i]];
        const c = costOf(optimized);
        if (c < best) {
          best = c;
          improved = true;
        } else {
          [optimized[i], optimized[j]] = [optimized[j], optimized[i]];
        }
      }
    }
  }
  return optimized.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// リング配置(幾何)
// ---------------------------------------------------------------------------

/** スロット index の角度(UL=-135° から時計回りに等間隔)。既存レイアウトと同一。 */
export function ringAngleRad(slotIndex: number, M: number): number {
  const deg = M > 0 ? -135 + (360 / M) * slotIndex : 0;
  return (deg * Math.PI) / 180;
}

/** 中心 (cx,cy)・半径 R のリング上、スロット index の base 位置(offset 無し)。 */
export function ringBasePosition(
  cx: number,
  cy: number,
  R: number,
  slotIndex: number,
  M: number,
): { x: number; y: number; angle: number } {
  const angle = ringAngleRad(slotIndex, M);
  return { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), angle };
}

// ---------------------------------------------------------------------------
// エッジ描画
// ---------------------------------------------------------------------------

/**
 * ピル中心 (cx,cy) から (tx,ty) 方向に出た光線が、幅 2*halfW・高さ 2*halfH の矩形境界と
 * 交わる点。角丸は矩形近似(見た目は十分)。inset で少し内側に寄せて線がピルに食い込むのを防ぐ。
 * 死コード Edge.tsx の distributedAnchorX / 境界交点の考え方を一般化して移植。
 */
export function pillBoundaryPoint(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tx: number,
  ty: number,
  inset = 2,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = Math.max(1, halfW - inset);
  const hh = Math.max(1, halfH - inset);
  const tX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const tY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tX, tY);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * 同じ「回廊」を通るエッジ(平行・双方向・重複)を扇状に分離するための index/count を作る。
 * リング間キー = 両端スロットをソートした対 / 放射(入口)キー = 入口 id + 相手スロット。
 * slotOf は入口ノードに対しては undefined を返す前提(入口はリング順に含まれない)。
 */
export function buildEdgeSeparation(
  edges: ScreenEdge[],
  slotOf: (id: number) => number | undefined,
): Map<string, { index: number; count: number }> {
  const keyOf = (e: ScreenEdge): string => {
    const a = slotOf(e.from);
    const b = slotOf(e.to);
    const ka = a === undefined ? `e${e.from}` : `s${a}`;
    const kb = b === undefined ? `e${e.to}` : `s${b}`;
    return [ka, kb].sort().join("_");
  };
  const groups = new Map<string, string[]>();
  for (const e of edges) {
    const key = keyOf(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e.id);
  }
  const result = new Map<string, { index: number; count: number }>();
  for (const ids of groups.values()) {
    const sorted = [...ids].sort(); // id 昇順で決定的
    sorted.forEach((id, i) => result.set(id, { index: i, count: sorted.length }));
  }
  return result;
}

/**
 * 1 本のエッジの SVG path(`d`)を組み立てる。ユーザー要望で「つながりは直線」を基本にする:
 *   - 端点はピル境界に寄せる(中心同士だと線がピルの下を走る)。
 *   - 基本は直線(二次ベジェの制御点を中点に置くと直線になる)。
 *   - 例外:リング間エッジで、直線が中心の入口ピルを突っ切る場合だけ、外へ少し膨らませて避ける。
 *   - 同回廊の平行/重複エッジだけ、垂直方向に少しずらす(単独エッジは完全な直線)。
 * from/to は offset 解決済みの端点中心。判定は中心基準なので、ドラッグしても線は端点に追従する。
 * R は API 互換のため受け取るが、直線基本では使わない。
 */
export function ringEdgePath(params: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  mapCenter: { x: number; y: number };
  R: number;
  halfW: number;
  halfH: number;
  isEntryFrom: boolean;
  isEntryTo: boolean;
  index: number;
  count: number;
  reversed?: boolean;
}): string {
  const {
    from,
    to,
    mapCenter,
    halfW,
    halfH,
    isEntryFrom,
    isEntryTo,
    index,
    count,
    reversed,
  } = params;
  void params.R;
  const cx = mapCenter.x;
  const cy = mapCenter.y;

  const a = pillBoundaryPoint(from.x, from.y, halfW, halfH, to.x, to.y);
  const b = pillBoundaryPoint(to.x, to.y, halfW, halfH, from.x, from.y);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abLen = Math.hypot(abx, aby) || 1;

  // 基本は直線(制御点=中点)。
  let ctrlX = mx;
  let ctrlY = my;

  // リング間エッジ(放射でない)で、直線 a-b が中心の入口ピルを突っ切る時だけ、外へ避ける。
  if (!isEntryFrom && !isEntryTo) {
    const t = ((cx - a.x) * abx + (cy - a.y) * aby) / (abLen * abLen);
    const tc = Math.max(0, Math.min(1, t));
    const closeX = a.x + tc * abx;
    const closeY = a.y + tc * aby;
    const distToCenter = Math.hypot(closeX - cx, closeY - cy);
    const clearance = halfH + 26; // 入口ピルにかかる距離
    if (distToCenter < clearance) {
      // 外向きに膨らませて中心を回り込む(必要最小限)。中点が中心付近なら垂線を外向きに使う。
      let outx = mx - cx;
      let outy = my - cy;
      const olen = Math.hypot(outx, outy);
      if (olen < 1e-3) {
        outx = -aby;
        outy = abx;
      }
      const on = Math.hypot(outx, outy) || 1;
      outx /= on;
      outy /= on;
      const bulge = clearance - distToCenter + 40;
      ctrlX = mx + outx * bulge;
      ctrlY = my + outy * bulge;
    }
  }

  // 同回廊の平行/重複エッジだけ、垂直方向に少しずらして完全な重なりを防ぐ(単独は直線のまま)。
  if (count > 1) {
    const perpx = -aby / abLen;
    const perpy = abx / abLen;
    const sep = Math.min(20, 44 / count);
    const off = (index - (count - 1) / 2) * sep;
    ctrlX += perpx * off;
    ctrlY += perpy * off;
  }

  return reversed
    ? `M ${b.x} ${b.y} Q ${ctrlX} ${ctrlY} ${a.x} ${a.y}`
    : `M ${a.x} ${a.y} Q ${ctrlX} ${ctrlY} ${b.x} ${b.y}`;
}
