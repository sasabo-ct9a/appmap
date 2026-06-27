import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ScreenNode,
  ScreenEdge,
  LocalizedText,
  Bilingual,
} from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7 マインドマップ化:中心ノード + 放射状の主枝 + 葉チップ。
 *   - 中心:アプリ全体(appSummary)
 *   - 主枝:各 ScreenNode(userIntent + label)
 *   - 葉:各 ScreenNode.subActions のチップ(あれば)、無ければ dataUsed をフォールバック
 *   - 枝間の ScreenEdge は「関連するつながり」として点線で描画
 *
 * 旧 spider レイアウトは廃止。マインドマップ層構造でアプリの「カテゴリ → 個別アクション」が一目で読める。
 */

// v0.1.7 改修:中心ノード撤去で CENTER_W / CENTER_H は不要に
// 主枝(各画面)ピル
const BRANCH_W = 172;
const BRANCH_H = 70;
// 葉チップ高さ(幅は文字数で動的計算)
const LEAF_H = 28;
const LEAF_GAP_X = 90; // 主枝と葉カラムの距離
const LEAF_SPACING_Y = 38; // 葉同士の縦間隔
const LEAF_FAN_X = 14; // 中央葉から離れるほど少し外側に出すフェイン量

// ノード id → カラーパレット(機能カードと一致、4 色サイクル)
const PALETTE = [
  { accent: "#14B8A6", border: "#5EEAD4", soft: "#CCFBF1", text: "#0D9488" }, // teal
  { accent: "#F59E0B", border: "#FCD34D", soft: "#FEF3C7", text: "#B45309" }, // amber
  { accent: "#8B5CF6", border: "#C4B5FD", soft: "#EDE9FE", text: "#6D28D9" }, // purple
  { accent: "#3B82F6", border: "#93C5FD", soft: "#DBEAFE", text: "#1D4ED8" }, // blue
  { accent: "#EC4899", border: "#F9A8D4", soft: "#FCE7F3", text: "#BE185D" }, // pink
  { accent: "#10B981", border: "#6EE7B7", soft: "#D1FAE5", text: "#047857" }, // emerald
  { accent: "#06B6D4", border: "#67E8F9", soft: "#CFFAFE", text: "#0E7490" }, // cyan
  { accent: "#F97316", border: "#FDBA74", soft: "#FFEDD5", text: "#C2410C" }, // orange
];
function paletteFor(id: number) {
  return PALETTE[(id - 1) % PALETTE.length];
}

type MapCanvasProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  selectedNodeId: number | null;
  onNodeClick: (id: number) => void;
  noCodeMode?: boolean;
  language: Language;
  showImportantOnly: boolean;
  onToggleImportantOnly: (next: boolean) => void;
  onShowAll: () => void;
  appSummary?: LocalizedText;
  appName?: string;
  /** 構造を見るページ用の大画面モード。SVG 領域を viewport いっぱいに広げる。 */
  tall?: boolean;
  /** ユーザーのドラッグ位置(App から lift up、PDF 出力でも共有)*/
  nodeOffsets: Map<number, { x: number; y: number }>;
  onNodeOffsetsChange: (
    updater: (
      prev: Map<number, { x: number; y: number }>,
    ) => Map<number, { x: number; y: number }>,
  ) => void;
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 文字数ベースの幅見積もり(JA: 1 文字 ≈ 12px、EN: 1 文字 ≈ 7px)。 */
function estimateTextWidth(text: string, isJa: boolean): number {
  return text.length * (isJa ? 12 : 7) + 32;
}

/** 旧 NodeTile 互換 export(既存 import を壊さないため)。 */
export const NODE_WIDTH = BRANCH_W;
export const NODE_HEIGHT = BRANCH_H;

