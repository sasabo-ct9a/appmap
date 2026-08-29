import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * 画面フロー・エディタ(制作モード中央)。
 *
 * 目的:言葉でアプリを説明できない人が、「画面」を箱で並べて矢印でつなぎ、
 * "こういうアプリ" を視覚で示す入力方法。これが Claude への"言葉の代わり"の指示になる。
 *
 * n8n の手触り(視覚・追加/削除・つなぐ)は真似るが、ノードは「画面」であって
 * コードの論理ではない(= "n8n 化の罠" を踏まない)。実際のコードは Claude が書く。
 *
 * 依存を増やさない方針で SVG(エッジ)+ 絶対配置の div(ノード)で自作。
 */

export type Screen = { id: string; name: string; x: number; y: number };
export type FlowEdge = { from: string; to: string };
/** 保存・復元する画面フローの中身。 */
export type FlowData = { screens: Screen[]; edges: FlowEdge[] };

/** 画面フローを Claude へ渡す指示文にする。空(画面なし)なら空文字。 */
export function flowToText(flow: FlowData): string {
  if (!flow.screens.length) return "";
  const nameOf = (id: string) =>
    flow.screens.find((s) => s.id === id)?.name ?? "";
  const names = flow.screens.map((s) => s.name.trim() || "(無名の画面)");
  const flows = flow.edges
    .map((e) => `${nameOf(e.from)} → ${nameOf(e.to)}`)
    .filter((t) => t.trim() !== "→");
  const parts = [
    "画面フロー(ユーザーが図で示したアプリの構成):",
    `- 画面:${names.join(" / ")}`,
  ];
  if (flows.length) parts.push(`- 画面の流れ:${flows.join("、")}`);
  parts.push("これらの画面と遷移を持つアプリにしてください。");
  return parts.join("\n");
}

const NODE_W = 140;
// 実際に描画されるノードの概算高さ(名前 + 操作ボタン込み)。矢印のクリップに使う。
const NODE_H = 74;
const EDGE_GAP = 4; // 矢じりを箱の外に少し出す余白

/** 中心 (cx,cy)・幅 w・高さ h の箱の縁から、方向 (dx,dy) に gap だけ外へ出た点。 */
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

