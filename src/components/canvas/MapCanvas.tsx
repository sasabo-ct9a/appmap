import { useEffect, useRef, useState } from "react";
import type { ScreenNode, ScreenEdge } from "../../types/screen";
import NodeTile, { NODE_HEIGHT, NODE_WIDTH } from "./NodeTile";
import Edge from "./Edge";
import { t, type Language } from "../../lib/i18n";

/**
 * SVG マップ全体(CLAUDE.md §10.5.1、DARK モード、機能拡張:単一 SVG モード)。
 *
 * 旧 v5 では「N 枚の MapCanvas を CSS 3D 回転して積み重ねる」構造だったが、
 * 階層をまたぐエッジが viewBox でぶつ切りされる(両プレーンに stub だけ出る)
 * 問題があった。
 *
 * 新構造:
 *   - 単一 SVG に N 枚の「フロア(背景 rect)」を縦に並べる
 *   - 全ノードと全エッジを同じ座標系で描画 → 矢印は階層を無視して直線で繋がる
 *   - CSS 3D 回転は廃止(直線連続を優先)
 *   - フロア間に明確な隙間(PLANE_GAP)、各フロアは縦に広め(PLANE_HEIGHT)
 *
 * 階層数(numPlanes)はノードの maxDepth + 1 で自動算出。
 * ノードの y 座標は depth から自動計算するため、AI 側 / sampleScreens 側の
 * `position.y` の値は無視される(x と depth だけが効く)。
 */
type MapCanvasProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  selectedNodeId: number | null;
  onNodeClick: (id: number) => void;
  /** §3.3 対応:プレーンラベルをノーコード語に切り替える。 */
  noCodeMode?: boolean;
  /**
   * v0.1.2 ドラッグ機能:各ノードの永続化済み X 軸オフセット(localStorage 由来)。
   * キーは node.id を文字列化したもの、値は元の position.x からの差分(px、viewBox 単位)。
   * 省略時は何もオフセットが無い状態(AI が出した位置そのまま)。
   */
  dragOffsetsX?: Record<string, number>;
  /**
   * ドラッグ確定時(mouseup)に呼ばれる callback。
   * 親側で localStorage に保存する責務を持つ。
   */
  onDragOffsetsChange?: (offsets: Record<string, number>) => void;
  /** v0.1.6: UI 言語(プレーンラベル・aria-label の JA / EN 切替に使用)。 */
  language: Language;
};

const PLANE_HEIGHT = 150; // 1 フロアの SVG 内高さ(縦に広めに)
const PLANE_GAP = 28; // フロア間の隙間
/** ドラッグ時にノードを「フロアの中」に保つマージン(SVG 座標 px)。
 *  floor rect は x=8 から始まるので、24 = フロア境界から +16 内側を許容。 */
const DRAG_BOUND_MARGIN = 24;

/** 各 depth で、ノードの top y(SVG 座標)を求める。 */
function nodeYForDepth(depth: number): number {
  const planeTop = depth * (PLANE_HEIGHT + PLANE_GAP);
  return planeTop + (PLANE_HEIGHT - NODE_HEIGHT) / 2;
}

