import { useEffect, useMemo, useRef, useState } from "react";
import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";
import {
  orderRingNodes,
  ringBasePosition,
  buildEdgeSeparation,
  ringEdgePath,
} from "../../lib/mapLayout";

/**
 * v0.1.7:「変更の影響を確認」ページのマップ表現。
 *
 * 現状の text-based セクション B を差し替え。ホームのマインドマップと同じ構図
 * (エントリ中心 + 放射状)を保ちつつ、選択要素と繋がる要素だけ色付きで浮かせる。
 *
 * 描画方針:
 *   - 選択要素:大きく強調(color glow)
 *   - 直接つながる要素:safety の色(easy/neutral/risky)で塗る
 *   - 無関係な要素:半透明にフェード
 *   - エッジ:選択に絡む線だけ濃く太く、それ以外は薄い gray
 */

type ImpactMapProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  focusedId: number | null;
  language: Language;
  onSelectNode: (id: number) => void;
};

const BRANCH_W = 168;
const BRANCH_H = 62;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const SAFETY_COLORS = {
  easy: { fill: "var(--color-impact-low)", bg: "#CCFBF1", border: "#5EEAD4", text: "#0D9488" },
  neutral: { fill: "var(--color-impact-mid)", bg: "#FEF3C7", border: "#FCD34D", text: "#B45309" },
  risky: { fill: "var(--color-impact-high)", bg: "#FCE7F3", border: "#F9A8D4", text: "#BE185D" },
  unknown: { fill: "#94a3b8", bg: "#f1f5f9", border: "#cbd5e1", text: "#64748b" },
} as const;

type Safety = keyof typeof SAFETY_COLORS;

function getSafety(node: ScreenNode): Safety {
  return (node.detail.changeHint?.safety as Safety | undefined) ?? "unknown";
}