export function ScreenFlowEditor({
  initial,
  onTargetChange,
  onChange,
}: {
  /** 開いたプロジェクトの保存済みフロー(あれば)。mount 時に読み込む。 */
  initial?: FlowData;
  /** 「指示」で選んだ画面名。右ペインの追加指示をこの画面にスコープするため親へ通知。 */
  onTargetChange?: (screenName: string | null) => void;
  /** フロー(画面・矢印)が変わるたびに親へ通知(保存・生成用)。 */
  onChange?: (flow: FlowData) => void;
}) {
  const [screens, setScreens] = useState<Screen[]>(initial?.screens ?? []);
  const [edges, setEdges] = useState<FlowEdge[]>(initial?.edges ?? []);
  // つなぐ操作:1 個目をクリック → connectFrom にセット → 2 個目クリックで矢印を作る。
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 「指示」で選んだ画面(右ペインの追加指示のスコープ対象)。
  const [targetId, setTargetId] = useState<string | null>(null);
  // 復元したフローの id と衝突しないよう、既存 id の最大 + 1 から採番する。
  const nextId = useRef(
    (initial?.screens ?? []).reduce(
      (m, s) => Math.max(m, parseInt(s.id.slice(1), 10) || 0),
      0,
    ) + 1,
  );
  const areaRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const nameOf = (id: string) => screens.find((s) => s.id === id)?.name ?? "";

  const setTarget = (id: string | null) => {
    setTargetId(id);
    onTargetChange?.(id ? nameOf(id) : null);
  };

  const addScreen = () => {
    const n = screens.length;
    const id = "s" + nextId.current++;
    const x = 40 + (n % 4) * (NODE_W + 40);
    const y = 40 + Math.floor(n / 4) * (NODE_H + 40);
    setScreens((prev) => [...prev, { id, name: `画面${n + 1}`, x, y }]);
    setEditingId(id);
  };

  const removeScreen = (id: string) => {
    setScreens((prev) => prev.filter((s) => s.id !== id));
    setEdges((prev) => prev.filter((e) => e.from !== id && e.to !== id));
    if (connectFrom === id) setConnectFrom(null);
    if (editingId === id) setEditingId(null);
    if (targetId === id) setTarget(null);
  };

  const rename = (id: string, name: string) => {
    setScreens((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
    if (id === targetId) onTargetChange?.(name);
  };

  // ノード本体クリック:つなぐ途中なら矢印を作る、そうでなければ何もしない(ドラッグは別扱い)。
  const onNodeClick = (id: string) => {
    if (connectFrom === null) return;
    if (connectFrom !== id) {
      setEdges((prev) =>
        prev.some((e) => e.from === connectFrom && e.to === id)
          ? prev
          : [...prev, { from: connectFrom, to: id }],
      );
    }
    setConnectFrom(null);
  };

  // ドラッグでノードを移動。ポインタは window で追う(枠の外に出てもズレない)。
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const area = areaRef.current;
      if (!d || !area) return;
      const rect = area.getBoundingClientRect();
      const x = e.clientX - rect.left - d.dx;
      const y = e.clientY - rect.top - d.dy;
      setScreens((prev) =>
        prev.map((s) =>
          s.id === d.id ? { ...s, x: Math.max(0, x), y: Math.max(0, y) } : s,
        ),
      );
    };
    const up = () => {
      drag.current = null;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectFrom(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // フロー(画面・矢印)が変わったら親へ通知(保存用)。onChange は親側で ref に貯める想定なので
  // deps には入れない(毎 render 発火を避ける)。
  useEffect(() => {
    onChange?.({ screens, edges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens, edges]);

  const startDrag = (e: React.PointerEvent, s: Screen) => {
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    drag.current = {
      id: s.id,
      dx: e.clientX - rect.left - s.x,
      dy: e.clientY - rect.top - s.y,
    };
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ツールバー */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <button onClick={addScreen} style={toolBtn}>
          ＋ 画面を追加
        </button>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {connectFrom
            ? `「${nameOf(connectFrom)}」のつなぐ先をクリック(Esc で中止)`
            : "ドラッグで移動 / 「つなぐ」で矢印 / 「指示」で直したい画面を選ぶ"}
        </span>
      </div>

      {/* キャンバス */}
      <div
        ref={areaRef}
        onClick={() => connectFrom && setConnectFrom(null)}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          background:
            "radial-gradient(circle, #e5e7eb 1px, transparent 1px) 0 0 / 16px 16px",
        }}
      >
        {screens.length === 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#9ca3af",
              fontSize: 13,
              textAlign: "center",
              lineHeight: 1.8,
            }}
          >
            「＋ 画面を追加」で画面を置き、矢印でつないで
            <br />
            アプリの流れを描いてください。
          </div>
        ) : null}

        {/* エッジ(矢印)は SVG レイヤーで背面に描く */}
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        >
          <defs>
            <marker
              id="flow-arrow"
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
            const a = screens.find((s) => s.id === e.from);
            const b = screens.find((s) => s.id === e.to);
            if (!a || !b) return null;
            const acx = a.x + NODE_W / 2;
            const acy = a.y + NODE_H / 2;
            const bcx = b.x + NODE_W / 2;
            const bcy = b.y + NODE_H / 2;
            const dx = bcx - acx;
            const dy = bcy - acy;
            if (dx === 0 && dy === 0) return null;
            // 線を両ノードの縁で止める → 矢じりが箱に隠れず見える。
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
                markerEnd="url(#flow-arrow)"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={() =>
                  setEdges((prev) =>
                    prev.filter((x) => !(x.from === e.from && x.to === e.to)),
                  )
                }
              >
                <title>クリックでこの矢印を削除</title>
              </line>
            );
          })}
        </svg>

        {/* ノード(画面) */}
        {screens.map((s) => {
          const connecting = connectFrom === s.id;
          const isTarget = targetId === s.id;
          return (
            <div
              key={s.id}
              onPointerDown={(e) => {
                if (editingId === s.id) return;
                const t = e.target as HTMLElement;
                if (t.dataset.nodrag) return;
                startDrag(e, s);
              }}
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick(s.id);
              }}
              style={{
                position: "absolute",
                left: s.x,
                top: s.y,
                width: NODE_W,
                minHeight: 52,
                boxSizing: "border-box",
                padding: "8px 10px",
                borderRadius: 10,
                background: isTarget ? "#f0fdfa" : "#fff",
                border: connecting
                  ? "2px solid #14b8a6"
                  : isTarget
                    ? "2px solid #0d9488"
                    : "1px solid #cbd5e1",
                boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                cursor: "grab",
                userSelect: "none",
              }}
            >
              {editingId === s.id ? (
                <input
                  autoFocus
                  value={s.name}
                  onChange={(e) => rename(s.id, e.target.value)}
                  onBlur={() => setEditingId(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEditingId(null);
                  }}
                  data-nodrag="1"
                  style={{
                    width: "100%",
                    fontSize: 13,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    padding: "2px 4px",
                  }}
                />
              ) : (
                <div
                  onDoubleClick={() => setEditingId(s.id)}
                  style={{ fontSize: 13, fontWeight: 600, color: "#111827", wordBreak: "break-word" }}
                  title="ダブルクリックで名前を編集"
                >
                  {s.name || "(無名の画面)"}
                </div>
              )}
              {/* ノード下部のミニ操作 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                <button
                  data-nodrag="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConnectFrom(s.id);
                  }}
                  style={miniBtn}
                >
                  つなぐ
                </button>
                <button
                  data-nodrag="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTarget(isTarget ? null : s.id);
                  }}
                  style={
                    isTarget
                      ? { ...miniBtn, background: "#14b8a6", color: "#fff", borderColor: "#14b8a6" }
                      : miniBtn
                  }
                  title="この画面を、右の『AI に頼む』の対象にする"
                >
                  指示
                </button>
                <button
                  data-nodrag="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeScreen(s.id);
                  }}
                  style={{ ...miniBtn, color: "#dc2626" }}
                >
                  削除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const toolBtn: CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  border: "1px solid #d1d5db",
  borderRadius: 8,
  background: "#fff",
  color: "#374151",
  cursor: "pointer",
};

const miniBtn: CSSProperties = {
  fontSize: 10,
  padding: "2px 6px",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  background: "#f9fafb",
  color: "#6b7280",
  cursor: "pointer",
};

export default ScreenFlowEditor;