/** depth に応じたフロア背景色(明 → 暗のグラデ)。 */
function planeBgFill(depth: number): string {
  const t = Math.min(1, depth * 0.35);
  const r = Math.round(46 - 36 * t);
  const g = Math.round(63 - 47 * t);
  const b = Math.round(85 - 59 * t);
  const a = 0.78 + t * 0.04;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** depth に応じたフロア枠線(深いほど薄く)。 */
function planeStrokeColor(depth: number): string {
  return `rgba(229, 231, 235, ${Math.max(0.08, 0.22 - depth * 0.05)})`;
}

function MapCanvas({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  noCodeMode = false,
  dragOffsetsX = {},
  onDragOffsetsChange,
  language,
}: MapCanvasProps) {
  const T = t(language);
  /**
   * 階層プレーンのラベル(v0.1.6 以降 i18n 化)。
   *
   * 旧:noCodeMode で「主フロー」「主な画面」など切替えていたが、ターゲットユーザー
   * 全員「コードを読みたくない」(§2)前提なので、構造ラベルは常に同じクリーンな
   * 語彙で統一。「フロー」のような技術用語を避け、「メイン/サブ/詳細/深層」に。
   */
  const planeLabel = (depth: number): string => T.canvas.planeLabel(depth);
  // ───────────────────────────────────────────────────
  // v0.1.2 ドラッグ機能(A 案):同 depth プレーン内で X 軸のみ手動調整
  // ───────────────────────────────────────────────────
  // liveOffsets: ドラッグ中も含めた最新オフセット。props 変更(履歴切替・再分析)で同期。
  const svgRef = useRef<SVGSVGElement>(null);
  const [liveOffsets, setLiveOffsets] =
    useState<Record<string, number>>(dragOffsetsX);
  const liveOffsetsRef = useRef(liveOffsets);
  useEffect(() => {
    liveOffsetsRef.current = liveOffsets;
  }, [liveOffsets]);
  // 親から渡された永続化済みオフセットが変化したら(履歴切替・再分析・サンプル戻し)、
  // ローカルの liveOffsets もそれに同期する。
  useEffect(() => {
    setLiveOffsets(dragOffsetsX);
  }, [dragOffsetsX]);

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const dragStartRef = useRef<{
    clientX: number;
    offsetAtStart: number;
  } | null>(null);
  // ドラッグで動いたか(=click を握り潰すか)
  const dragMovedRef = useRef(false);

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: number) => {
    e.preventDefault();
    dragStartRef.current = {
      clientX: e.clientX,
      offsetAtStart: liveOffsetsRef.current[String(nodeId)] ?? 0,
    };
    dragMovedRef.current = false;
    setDraggingId(nodeId);
  };

  // ドラッグ中の document リスナー登録(draggingId が変わる度に setup / teardown)
  useEffect(() => {
    if (draggingId === null) return;

    // ドラッグ対象の元 X を保持(クランプ計算用)
    const draggedNode = nodes.find((n) => n.id === draggingId);
    const originalX = draggedNode ? draggedNode.position.x : 0;

    const move = (e: MouseEvent) => {
      const start = dragStartRef.current;
      const svg = svgRef.current;
      if (!start || !svg) return;

      const dxPx = e.clientX - start.clientX;
      if (Math.abs(dxPx) > 3) dragMovedRef.current = true;

      // pixel delta → viewBox(SVG)単位 に変換
      const rect = svg.getBoundingClientRect();
      const vbWidth = svg.viewBox.baseVal.width || 800;
      const scale = vbWidth / Math.max(1, rect.width);
      const dxSvg = dxPx * scale;

      // 計算した「ノード新 X」をフロア境界でクランプし、それに合致する offset に変換
      const rawNewX = originalX + start.offsetAtStart + dxSvg;
      const clampedNewX = Math.max(
        DRAG_BOUND_MARGIN,
        Math.min(vbWidth - NODE_WIDTH - DRAG_BOUND_MARGIN, rawNewX),
      );
      const clampedOffset = clampedNewX - originalX;

      setLiveOffsets((prev) => ({
        ...prev,
        [String(draggingId)]: clampedOffset,
      }));
    };

    const up = () => {
      // ドラッグで実際に動いた場合のみ親に通知(=localStorage 保存)
      if (dragMovedRef.current) {
        onDragOffsetsChange?.(liveOffsetsRef.current);
      }
      setDraggingId(null);
      dragStartRef.current = null;
      // dragMovedRef は次の click ハンドラが参照するため、ここではリセットしない。
      // 次の mousedown でリセットされる。
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [draggingId, onDragOffsetsChange]);

  // ドラッグ後の click を握り潰す(Inspector が開かないように)
  const handleNodeClick = (id: number) => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    onNodeClick(id);
  };

  // 階層数 = max depth + 1。データから動的に決める。
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
  const numPlanes = maxDepth + 1;
  const totalHeight =
    numPlanes * PLANE_HEIGHT + (numPlanes - 1) * PLANE_GAP;

  // v0.1.2:フロア幅を可変に。
  //   - 各 depth に何ノード居るかを数えて、最大値を取る
  //   - 1 フロアに「N 個のタイル(140) + N-1 個のギャップ(60) + 左右パディング(40)」が
  //     収まる viewBox 幅を計算
  //   - ベース 800 (4 ノード分) より小さければ 800 を使う
  // SVG は w-full なので、viewBox 幅が広いほどブラウザは縮小して全体を見せる。
  // (将来:極端に広い場合は container 側で overflow-x-auto を入れる選択肢あり)
  const nodeCountByDepth = new Map<number, number>();
  for (const n of nodes) {
    const d = n.depth ?? 0;
    nodeCountByDepth.set(d, (nodeCountByDepth.get(d) ?? 0) + 1);
  }
  const maxNodeCountInOneFloor = Math.max(
    1,
    ...Array.from(nodeCountByDepth.values()),
  );
  const HORIZONTAL_GAP = 60;
  const SIDE_PADDING = 40;
  const widthNeeded =
    SIDE_PADDING * 2 +
    maxNodeCountInOneFloor * NODE_WIDTH +
    Math.max(0, maxNodeCountInOneFloor - 1) * HORIZONTAL_GAP;
  const totalWidth = Math.max(800, widthNeeded);
  const viewBox = `0 0 ${totalWidth} ${totalHeight}`;

  // ノードの y を depth から再計算(AI / サンプル の元 y 値は無視)。
  // x は元値 + ドラッグオフセット(v0.1.2)を加算 + フロア境界でクランプ(v0.1.3)。
  // クランプは描画時にも適用することで、過去に保存された範囲外オフセットも自動補正。
  const minDragX = DRAG_BOUND_MARGIN;
  const maxDragX = totalWidth - NODE_WIDTH - DRAG_BOUND_MARGIN;
  const positionedNodes = nodes.map((n) => {
    const rawX = n.position.x + (liveOffsets[String(n.id)] ?? 0);
    const clampedX = Math.max(minDragX, Math.min(maxDragX, rawX));
    return {
      ...n,
      position: {
        x: clampedX,
        y: nodeYForDepth(n.depth ?? 0),
      },
    };
  });

  // v0.1.2:エッジ起点・終点の分散用メタを事前計算。
  //   - 各ノードの outgoing edges を target.x で昇順ソート → index
  //   - 各ノードの incoming edges を source.x で昇順ソート → index
  // これで「1 つの親から複数子へ fan-out」のとき、各エッジが親の下辺の
  // 別々の x から出発するように Edge.tsx 側で描画できる。
  const nodeXById = new Map(positionedNodes.map((n) => [n.id, n.position.x]));
  const outgoingByNode = new Map<number, ScreenEdge[]>();
  const incomingByNode = new Map<number, ScreenEdge[]>();
  for (const e of edges) {
    if (!outgoingByNode.has(e.from)) outgoingByNode.set(e.from, []);
    outgoingByNode.get(e.from)!.push(e);
    if (!incomingByNode.has(e.to)) incomingByNode.set(e.to, []);
    incomingByNode.get(e.to)!.push(e);
  }
  for (const list of outgoingByNode.values()) {
    list.sort(
      (a, b) => (nodeXById.get(a.to) ?? 0) - (nodeXById.get(b.to) ?? 0),
    );
  }
  for (const list of incomingByNode.values()) {
    list.sort(
      (a, b) => (nodeXById.get(a.from) ?? 0) - (nodeXById.get(b.from) ?? 0),
    );
  }
  const edgeMetaById = new Map<
    string,
    { fromIndex: number; fromTotal: number; toIndex: number; toTotal: number }
  >();
  for (const e of edges) {
    const outList = outgoingByNode.get(e.from) ?? [];
    const inList = incomingByNode.get(e.to) ?? [];
    edgeMetaById.set(e.id, {
      fromIndex: outList.indexOf(e),
      fromTotal: outList.length,
      toIndex: inList.indexOf(e),
      toTotal: inList.length,
    });
  }

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      className="w-full h-auto select-none"
      role="img"
      aria-label={T.canvas.mapAriaLabel}
    >
      <defs>
        {/* 背景ドットパターン */}
        <pattern
          id="dot-grid"
          x="0"
          y="0"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="7" cy="7" r="0.9" fill="#E5E7EB" fillOpacity="0.15" />
        </pattern>

        {/* ノードタイル用 3-stop グラデ:上が明るく、下が深い立体感 */}
        <linearGradient id="node-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2E3F55" />
          <stop offset="0.35" stopColor="#1A2331" />
          <stop offset="1" stopColor="#060A12" />
        </linearGradient>

        {/* 矢印 marker(両端再利用、orient="auto-start-reverse" で逆向き対応) */}
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
          className="fill-electric-teal"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      {/* N 枚のフロア背景(後ろのレイヤー)。
          v0.1.2: viewBox 幅が可変になったので、床も totalWidth に合わせて伸縮。 */}
      {Array.from({ length: numPlanes }).map((_, d) => {
        const planeY = d * (PLANE_HEIGHT + PLANE_GAP);
        const label = planeLabel(d);
        const planeRectWidth = totalWidth - 16;
        return (
          <g key={`plane-${d}`} aria-label={T.canvas.planeAriaLabel(label)}>
            {/* 床本体 */}
            <rect
              x={8}
              y={planeY + 8}
              width={planeRectWidth}
              height={PLANE_HEIGHT - 16}
              rx={14}
              fill={planeBgFill(d)}
              stroke={planeStrokeColor(d)}
              strokeWidth="1"
            />
            {/* ドットグリッド */}
            <rect
              x={8}
              y={planeY + 8}
              width={planeRectWidth}
              height={PLANE_HEIGHT - 16}
              rx={14}
              fill="url(#dot-grid)"
            />
            {/* 上端 Teal アクセント(viewBox 幅に追従) */}
            <line
              x1={28}
              y1={planeY + 10}
              x2={totalWidth - 28}
              y2={planeY + 10}
              className="stroke-electric-teal"
              strokeWidth={1}
              strokeOpacity={Math.max(0.15, 0.6 - d * 0.15)}
            />
            {/* フロアラベル */}
            <text
              x={24}
              y={planeY + 28}
              className="fill-electric-teal select-none pointer-events-none"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.05em"
              opacity="0.72"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* エッジ層:階層を無視して全エッジを直線で繋ぐ。
          cross-depth は edgeMetaById でインデックスを Edge に渡し、起点・終点を分散 */}
      <g aria-label={T.canvas.edgesAriaLabel}>
        {edges.map((edge) => {
          const meta = edgeMetaById.get(edge.id);
          return (
            <Edge
              key={edge.id}
              edge={edge}
              nodes={positionedNodes}
              fromIndex={meta?.fromIndex ?? 0}
              fromTotal={meta?.fromTotal ?? 1}
              toIndex={meta?.toIndex ?? 0}
              toTotal={meta?.toTotal ?? 1}
            />
          );
        })}
      </g>

      {/* ノード層(前面)— noCodeMode を流して userIntent を主表示できるように。
          v0.1.2: onMouseDown でドラッグ開始、onClick は dragMovedRef でフィルタ。 */}
      <g aria-label={T.canvas.nodesAriaLabel}>
        {positionedNodes.map((node) => (
          <NodeTile
            key={node.id}
            node={node}
            selected={node.id === selectedNodeId}
            onClick={handleNodeClick}
            noCodeMode={noCodeMode}
            onMouseDown={handleNodeMouseDown}
            language={language}
          />
        ))}
      </g>
    </svg>
  );
}

export default MapCanvas;