function MapCanvas({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  noCodeMode = false,
  language,
  showImportantOnly,
  onToggleImportantOnly,
  onShowAll,
  appSummary,
  appName,
  tall = false,
  nodeOffsets,
  onNodeOffsetsChange,
}: MapCanvasProps) {
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

  // 主枝ノードの D&D 移動用オフセット:App から lift up された props を使う。
  // 状態は親(App.tsx)が保持しているので、SpecDocMap や別の MapCanvas からも参照可能。
  const nodeDragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  /**
   * マインドマップレイアウト:
   *   - 中心:(W/2, H/2)
   *   - 主枝:中心から半径 R で N 等分角度に配置
   *   - 葉:各主枝の「外向き」サイドに縦カラムで配置
   */
  const layout = useMemo(() => {
    const N = nodes.length;
    // エントリーポイントを中心に置き、それ以外を周囲に展開する
    const entry = nodes.find((n) => n.isEntryPoint);
    const othersRaw = entry ? nodes.filter((n) => n.id !== entry.id) : nodes;

    // 交差削減:他ノード同士の連結を見て、つながり合うノードが隣接するように並べ替え。
    // entry 経由のエッジは除いて adjacency を作る(entry は中心からの放射エッジのみ)。
    const otherIds = new Set(othersRaw.map((n) => n.id));
    const adjacency = new Map<number, Set<number>>();
    for (const e of edges) {
      if (!otherIds.has(e.from) || !otherIds.has(e.to)) continue;
      adjacency.set(
        e.from,
        (adjacency.get(e.from) ?? new Set()).add(e.to),
      );
      adjacency.set(
        e.to,
        (adjacency.get(e.to) ?? new Set()).add(e.from),
      );
    }
    const degree = (id: number) => adjacency.get(id)?.size ?? 0;
    const ordered: ScreenNode[] = [];
    const visited = new Set<number>();
    if (othersRaw.length > 0) {
      const start = [...othersRaw].sort(
        (a, b) => degree(b.id) - degree(a.id),
      )[0];
      ordered.push(start);
      visited.add(start.id);
      while (ordered.length < othersRaw.length) {
        const last = ordered[ordered.length - 1];
        const neighbors = adjacency.get(last.id) ?? new Set();
        let next: ScreenNode | null = null;
        for (const n of othersRaw) {
          if (visited.has(n.id)) continue;
          if (!neighbors.has(n.id)) continue;
          if (!next || degree(n.id) > degree(next.id)) next = n;
        }
        if (!next) {
          for (const n of othersRaw) {
            if (visited.has(n.id)) continue;
            if (!next || degree(n.id) > degree(next.id)) next = n;
          }
        }
        if (!next) break;
        ordered.push(next);
        visited.add(next.id);
      }
    }
    const others = ordered;
    const M = others.length;

    // 葉数の上限:多ノード時はチップ密度を抑える
    const leafCap = N >= 10 ? 4 : N >= 7 ? 5 : 7;
    const leafCountsCapped = others.map((n) => {
      const src = n.subActions ?? n.detail.dataUsed ?? [];
      return Math.min(src.length, leafCap);
    });
    const maxLeafCount = Math.max(0, ...leafCountsCapped);

    // 半径:周囲のノード数に比例して伸ばす
    const R_branch = M > 0 ? Math.max(220, 110 + M * 36) : 0;
    const leafOuterReach = BRANCH_W / 2 + LEAF_GAP_X + 200;
    const reach = R_branch + leafOuterReach;
    const W = Math.max(1100, reach * 2 + 120);
    const heightForLeaves = Math.max(1, maxLeafCount) * LEAF_SPACING_Y + 80;
    const H = Math.max(620, reach * 2 + heightForLeaves * 0.4);
    const cx = W / 2;
    const cy = H / 2;

    const branchPositions = new Map<
      number,
      { x: number; y: number; angle: number }
    >();
    const leafPositions = new Map<
      number,
      Array<{ x: number; y: number; w: number; label: string }>
    >();

    // 中心にエントリーポイントを配置(葉は持たない:周囲のノード自体が「葉」の役)
    if (entry) {
      branchPositions.set(entry.id, { x: cx, y: cy, angle: 0 });
      leafPositions.set(entry.id, []);
    }

    // 周囲のノードを放射状に配置(UL から時計回り)
    others.forEach((node, i) => {
      const angleDeg = M > 0 ? -135 + (360 / M) * i : 0;
      const angleRad = (angleDeg * Math.PI) / 180;
      const bx = cx + R_branch * Math.cos(angleRad);
      const by = cy + R_branch * Math.sin(angleRad);
      branchPositions.set(node.id, { x: bx, y: by, angle: angleRad });

      const leafSourceAll: LocalizedText[] =
        node.subActions && node.subActions.length > 0
          ? node.subActions
          : node.detail.dataUsed ?? [];
      const leafSource = leafSourceAll.slice(0, leafCap);

      const isJa = language === "ja";
      const isRight = Math.cos(angleRad) >= 0;
      const sign = isRight ? 1 : -1;
      const baseColumnX = bx + sign * (BRANCH_W / 2 + LEAF_GAP_X);
      const K = leafSource.length;
      const leaves = leafSource.map((leaf, k) => {
        const label = pickLocalized(leaf, language);
        const w = estimateTextWidth(label, isJa);
        const offset = k - (K - 1) / 2;
        const leafY = by + offset * LEAF_SPACING_Y;
        const leafX = baseColumnX + sign * Math.abs(offset) * LEAF_FAN_X;
        return { x: leafX, y: leafY, w, label };
      });
      leafPositions.set(node.id, leaves);
    });

    return {
      width: W,
      height: H,
      cx,
      cy,
      branchPositions,
      leafPositions,
    };
  }, [nodes, language]);

  const { width: W, height: H, cx, cy, branchPositions, leafPositions } = layout;

  // ズーム + パン適用後の viewBox
  const vbW = W / zoom;
  const vbH = H / zoom;
  const vbX = (W - vbW) / 2 - pan.x;
  const vbY = (H - vbH) / 2 - pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // マウスホイールでズーム(passive: false で preventDefault)
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

  // ドラッグでパン
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
    // クリックイベントが直後に発火するため、ワンテンポ遅延してドラッグフラグを下げる
    setTimeout(() => {
      wasDraggingRef.current = false;
    }, 0);
  };

  // ノードクリック:ドラッグ中だったらキャンセル
  const handleNodeClickSafe = (id: number) => {
    if (wasDraggingRef.current) return;
    onNodeClick(id);
  };

  const zoomIn = () => setZoom((z) => clamp(z * 1.2, ZOOM_MIN, ZOOM_MAX));
  const zoomOut = () => setZoom((z) => clamp(z / 1.2, ZOOM_MIN, ZOOM_MAX));
  const zoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // ─── ノードドラッグ:主枝をクリック+ドラッグで動かす ───
  const offsetFor = (id: number) =>
    nodeOffsets.get(id) ?? { x: 0, y: 0 };
  const handleNodePointerDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // canvas pan に伝播させない
    const off = offsetFor(id);
    nodeDragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      origX: off.x,
      origY: off.y,
    };
    wasDraggingRef.current = false;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const handleNodePointerMove = (e: React.PointerEvent) => {
    const ctx = nodeDragRef.current;
    if (!ctx) return;
    const dx = e.clientX - ctx.startX;
    const dy = e.clientY - ctx.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      wasDraggingRef.current = true;
      const wrap = svgWrapRef.current;
      const rect = wrap?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        const svgPerPx = vbW / rect.width;
        const nx = ctx.origX + dx * svgPerPx;
        const ny = ctx.origY + dy * svgPerPx;
        onNodeOffsetsChange((prev) => {
          const next = new Map(prev);
          next.set(ctx.id, { x: nx, y: ny });
          return next;
        });
      }
    }
  };
  const handleNodePointerUp = (e: React.PointerEvent) => {
    const ctx = nodeDragRef.current;
    nodeDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    // SVG 要素の onClick は setPointerCapture と干渉して発火しないことがあるため、
    // pointerup の中で「ドラッグしてないなら click 扱い」を手動で実行する。
    if (ctx && !wasDraggingRef.current) {
      onNodeClick(ctx.id);
    }
    setTimeout(() => {
      wasDraggingRef.current = false;
    }, 0);
  };

  // v0.1.7 改修:中心ノード撤去で appName / appSummary は未使用
  // (将来戻すかもしれないので props には残置、変数参照だけ消す)
  void appName;
  void appSummary;

  return (
    <div className="bg-paper rounded-[16px] border border-border-soft p-5">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink-strong">
            {language === "ja" ? "アプリの全体像" : "App overview"}
          </h2>
          <span className="text-sm text-ink-soft">
            {language === "ja" ? "(マインドマップ)" : "(mind map)"}
          </span>
          <span
            className="w-4 h-4 rounded-full border border-ink-soft text-ink-soft text-[10px] flex items-center justify-center cursor-help"
            title={
              language === "ja"
                ? "各画面をクリックすると詳細が見られます。葉のチップはその画面でできることです。"
                : "Click a screen to see details. Leaves show what you can do on that screen."
            }
          >
            ?
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-ink">
              {language === "ja" ? "重要な画面だけ表示" : "Important only"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={showImportantOnly}
              onClick={() => onToggleImportantOnly(!showImportantOnly)}
              className="w-9 h-5 rounded-full relative transition-colors"
              style={{ background: showImportantOnly ? "#19D3C5" : "#cbd5e1" }}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all shadow ${
                  showImportantOnly ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
          </label>
          <button
            type="button"
            onClick={onShowAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-border-soft text-xs text-ink hover:bg-canvas transition-colors cursor-pointer"
          >
            <BoxesIcon />
            {language === "ja" ? "すべての画面を見る" : "Show all screens"}
          </button>
          {/* ズームコントロール(- 100% + ⟲) */}
          <div className="flex items-center border border-border-soft rounded-[10px] overflow-hidden bg-paper">
            <button
              type="button"
              onClick={zoomOut}
              className="px-2.5 py-1.5 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
              title={language === "ja" ? "縮小" : "Zoom out"}
              aria-label={language === "ja" ? "縮小" : "Zoom out"}
            >
              −
            </button>
            <span className="px-2 text-[11px] text-ink-soft font-mono border-x border-border-soft min-w-[40px] text-center select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              className="px-2.5 py-1.5 text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
              title={language === "ja" ? "拡大" : "Zoom in"}
              aria-label={language === "ja" ? "拡大" : "Zoom in"}
            >
              +
            </button>
            <button
              type="button"
              onClick={zoomReset}
              className="px-2.5 py-1.5 text-xs text-ink hover:bg-canvas transition-colors cursor-pointer border-l border-border-soft"
              title={language === "ja" ? "リセット" : "Reset"}
              aria-label={language === "ja" ? "リセット" : "Reset"}
            >
              ⟲
            </button>
          </div>
        </div>
      </div>

      {/* SVG マップ */}
      <div
        ref={svgWrapRef}
        className="bg-canvas-soft rounded-[12px] relative overflow-hidden touch-none"
        style={
          tall
            ? { height: "min(calc(100vh - 280px), 780px)", minHeight: 560 }
            : { height: Math.round(H * 0.62) }
        }
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
          aria-label={language === "ja" ? "アプリ構造マインドマップ" : "App structure mind map"}
        >
          <defs>
            <radialGradient id="mindmap-bg" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="#f0fdfa" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#f8fafc" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width={W} height={H} fill="url(#mindmap-bg)" />

          {/* === 1. 枝間の関連エッジ(点線、最背面)
              密度緩和:デフォルトは超薄、hover した枝に紐づくものだけ強調 === */}
          <g aria-label={language === "ja" ? "関連するつながり" : "related links"}>
            {edges.map((edge) => {
              const fromBase = branchPositions.get(edge.from);
              const toBase = branchPositions.get(edge.to);
              if (!fromBase || !toBase) return null;
              const fromOff = offsetFor(edge.from);
              const toOff = offsetFor(edge.to);
              const fromB = {
                x: fromBase.x + fromOff.x,
                y: fromBase.y + fromOff.y,
              };
              const toB = {
                x: toBase.x + toOff.x,
                y: toBase.y + toOff.y,
              };
              const fromP = paletteFor(edge.from);
              const midX = (fromB.x + toB.x) / 2;
              const midY = (fromB.y + toB.y) / 2;
              // 中心 entry を避けて外側に膨らませる:制御点を中心の反対方向へ
              const dx = midX - cx;
              const dy = midY - cy;
              const d = Math.sqrt(dx * dx + dy * dy) || 1;
              const pushOut = 80; // 外側にどれだけ膨らませるか
              const pullX = midX + (dx / d) * pushOut;
              const pullY = midY + (dy / d) * pushOut;
              const involved =
                hoveredId !== null &&
                (edge.from === hoveredId || edge.to === hoveredId);
              const selectedInvolved =
                selectedNodeId !== null &&
                (edge.from === selectedNodeId || edge.to === selectedNodeId);
              const emphasis = involved || selectedInvolved;
              return (
                <path
                  key={edge.id}
                  d={`M ${fromB.x} ${fromB.y} Q ${pullX} ${pullY} ${toB.x} ${toB.y}`}
                  fill="none"
                  stroke={fromP.accent}
                  strokeOpacity={emphasis ? 0.8 : 0.32}
                  strokeWidth={emphasis ? 2.2 : 1.4}
                  strokeLinecap="round"
                  style={{ transition: "stroke-opacity 0.15s, stroke-width 0.15s" }}
                />
              );
            })}
          </g>

          {/* v0.1.7 改修:中心 → 主枝のエッジは撤去(中心ノードも撤去のため)*/}

          {/* === 3. 主枝 → 葉(細線、枝の色)=== */}
          <g aria-label={language === "ja" ? "葉つながり" : "leaf links"}>
            {nodes.map((node) => {
              const baseB = branchPositions.get(node.id);
              const leaves = leafPositions.get(node.id);
              if (!baseB || !leaves) return null;
              const off = offsetFor(node.id);
              const b = { x: baseB.x + off.x, y: baseB.y + off.y };
              const p = paletteFor(node.id);
              const isRight = b.x >= cx;
              const sign = isRight ? 1 : -1;
              const branchEdgeX = b.x + sign * (BRANCH_W / 2 - 4);
              const branchEdgeY = b.y;
              return leaves.map((leaf, i) => {
                const leafX = leaf.x + off.x;
                const leafY = leaf.y + off.y;
                const leafEdgeX = leafX - sign * (leaf.w / 2);
                const leafEdgeY = leafY;
                const midX = (branchEdgeX + leafEdgeX) / 2;
                const midY = (branchEdgeY + leafEdgeY) / 2;
                return (
                  <path
                    key={`leaf-${node.id}-${i}`}
                    d={`M ${branchEdgeX} ${branchEdgeY} Q ${midX} ${midY} ${leafEdgeX} ${leafEdgeY}`}
                    fill="none"
                    stroke={p.accent}
                    strokeOpacity={0.5}
                    strokeWidth={1.4}
                    strokeDasharray="3 4"
                    strokeLinecap="round"
                  />
                );
              });
            })}
          </g>

          {/* === 4. 葉チップ(クリックで親画面の Inspector を開く)=== */}
          <g aria-label={language === "ja" ? "アクション一覧" : "actions"}>
            {nodes.map((node) => {
              const leaves = leafPositions.get(node.id);
              if (!leaves) return null;
              const off = offsetFor(node.id);
              const p = paletteFor(node.id);
              return leaves.map((leaf, i) => {
                const lx = leaf.x + off.x;
                const ly = leaf.y + off.y;
                return (
                  <g
                    key={`leafchip-${node.id}-${i}`}
                    onClick={() => handleNodeClickSafe(node.id)}
                    className="cursor-pointer"
                  >
                    <rect
                      x={lx - leaf.w / 2}
                      y={ly - LEAF_H / 2}
                      width={leaf.w}
                      height={LEAF_H}
                      rx={LEAF_H / 2}
                      fill={p.soft}
                      stroke={p.border}
                      strokeWidth={1}
                    />
                    <text
                      x={lx}
                      y={ly + 1}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={p.text}
                      fontSize="11.5"
                      fontWeight="600"
                    >
                      {leaf.label}
                    </text>
                  </g>
                );
              });
            })}
          </g>

          {/* === 5. 主枝ノード(クリック可能)=== */}
          <g aria-label={language === "ja" ? "画面一覧" : "screen list"}>
            {nodes.map((node) => {
              const baseB = branchPositions.get(node.id);
              if (!baseB) return null;
              const off = offsetFor(node.id);
              const b = { x: baseB.x + off.x, y: baseB.y + off.y };
              const p = paletteFor(node.id);
              const isSelected = node.id === selectedNodeId;
              const isHovered = node.id === hoveredId;
              const isActive = isSelected || isHovered;
              const isBeingDragged = nodeDragRef.current?.id === node.id;
              const labelSource =
                noCodeMode && node.userIntent
                  ? node.userIntent
                  : node.userIntent ?? node.label;
              const title = pickLocalized(labelSource, language);
              const subtitle = pickLocalized(node.detail.title, language);
              const x = b.x - BRANCH_W / 2;
              const y = b.y - BRANCH_H / 2;
              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onPointerCancel={handleNodePointerUp}
                  className="cursor-grab active:cursor-grabbing"
                  style={{
                    filter: isActive || isBeingDragged
                      ? `drop-shadow(0 6px 16px ${p.accent}33)`
                      : "drop-shadow(0 2px 6px rgba(15,23,42,0.08))",
                    transition: isBeingDragged ? "none" : "filter 0.15s",
                  }}
                >
                  {/* 主枝ピル */}
                  <rect
                    x={x}
                    y={y}
                    width={BRANCH_W}
                    height={BRANCH_H}
                    rx={BRANCH_H / 2}
                    fill={p.soft}
                    stroke={isActive ? p.accent : p.border}
                    strokeWidth={isActive ? 2.5 : 2}
                  />
                  {/* タイトル(userIntent or label)*/}
                  <text
                    x={b.x}
                    y={b.y - 8}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={p.text}
                    fontSize="15"
                    fontWeight="700"
                  >
                    {truncate(title, 11)}
                  </text>
                  {/* サブタイトル(画面 title)*/}
                  <text
                    x={b.x}
                    y={b.y + 13}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#64748b"
                    fontSize="10.5"
                  >
                    {truncate(subtitle, 16)}
                  </text>
                  {/* エントリーポイントバッジ */}
                  {node.isEntryPoint && (
                    <g pointerEvents="none">
                      <rect
                        x={b.x - 36}
                        y={y - 18}
                        width={72}
                        height={16}
                        rx={8}
                        fill={p.accent}
                      />
                      <text
                        x={b.x}
                        y={y - 9}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="white"
                        fontSize="9"
                        fontWeight="700"
                      >
                        {language === "ja" ? "▶ はじまり" : "▶ START"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          {/* v0.1.7 改修:中心ノード(AppMap ラベル)は撤去
              ─ 分析対象アプリの構成と誤解されるため。
              枝同士の関連線は残し、主枝 + 葉のみで表現する。 */}
        </svg>
      </div>

      {/* 凡例 */}
      <Legend nodes={nodes} language={language} />
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

type LegendProps = {
  nodes: ScreenNode[];
  language: Language;
};
function Legend({ nodes, language }: LegendProps) {
  return (
    <div className="flex items-center justify-between mt-3 text-xs text-ink-soft px-1 flex-wrap gap-2">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="flex items-center gap-1.5">
          <svg width="24" height="2">
            <line
              x1="0"
              y1="1"
              x2="24"
              y2="1"
              stroke="#14B8A6"
              strokeWidth="2"
            />
          </svg>
          {language === "ja" ? "要素どうしのつながり" : "between pieces"}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="24" height="2">
            <line
              x1="0"
              y1="1"
              x2="24"
              y2="1"
              stroke="#94a3b8"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          </svg>
          {language === "ja" ? "要素の中でできること" : "actions inside"}
        </span>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {nodes.slice(0, 8).map((node) => {
          const p = paletteFor(node.id);
          const labelSource =
            (node.userIntent ?? node.label) as LocalizedText;
          const labelStr = isBilingual(labelSource)
            ? labelSource[language]
            : labelSource;
          return (
            <span key={node.id} className="flex items-center gap-1">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: p.accent }}
              />
              {truncate(labelStr, language === "ja" ? 8 : 14)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function isBilingual(v: LocalizedText): v is Bilingual {
  return typeof v === "object" && v !== null && "ja" in v && "en" in v;
}

function BoxesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-3.5 h-3.5"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export default MapCanvas;
