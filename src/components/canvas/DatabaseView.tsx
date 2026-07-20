import { useEffect, useMemo, useRef, useState } from "react";
import type { ScreenNode, LocalizedText } from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";
import { SparkleIcon } from "../ui/Icons";

/**
 * v0.1.7:「詳細モード = 技術者向け」で表示するデータベース配置マップ。
 *
 * 左:データ(エンティティ)ボックス、右:それを扱う画面ボックス。
 * 色付き曲線で「この画面はこのデータを読み書きする」を可視化する二部グラフ。
 *
 * データソース:各 ScreenNode.detail.dataUsed[] を集約(= 1 データ = 1 エンティティ)。
 */

type DatabaseViewProps = {
  nodes: ScreenNode[];
  language: Language;
  onSelectNode: (id: number) => void;
};

type Entity = {
  key: string;
  name: LocalizedText;
  screens: ScreenNode[];
};

const PALETTE = [
  { fill: "#14B8A6", soft: "#CCFBF1", border: "#5EEAD4", text: "#0D9488" },
  { fill: "#F59E0B", soft: "#FEF3C7", border: "#FCD34D", text: "#B45309" },
  { fill: "#8B5CF6", soft: "#EDE9FE", border: "#C4B5FD", text: "#6D28D9" },
  { fill: "#3B82F6", soft: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8" },
  { fill: "#EC4899", soft: "#FCE7F3", border: "#F9A8D4", text: "#BE185D" },
  { fill: "#10B981", soft: "#D1FAE5", border: "#6EE7B7", text: "#047857" },
  { fill: "#06B6D4", soft: "#CFFAFE", border: "#67E8F9", text: "#0E7490" },
  { fill: "#F97316", soft: "#FFEDD5", border: "#FDBA74", text: "#C2410C" },
];

const ENTITY_W = 200;
const ENTITY_H = 56;
const SCREEN_W = 176;
const SCREEN_H = 44;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

function aggregate(nodes: ScreenNode[], language: Language): Entity[] {
  const map = new Map<string, Entity>();
  for (const n of nodes) {
    if (!n.detail.dataUsed) continue;
    for (const d of n.detail.dataUsed) {
      const key = pickLocalized(d, language).trim();
      if (!key) continue;
      const e = map.get(key);
      if (e) e.screens.push(n);
      else map.set(key, { key, name: d, screens: [n] });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.screens.length - a.screens.length,
  );
}

function DatabaseView({ nodes, language, onSelectNode }: DatabaseViewProps) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);
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
  const [hoveredEntityKey, setHoveredEntityKey] = useState<string | null>(null);
  const [hoveredScreenId, setHoveredScreenId] = useState<number | null>(null);

  const entities = useMemo(
    () => aggregate(nodes, language),
    [nodes, language],
  );

  const layout = useMemo(() => {
    const E = entities.length;
    // 画面は使われているものだけ + Y はエンティティ側との重心で決める
    const usedScreens = Array.from(
      new Set(entities.flatMap((e) => e.screens.map((s) => s.id))),
    )
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is ScreenNode => n !== undefined);

    // 縦間隔:エンティティは大きめ、画面は少し密に
    const ENTITY_GAP = 90;
    const SCREEN_GAP = 60;
    const paddingY = 60;
    const contentH_entity =
      Math.max(0, E - 1) * ENTITY_GAP + paddingY * 2 + ENTITY_H;
    const contentH_screen =
      Math.max(0, usedScreens.length - 1) * SCREEN_GAP +
      paddingY * 2 +
      SCREEN_H;
    const H = Math.max(contentH_entity, contentH_screen, 520);
    const W = 1000;

    // エンティティは左列 x = 60、垂直中央から等間隔
    const centerEntity = H / 2;
    const totalEntityH = Math.max(0, E - 1) * ENTITY_GAP;
    const entityStart = centerEntity - totalEntityH / 2;
    const entityPos = new Map<
      string,
      { x: number; y: number; index: number }
    >();
    entities.forEach((e, i) => {
      entityPos.set(e.key, {
        x: 60 + ENTITY_W / 2,
        y: entityStart + i * ENTITY_GAP,
        index: i,
      });
    });

    // 画面の Y = 使うエンティティ Y の平均。それを並び順ソートして間隔調整。
    const screenBary = new Map<number, number>();
    usedScreens.forEach((s) => {
      const ys: number[] = [];
      entities.forEach((e) => {
        if (e.screens.some((x) => x.id === s.id)) {
          const p = entityPos.get(e.key);
          if (p) ys.push(p.y);
        }
      });
      const avg = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
      screenBary.set(s.id, avg);
    });
    const orderedScreens = [...usedScreens].sort(
      (a, b) => (screenBary.get(a.id) ?? 0) - (screenBary.get(b.id) ?? 0),
    );
    const totalScreenH = Math.max(0, orderedScreens.length - 1) * SCREEN_GAP;
    const screenStart = H / 2 - totalScreenH / 2;
    const screenPos = new Map<number, { x: number; y: number }>();
    orderedScreens.forEach((s, i) => {
      screenPos.set(s.id, {
        x: W - 60 - SCREEN_W / 2,
        y: screenStart + i * SCREEN_GAP,
      });
    });

    return { W, H, entityPos, screenPos, usedScreens };
  }, [entities, nodes]);

  const { W, H, entityPos, screenPos, usedScreens } = layout;

  const vbW = W / zoom;
  const vbH = H / zoom;
  const vbX = (W - vbW) / 2 - pan.x;
  const vbY = (H - vbH) / 2 - pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // wheel zoom
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

  const totalUses = entities.reduce((a, e) => a + e.screens.length, 0);

  return (
    <div className="space-y-4">
      {/* タイトル + サマリ + ズーム */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
            {tx("システム全体のデータ配置", "System data layout")}
            <SparkleIcon className="w-5 h-5 text-feature-purple" />
          </h1>
          <p className="text-sm text-ink-soft mt-1">
            {tx(
              "左のデータ(エンティティ)と右の画面のつながりです。ホイールで拡大/縮小、ドラッグで移動できます。",
              "Data (left) ↔ screens (right). Wheel to zoom, drag to pan.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatChip color="purple" count={entities.length} label={tx("エンティティ", "entities")} />
          <StatChip color="teal" count={totalUses} label={tx("参照", "reads/writes")} />
        </div>
      </div>

      {/* マップ */}
      <div className="bg-paper rounded-[16px] border border-border-soft p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3 text-xs text-ink-soft">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded" style={{ background: "#EDE9FE", border: "1px solid #C4B5FD" }} />
              {tx("データ", "data")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full" style={{ background: "#F0FDFA", border: "1px solid #5EEAD4" }} />
              {tx("画面", "screens")}
            </span>
          </div>
          <ZoomControls
            zoom={zoom}
            onIn={zoomIn}
            onOut={zoomOut}
            onReset={zoomReset}
            language={language}
          />
        </div>
        <div
          ref={svgWrapRef}
          className="bg-canvas-soft rounded-[12px] relative overflow-hidden touch-none"
          style={{ height: "min(calc(100vh - 280px), 720px)", minHeight: 520 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          {entities.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-soft">
              {tx(
                "データ情報がまだありません。再分析すると AI がデータを抽出します。",
                "No data yet. Re-analyze to let the AI extract entities.",
              )}
            </div>
          ) : (
            <svg
              viewBox={viewBox}
              className="w-full h-full select-none block"
              style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
              role="img"
              aria-label={tx("データ配置マップ", "Data layout map")}
            >
              <defs>
                <radialGradient id="dbmap-bg" cx="50%" cy="50%" r="60%">
                  <stop offset="0%" stopColor="#f0fdfa" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#f8fafc" stopOpacity="0" />
                </radialGradient>
              </defs>
              <rect x="0" y="0" width={W} height={H} fill="url(#dbmap-bg)" />

              {/* エッジ:エンティティ → 画面 */}
              <g aria-label={tx("参照つながり", "usage links")}>
                {entities.map((e, i) => {
                  const p = PALETTE[i % PALETTE.length];
                  const ePos = entityPos.get(e.key);
                  if (!ePos) return null;
                  const startX = ePos.x + ENTITY_W / 2;
                  const startY = ePos.y;
                  return e.screens.map((s) => {
                    const sPos = screenPos.get(s.id);
                    if (!sPos) return null;
                    const endX = sPos.x - SCREEN_W / 2;
                    const endY = sPos.y;
                    const midX = (startX + endX) / 2;
                    const emphasis =
                      hoveredEntityKey === e.key || hoveredScreenId === s.id;
                    return (
                      <path
                        key={`${e.key}-${s.id}`}
                        d={`M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}`}
                        fill="none"
                        stroke={p.fill}
                        strokeOpacity={emphasis ? 0.85 : 0.35}
                        strokeWidth={emphasis ? 2.4 : 1.5}
                        strokeLinecap="round"
                        style={{ transition: "stroke-opacity 0.15s, stroke-width 0.15s" }}
                      />
                    );
                  });
                })}
              </g>

              {/* エンティティボックス */}
              <g aria-label={tx("エンティティ", "entities")}>
                {entities.map((e, i) => {
                  const p = PALETTE[i % PALETTE.length];
                  const pos = entityPos.get(e.key);
                  if (!pos) return null;
                  const x = pos.x - ENTITY_W / 2;
                  const y = pos.y - ENTITY_H / 2;
                  const label = pickLocalized(e.name, language);
                  const isHovered = hoveredEntityKey === e.key;
                  return (
                    <g
                      key={e.key}
                      onMouseEnter={() => setHoveredEntityKey(e.key)}
                      onMouseLeave={() => setHoveredEntityKey(null)}
                      style={{
                        filter: isHovered
                          ? `drop-shadow(0 4px 10px ${p.fill}33)`
                          : "drop-shadow(0 1px 3px rgba(15,23,42,0.06))",
                        transition: "filter 0.15s",
                      }}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={ENTITY_W}
                        height={ENTITY_H}
                        rx={10}
                        fill={p.soft}
                        stroke={p.border}
                        strokeWidth={isHovered ? 2 : 1.5}
                      />
                      {/* 左端の色バー */}
                      <rect
                        x={x}
                        y={y}
                        width={5}
                        height={ENTITY_H}
                        rx={2.5}
                        fill={p.fill}
                      />
                      {/* テーブル/データベースを想起させる 3 本線 */}
                      <g
                        transform={`translate(${x + 14}, ${y + 14}) scale(0.9)`}
                        stroke={p.text}
                        strokeWidth="1.6"
                        fill="none"
                        strokeLinecap="round"
                      >
                        <ellipse cx="10" cy="4" rx="8" ry="2.5" />
                        <path d="M2 4 V12 A8 2.5 0 0 0 18 12 V4" />
                        <path d="M2 12 V20 A8 2.5 0 0 0 18 20 V12" />
                      </g>
                      <text
                        x={x + 42}
                        y={pos.y - 4}
                        fill={p.text}
                        fontSize="14"
                        fontWeight="700"
                        dominantBaseline="middle"
                      >
                        {truncate(label, 14)}
                      </text>
                      <text
                        x={x + 42}
                        y={pos.y + 12}
                        fill="#64748b"
                        fontSize="10"
                        dominantBaseline="middle"
                      >
                        {tx(
                          `${e.screens.length} 画面で使用`,
                          `used by ${e.screens.length}`,
                        )}
                      </text>
                    </g>
                  );
                })}
              </g>

              {/* 画面ボックス(クリックで Inspector 起動)*/}
              <g aria-label={tx("画面一覧", "screens")}>
                {usedScreens.map((s) => {
                  const pos = screenPos.get(s.id);
                  if (!pos) return null;
                  const x = pos.x - SCREEN_W / 2;
                  const y = pos.y - SCREEN_H / 2;
                  const label = pickLocalized(s.userIntent ?? s.label, language);
                  const isHovered = hoveredScreenId === s.id;
                  return (
                    <g
                      key={s.id}
                      onClick={() => {
                        if (wasDraggingRef.current) return;
                        onSelectNode(s.id);
                      }}
                      onMouseEnter={() => setHoveredScreenId(s.id)}
                      onMouseLeave={() => setHoveredScreenId(null)}
                      className="cursor-pointer"
                      style={{
                        filter: isHovered
                          ? "drop-shadow(0 4px 10px rgba(20,184,166,0.24))"
                          : "drop-shadow(0 1px 3px rgba(15,23,42,0.06))",
                        transition: "filter 0.15s",
                      }}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={SCREEN_W}
                        height={SCREEN_H}
                        rx={SCREEN_H / 2}
                        fill="#FFFFFF"
                        stroke={isHovered ? "#14B8A6" : "#CBD5E1"}
                        strokeWidth={isHovered ? 2 : 1.2}
                      />
                      <text
                        x={pos.x}
                        y={pos.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#0f172a"
                        fontSize="13"
                        fontWeight="600"
                      >
                        {truncate(label, 14)}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function StatChip({
  color,
  count,
  label,
}: {
  color: "teal" | "purple";
  count: number;
  label: string;
}) {
  const tokens =
    color === "teal"
      ? {
          soft: "var(--color-feature-teal-soft)",
          strong: "var(--color-feature-teal)",
          txt: "text-feature-teal",
        }
      : {
          soft: "var(--color-feature-purple-soft)",
          strong: "var(--color-feature-purple)",
          txt: "text-feature-purple",
        };
  return (
    <span
      className="flex items-center gap-2 rounded-[14px] px-3.5 py-2 border-2"
      style={{ background: tokens.soft, borderColor: tokens.strong }}
    >
      <span
        className={`text-xl font-extrabold leading-none tabular-nums ${tokens.txt}`}
      >
        {count}
      </span>
      <span className={`text-xs font-bold ${tokens.txt}`}>{label}</span>
    </span>
  );
}

function ZoomControls({
  zoom,
  onIn,
  onOut,
  onReset,
  language,
}: {
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
  language: Language;
}) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);
  return (
    <div className="flex items-center border border-border-soft rounded-[10px] overflow-hidden bg-paper">
      <button
        type="button"
        onClick={onOut}
        className="px-2.5 py-1.5 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
        title={tx("縮小", "Zoom out")}
      >
        −
      </button>
      <span className="px-2 text-[11px] text-ink-soft font-mono border-x border-border-soft min-w-[40px] text-center select-none">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={onIn}
        className="px-2.5 py-1.5 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
        title={tx("拡大", "Zoom in")}
      >
        +
      </button>
      <button
        type="button"
        onClick={onReset}
        className="px-2.5 py-1.5 text-xs text-ink hover:bg-canvas transition-colors cursor-pointer border-l border-border-soft"
        title={tx("リセット", "Reset")}
      >
        ⟲
      </button>
    </div>
  );
}

export default DatabaseView;