function ImpactMap({
  nodes,
  edges,
  focusedId,
  language,
  onSelectNode,
}: ImpactMapProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const wasDraggingRef = useRef(false);
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);

  const layout = useMemo(() => {
    const entry = nodes.find((n) => n.isEntryPoint);
    const othersRawUnsorted = entry
      ? nodes.filter((n) => n.id !== entry.id)
      : nodes;
    // つながったノードが隣接するよう決定的に並べ替える(木構造 DFS + 2-opt は mapLayout に一元化)。
    const labelOf = (n: ScreenNode) => {
      const s = pickLocalized(n.userIntent ?? n.label, language);
      return s || String(n.id);
    };
    const others = orderRingNodes(othersRawUnsorted, edges, { labelOf });
    const M = others.length;
    const R = M > 0 ? Math.max(200, 100 + M * 34) : 0;
    const reach = R + BRANCH_W / 2 + 30;
    const W = Math.max(920, reach * 2 + 60);
    const H = Math.max(500, reach * 2 + 60);
    const cx = W / 2;
    const cy = H / 2;
    const positions = new Map<number, { x: number; y: number }>();
    if (entry) positions.set(entry.id, { x: cx, y: cy });
    others.forEach((node, i) => {
      const base = ringBasePosition(cx, cy, R, i, M);
      positions.set(node.id, { x: base.x, y: base.y });
    });
    // エッジ描画用:スロット index と、同回廊の平行エッジを扇状に分ける index/count。
    const slotIndex = new Map<number, number>();
    others.forEach((n, i) => slotIndex.set(n.id, i));
    const edgeSep = buildEdgeSeparation(edges, (id) => slotIndex.get(id));
    return { W, H, cx, cy, R, entryId: entry?.id ?? null, edgeSep, positions };
  }, [nodes, edges, language]);

  const { W, H, cx, cy, R: mapR, entryId, edgeSep, positions } = layout;

  const vbW = W / zoom;
  const vbH = H / zoom;
  const vbX = (W - vbW) / 2 - pan.x;
  const vbY = (H - vbH) / 2 - pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  useEffect(() => {
    const el = svgWrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0018;
      setZoom((z) => clamp(z * (1 + delta), ZOOM_MIN, ZOOM_MAX));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    wasDraggingRef.current = false;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      wasDraggingRef.current = true;
      const wrap = svgWrapRef.current;
      const rect = wrap?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        const svgPerPx = vbW / rect.width;
        setPan({
          x: dragRef.current.panX + dx * svgPerPx,
          y: dragRef.current.panY + dy * svgPerPx,
        });
      }
    }
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setTimeout(() => {
      wasDraggingRef.current = false;
    }, 0);
  };

  const zoomIn = () => setZoom((z) => clamp(z * 1.2, ZOOM_MIN, ZOOM_MAX));
  const zoomOut = () => setZoom((z) => clamp(z / 1.2, ZOOM_MIN, ZOOM_MAX));
  const zoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleNodeClickSafe = (id: number) => {
    if (wasDraggingRef.current) return;
    onSelectNode(id);
  };

  // 選択に絡む相手 id 集合
  const relatedIds = useMemo(() => {
    if (focusedId === null) return new Set<number>();
    const r = new Set<number>();
    for (const e of edges) {
      if (e.from === focusedId) r.add(e.to);
      else if (e.to === focusedId) r.add(e.from);
    }
    return r;
  }, [focusedId, edges]);

  return (
    <div className="bg-paper rounded-[16px] border border-border-soft p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="text-xs text-ink-soft flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-impact-low" />
            {tx("安全", "safe")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-impact-mid" />
            {tx("注意", "care")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-impact-high" />
            {tx("慎重", "risky")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-ink-soft">
            {focusedId !== null
              ? tx(
                  `この要素を変えると ${relatedIds.size} 個の要素に影響します`,
                  `Change ripples to ${relatedIds.size} pieces`,
                )
              : tx(
                  "要素をクリックすると影響範囲が表示されます",
                  "Click a piece to see impact",
                )}
          </div>
          {/* ズームコントロール */}
          <div className="flex items-center border border-border-soft rounded-[10px] overflow-hidden bg-paper">
            <button
              type="button"
              onClick={zoomOut}
              className="px-2.5 py-1 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
              title={tx("縮小", "Zoom out")}
              aria-label={tx("縮小", "Zoom out")}
            >
              −
            </button>
            <span className="px-2 text-[10px] text-ink-soft font-mono border-x border-border-soft min-w-[38px] text-center select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              className="px-2.5 py-1 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
              title={tx("拡大", "Zoom in")}
              aria-label={tx("拡大", "Zoom in")}
            >
              +
            </button>
            <button
              type="button"
              onClick={zoomReset}
              className="px-2.5 py-1 text-xs text-ink hover:bg-canvas transition-colors cursor-pointer border-l border-border-soft"
              title={tx("リセット", "Reset")}
              aria-label={tx("リセット", "Reset")}
            >
              ⟲
            </button>
          </div>
        </div>
      </div>
      <div
        ref={svgWrapRef}
        className="bg-canvas-soft rounded-[12px] relative overflow-hidden touch-none"
        style={{ height: 520 }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <svg
          viewBox={viewBox}
          className="w-full h-full select-none block"
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
          role="img"
          aria-label={tx("影響範囲マップ", "Impact map")}
        >
          <defs>
            <radialGradient id="impactmap-bg" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="#f0fdfa" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#f8fafc" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width={W} height={H} fill="url(#impactmap-bg)" />

          {/* エッジ:選択に絡むものだけ濃く太く */}
          <g aria-label={tx("つながり", "links")}>
            {edges.map((edge) => {
              const fromPos = positions.get(edge.from);
              const toPos = positions.get(edge.to);
              if (!fromPos || !toPos) return null;
              const isRelevant =
                focusedId !== null &&
                (edge.from === focusedId || edge.to === focusedId);
              const other =
                focusedId === edge.from
                  ? nodes.find((n) => n.id === edge.to)
                  : focusedId === edge.to
                    ? nodes.find((n) => n.id === edge.from)
                    : null;
              const stroke = isRelevant && other
                ? SAFETY_COLORS[getSafety(other)].fill
                : "#94a3b8";
              const sepInfo = edgeSep.get(edge.id) ?? { index: 0, count: 1 };
              const edgeD = ringEdgePath({
                from: fromPos,
                to: toPos,
                mapCenter: { x: cx, y: cy },
                R: mapR,
                halfW: BRANCH_W / 2,
                halfH: BRANCH_H / 2,
                isEntryFrom: entryId !== null && edge.from === entryId,
                isEntryTo: entryId !== null && edge.to === entryId,
                index: sepInfo.index,
                count: sepInfo.count,
              });
              return (
                <path
                  key={edge.id}
                  d={edgeD}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={isRelevant ? 0.85 : 0.14}
                  strokeWidth={isRelevant ? 2.5 : 1.2}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* ノード */}
          <g aria-label={tx("要素一覧", "pieces")}>
            {nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isFocused = node.id === focusedId;
              const isRelated = relatedIds.has(node.id);
              const isHovered = node.id === hoveredId;
              const safety = getSafety(node);
              const colors = SAFETY_COLORS[safety];
              const label = pickLocalized(
                node.userIntent ?? node.label,
                language,
              );
              const opacity = focusedId === null
                ? 1
                : isFocused
                  ? 1
                  : isRelated
                    ? 1
                    : 0.28;
              // 塗り:focused = 派手、related = safety soft、それ以外 = 白
              const fill = isFocused
                ? colors.bg
                : isRelated
                  ? colors.bg
                  : "#ffffff";
              const stroke = isFocused
                ? colors.fill
                : isRelated
                  ? colors.border
                  : "#e2e8f0";
              const textColor = isFocused
                ? colors.text
                : isRelated
                  ? colors.text
                  : "#475569";
              const x = pos.x - BRANCH_W / 2;
              const y = pos.y - BRANCH_H / 2;
              return (
                <g
                  key={node.id}
                  onClick={() => handleNodeClickSafe(node.id)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="cursor-pointer"
                  style={{
                    opacity,
                    filter: isFocused
                      ? `drop-shadow(0 8px 22px ${colors.fill}44)`
                      : isHovered
                        ? `drop-shadow(0 3px 8px rgba(15,23,42,0.14))`
                        : "drop-shadow(0 1px 3px rgba(15,23,42,0.06))",
                    transition: "opacity 0.15s, filter 0.15s",
                  }}
                >
                  <rect
                    x={x}
                    y={y}
                    width={BRANCH_W}
                    height={BRANCH_H}
                    rx={BRANCH_H / 2}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isFocused ? 2.5 : 2}
                  />
                  {/* focused には safety ドットを左端に付ける */}
                  {(isFocused || isRelated) && (
                    <circle
                      cx={x + 14}
                      cy={pos.y}
                      r={5}
                      fill={colors.fill}
                    />
                  )}
                  <text
                    x={pos.x + (isFocused || isRelated ? 8 : 0)}
                    y={pos.y - 4}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={textColor}
                    fontSize="13.5"
                    fontWeight="700"
                  >
                    {truncate(label, 12)}
                  </text>
                  <text
                    x={pos.x + (isFocused || isRelated ? 8 : 0)}
                    y={pos.y + 12}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#64748b"
                    fontSize="10"
                  >
                    {isFocused
                      ? tx("選択中", "focused")
                      : isRelated
                        ? tx(
                            SAFETY_LABEL[safety].ja,
                            SAFETY_LABEL[safety].en,
                          )
                        : ""}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

const SAFETY_LABEL: Record<Safety, { ja: string; en: string }> = {
  easy: { ja: "安全", en: "safe" },
  neutral: { ja: "少し注意", en: "care" },
  risky: { ja: "慎重", en: "risky" },
  unknown: { ja: "未判定", en: "n/a" },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export default ImpactMap;
