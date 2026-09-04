/**
 * 読み取り専用の「箱と矢印」フロー表示。制作モードの構造マップ(=生成物を実コードから
 * 解析した ScreenMapResult)を、意図キャンバス(ScreenFlowEditor)と同じ見た目で描く。
 *
 * 狙い(A 案):作るキャンバスと見るマップの視覚言語を「箱と矢印」に統一する。
 * ここは閲覧専用なので編集ボタン(つなぐ/指示/削除)は持たない ―― 違いは「編集 vs 閲覧」だけ。
 * 見るの持ち味(各画面のできること)はノード内のサブ行(userIntent)で残す。
 */
import { useMemo, type CSSProperties } from "react";
import type { ScreenMapResult } from "../../lib/claudeCli";
import { pickLocalized, type Language } from "../../lib/i18n";

const NODE_W = 140;
const NODE_H = 74;
const EDGE_GAP = 4;
const GAP_X = 72;
const GAP_Y = 28;

/** 箱の縁から方向 (dx,dy) に gap だけ外へ出た点(ScreenFlowEditor と同じ式)。 */
function borderPoint(
  cx: number,
  cy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
  gap: number,
): [number, number] {
  const hw = w / 2;
  const hh = h / 2;
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(sx, sy);
  const len = Math.hypot(dx, dy) || 1;
  const ext = t + gap / len;
  return [cx + dx * ext, cy + dy * ext];
}

type FNode = { id: number; name: string; intent: string; x: number; y: number };
type FLink = { from: number; to: number };

/** ScreenMapResult(mind-map 座標)を、フロー用に層状レイアウトして箱の x/y を割り当てる。
 *  入口 = isEntryPoint 優先 → in-degree 0 → 先頭。深さは入口からの BFS 最短。 */
function layoutFlow(map: ScreenMapResult, language: Language): { nodes: FNode[]; edges: FLink[] } {
  const ids = map.nodes.map((n) => n.id);
  const edges: FLink[] = map.edges.map((e) => ({ from: e.from, to: e.to }));
  const adj = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  ids.forEach((id) => {
    adj.set(id, []);
    indeg.set(id, 0);
  });
  edges.forEach((e) => {
    if (adj.has(e.from) && indeg.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    }
  });
  const entryFlag = map.nodes.filter((n) => n.isEntryPoint).map((n) => n.id);
  let roots = entryFlag.length ? entryFlag : ids.filter((id) => (indeg.get(id) || 0) === 0);
  if (roots.length === 0 && ids.length) roots = [ids[0]];
  const depth = new Map<number, number>();
  const queue: number[] = [];
  roots.forEach((r) => {
    depth.set(r, 0);
    queue.push(r);
  });
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const nx of adj.get(cur) || []) {
      if (!depth.has(nx)) {
        depth.set(nx, d + 1);
        queue.push(nx);
      }
    }
  }
  ids.forEach((id) => {
    if (!depth.has(id)) depth.set(id, 0);
  });
  const rowOf = new Map<number, number>();
  const nodes: FNode[] = map.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = rowOf.get(d) || 0;
    rowOf.set(d, row + 1);
    return {
      id: n.id,
      name: pickLocalized(n.label, language) || "(無名の画面)",
      intent: n.userIntent ? pickLocalized(n.userIntent, language) : "",
      x: 20 + d * (NODE_W + GAP_X),
      y: 20 + row * (NODE_H + GAP_Y),
    };
  });
  return { nodes, edges };
}

const boxStyle = (selected: boolean): CSSProperties => ({
  position: "absolute",
  width: NODE_W,
  minHeight: 52,
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 10,
  background: "#fff",
  border: selected ? "2px solid #0d9488" : "1px solid #cbd5e1",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  cursor: "pointer",
  userSelect: "none",
});

export function FlowView({
  screens,
  language,
  selectedId,
  onSelect,
}: {
  screens: ScreenMapResult;
  language: Language;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { nodes, edges } = useMemo(() => layoutFlow(screens, language), [screens, language]);
  const width = Math.max(200, ...nodes.map((n) => n.x + NODE_W + 20));
  const height = Math.max(160, ...nodes.map((n) => n.y + NODE_H + 20));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", background: "#fff" }}>
      <div style={{ position: "relative", width, height }}>
        <svg style={{ position: "absolute", inset: 0, width, height, pointerEvents: "none" }}>
          <defs>
            <marker
              id="fv-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="#64748b" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const acx = a.x + NODE_W / 2;
            const acy = a.y + NODE_H / 2;
            const bcx = b.x + NODE_W / 2;
            const bcy = b.y + NODE_H / 2;
            const dx = bcx - acx;
            const dy = bcy - acy;
            if (dx === 0 && dy === 0) return null;
            const [x1, y1] = borderPoint(acx, acy, NODE_W, NODE_H, dx, dy, EDGE_GAP);
            const [x2, y2] = borderPoint(bcx, bcy, NODE_W, NODE_H, -dx, -dy, EDGE_GAP);
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#64748b"
                strokeWidth={2}
                markerEnd="url(#fv-arrow)"
              />
            );
          })}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.id}
            onClick={() => onSelect(n.id)}
            style={{ ...boxStyle(selectedId === n.id), left: n.x, top: n.y }}
          >
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "#111827", wordBreak: "break-word" }}
            >
              {n.name}
            </div>
            {n.intent ? (
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3, wordBreak: "break-word" }}>
                {n.intent}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
