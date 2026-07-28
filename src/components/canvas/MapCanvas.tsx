import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ScreenNode,
  ScreenEdge,
  LocalizedText,
  Bilingual,
} from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";
import { computeStableColorIndex, paletteAt } from "../../lib/nodeColors";
import { loadAllNotes, type NodeTag } from "../../lib/nodeNotes";

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

// v0.1.7 色統一:分析ごとに AI の id が変わっても同じ意味の要素に同じ色を割当
//   nodeColors.ts の computeStableColorIndex + paletteAt を使用

type MapCanvasProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  selectedNodeId: number | null;
  onNodeClick: (id: number) => void;
  noCodeMode?: boolean;
  language: Language;
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
  /** 詳細モード:各画面の使うデータをさらに外側に「データチップ」として並べる */
  showDataDetails?: boolean;
  /** v0.1.8:メモ・タグの localStorage キーに使うフォルダパス(null = サンプル)*/
  folderPath?: string | null;
  /** v0.1.8:ノートの変更検知カウンタ(App から)。増える度にバッジを読み直す */
  notesTick?: number;
  /** v0.1.8 差分マップ:今回追加された画面 id を緑外枠 + バッジで強調 */
  diffAddedNodeIds?: Set<number>;
  /** v0.1.8 差分マップ:今回追加されたエッジ id を橙点線でハイライト */
  diffAddedEdgeIds?: Set<string>;
  /** v0.1.8:サンプル表示中(未分析)フラグ。true のとき見出し横にバッジ表示 */
  isSample?: boolean;
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 文字数ベースの幅見積もり(JA: 1 文字 ≈ 12px、EN: 1 文字 ≈ 7px)。 */
function estimateTextWidth(text: string, isJa: boolean): number {
  return text.length * (isJa ? 12 : 7) + 32;
}

/** v0.1.8:タグに対応する色。付箋バッジと同色を Inspector と一致させる */
function tagColor(tag: NodeTag | null): string | null {
  if (tag === "important") return "#ef4444";
  if (tag === "later") return "#f59e0b";
  if (tag === "question") return "#6366f1";
  if (tag === "reviewed") return "#14b8a6";
  return null;
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
  appSummary,
  appName,
  tall = false,
  nodeOffsets,
  onNodeOffsetsChange,
  showDataDetails = false,
  folderPath = null,
  notesTick = 0,
  diffAddedNodeIds,
  diffAddedEdgeIds,
  isSample = false,
}: MapCanvasProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  // v0.1.7 色統一:安定インデックスから引くローカル palette 関数
  const stableColorIndex = useMemo(
    () => computeStableColorIndex(nodes, edges, language),
    [nodes, edges, language],
  );
  const paletteFor = (id: number) =>
    paletteAt(stableColorIndex.get(id) ?? 0);
  // v0.1.8:このフォルダの全付箋を Map で持つ(notesTick が上がる度に再読込)
  const nodeNotes = useMemo(
    () => loadAllNotes(folderPath),
    // notesTick を依存に含めて、Inspector で変更がある度に再読込
    [folderPath, notesTick],
  );
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // v0.1.10:マップの操作は「1 回クリックしてアクティブ化」した時のみ有効。
  //   Google Maps 埋め込み方式:ページスクロール中に誤ってマップを拡大縮小する事故を防ぐ。
  //   マップ外(document 上のマップ以外)クリックで再ロック。
  const [mapInteractive, setMapInteractive] = useState(false);
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
    const othersRawUnsorted = entry
      ? nodes.filter((n) => n.id !== entry.id)
      : nodes;
    // v0.1.7 安定化:分析ごとの並び順ゆらぎを吸収するため、決定的にソート。
    //   1st key: 全エッジ数(degree)降順 — 中心的な要素が常に上位に
    //   2nd key: userIntent か label のロケール順 — 同点でも一意
    //   これで同じフォルダを再解析しても要素の配置がほぼ同じに落ち着く。
    const degreeAll = (id: number) =>
      edges.reduce(
        (a, e) => a + (e.from === id ? 1 : 0) + (e.to === id ? 1 : 0),
        0,
      );
    const stableLabel = (n: ScreenNode) => {
      const src = n.userIntent ?? n.label;
      const s = pickLocalized(src, language);
      return s || String(n.id);
    };
    const othersRaw = [...othersRawUnsorted].sort((a, b) => {
      const dd = degreeAll(b.id) - degreeAll(a.id);
      if (dd !== 0) return dd;
      return stableLabel(a).localeCompare(stableLabel(b), "ja");
    });

    // 交差削減:他ノード同士の連結を見て、つながり合うノードが隣接するように並べ替え。
    // entry 経由のエッジは除いて adjacency を作る(entry は中心からの放射エッジのみ)。
    const otherIds = new Set(othersRaw.map((n) => n.id));
    const adjacency = new Map<number, Set<number>>();
    for (const e of edges) {
      if (!otherIds.has(e.from) || !otherIds.has(e.to)) continue;
      adjacency.set(e.from, (adjacency.get(e.from) ?? new Set()).add(e.to));
      adjacency.set(e.to, (adjacency.get(e.to) ?? new Set()).add(e.from));
    }
    const degree = (id: number) => adjacency.get(id)?.size ?? 0;
    // 初期順序:連結度が高い順に greedy(以前と同じ)
    const initialOrder: ScreenNode[] = [];
    const visited = new Set<number>();
    if (othersRaw.length > 0) {
      const start = [...othersRaw].sort((a, b) => degree(b.id) - degree(a.id))[0];
      initialOrder.push(start);
      visited.add(start.id);
      while (initialOrder.length < othersRaw.length) {
        const last = initialOrder[initialOrder.length - 1];
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
        initialOrder.push(next);
        visited.add(next.id);
      }
    }
    // 2-opt スワップで交差数を最小化
    //   環上でエッジ (a,b) と (c,d) が交差 ⇔ endpoints が交互に並ぶ
    const countCrossings = (order: ScreenNode[]): number => {
      const pos = new Map<number, number>();
      order.forEach((n, i) => pos.set(n.id, i));
      const chords: Array<[number, number]> = [];
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (a === undefined || b === undefined) continue;
        chords.push([Math.min(a, b), Math.max(a, b)]);
      }
      let c = 0;
      for (let i = 0; i < chords.length; i++) {
        for (let j = i + 1; j < chords.length; j++) {
          const [a, b] = chords[i];
          const [x, y] = chords[j];
          // 標準的な circular chord crossing テスト
          if ((a < x && x < b && b < y) || (x < a && a < y && y < b)) c++;
        }
      }
      return c;
    };
    const optimized = [...initialOrder];
    let bestCrossings = countCrossings(optimized);
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 20) {
      improved = false;
      for (let i = 0; i < optimized.length - 1; i++) {
        for (let j = i + 1; j < optimized.length; j++) {
          [optimized[i], optimized[j]] = [optimized[j], optimized[i]];
          const c = countCrossings(optimized);
          if (c < bestCrossings) {
            bestCrossings = c;
            improved = true;
          } else {
            [optimized[i], optimized[j]] = [optimized[j], optimized[i]];
          }
        }
      }
    }
    const others = optimized;
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
        // 詳細モードで `> ` プレフィックスを付けるので追加幅を確保
        const w = estimateTextWidth(label, isJa) + (showDataDetails ? 14 : 0);
        const offset = k - (K - 1) / 2;
        const leafY = by + offset * LEAF_SPACING_Y;
        const leafX = baseColumnX + sign * Math.abs(offset) * LEAF_FAN_X;
        return { x: leafX, y: leafY, w, label };
      });
      leafPositions.set(node.id, leaves);
    });

    // 詳細モード追加:各画面の使うデータをさらに外側に「データチップ」として並べる。
    // subActions 葉のさらに外に、cylinder スタイルの矩形チップで配置する。
    const dataPositions = new Map<
      number,
      Array<{
        x: number;
        y: number;
        w: number;
        h: number;
        name: string;
        subtitle: string; // 該当 index の dataUsed(人間可読)
        fields: string[];
      }>
    >();
    if (showDataDetails) {
      const DATA_EXTRA_GAP_MIN = 60; // 葉と重ならない余白の最小
      others.forEach((node) => {
        const bpos = branchPositions.get(node.id);
        if (!bpos) return;
        const isRight = Math.cos(bpos.angle) >= 0;
        const sign = isRight ? 1 : -1;
        // この画面の葉の最大幅を測る(fan-out 位置も加味)
        const nodeLeaves = leafPositions.get(node.id) ?? [];
        const maxLeafHalf = nodeLeaves.reduce(
          (m, l) => Math.max(m, l.w / 2),
          0,
        );
        // 葉が最外側までせり出すぶん fan-x を加算
        const maxLeafFanOffset =
          nodeLeaves.length > 1
            ? ((nodeLeaves.length - 1) / 2) * LEAF_FAN_X
            : 0;
        // データチップ列の x = 葉の外側端 + マージン
        const baseColumnX =
          bpos.x +
          sign *
            (BRANCH_W / 2 +
              LEAF_GAP_X +
              maxLeafHalf +
              maxLeafFanOffset +
              DATA_EXTRA_GAP_MIN);
        // 対応 index の dataUsed(人間可読名)を副題として引くヘルパー
        const humanAt = (i: number): string => {
          const arr = node.detail.dataUsed ?? [];
          if (i < arr.length) return pickLocalized(arr[i], language);
          return "";
        };
        // dataTech を優先(オブジェクト形式 { name, fields } を正規化)
        const techSource: Array<{
          name: string;
          subtitle: string;
          fields: string[];
        }> =
          node.detail.dataTech && node.detail.dataTech.length > 0
            ? node.detail.dataTech.map((t, i) => {
                const base =
                  typeof t === "string"
                    ? { name: t, fields: [] as string[] }
                    : { name: t.name, fields: t.fields ?? [] };
                return { ...base, subtitle: humanAt(i) };
              })
            : (node.detail.dataUsed ?? []).map((d) => ({
                name: pickLocalized(d, language),
                subtitle: "",
                fields: [],
              }));
        const dataSource = techSource.slice(0, leafCap);
        const estimateMono = (t: string) => t.length * 7.2;
        const K = dataSource.length;

        // 各エンティティボックスの高さを (ヘッダー 24 + [subtitle 14] + fields * 16 + パディング) で算出、
        // その総和で縦位置を計算(単一の LEAF_SPACING_Y ではなく可変ギャップ)
        const boxHeights = dataSource.map((d) => {
          const shownFieldsN = Math.max(0, Math.min(6, d.fields.length));
          const subtitleH = d.subtitle ? 14 : 0;
          // fields も subtitle も無いなら「詳細未取得」プレースホルダ用に 14px 確保
          const emptyHintH = shownFieldsN === 0 && !d.subtitle ? 14 : 0;
          return 24 + subtitleH + shownFieldsN * 16 + emptyHintH + 8;
        });
        const boxGap = 14;
        const totalH = boxHeights.reduce((a, b) => a + b + boxGap, 0) - boxGap;
        let cursorY = bpos.y - totalH / 2;

        const chips = dataSource.map((d) => {
          const shownFields = d.fields.slice(0, 6);
          const nameW = estimateMono(d.name);
          const subtitleW = d.subtitle
            ? d.subtitle.length * (language === "ja" ? 11 : 6.5)
            : 0;
          const fieldMaxW = shownFields.reduce(
            (m, f) => Math.max(m, estimateMono(f)),
            0,
          );
          const w = Math.max(nameW, subtitleW, fieldMaxW) + 52;
          const subtitleRowH = d.subtitle ? 14 : 0;
          const emptyHintRowH =
            shownFields.length === 0 && !d.subtitle ? 14 : 0;
          const h =
            24 + subtitleRowH + shownFields.length * 16 + emptyHintRowH + 8;
          const y = cursorY + h / 2;
          // チップの内側端(葉側の端)が baseColumnX に来るように x = baseColumnX + sign * w/2
          const x = baseColumnX + sign * (w / 2);
          cursorY += h + boxGap;
          return {
            x,
            y,
            w,
            h,
            name: d.name,
            subtitle: d.subtitle,
            fields: shownFields,
          };
        });
        void K;
        dataPositions.set(node.id, chips);
      });
    }

    return {
      width: W,
      height: H,
      cx,
      cy,
      branchPositions,
      leafPositions,
      dataPositions,
    };
  }, [nodes, language, showDataDetails]);

  const { width: W, height: H, cx, cy, branchPositions, leafPositions, dataPositions } =
    layout;

  // ズーム + パン適用後の viewBox
  const vbW = W / zoom;
  const vbH = H / zoom;
  const vbX = (W - vbW) / 2 - pan.x;
  const vbY = (H - vbH) / 2 - pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // マウスホイールでズーム(passive: false で preventDefault)。
  // v0.1.10:mapInteractive === false の時はページスクロールを妨げないよう preventDefault
  //   せず、そのままバブリング → ページがスクロールされる(埋め込みマップ方式)。
  useEffect(() => {
    const el = svgWrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!mapInteractive) return; // ページスクロールに任せる
      e.preventDefault();
      const delta = -e.deltaY * 0.0018;
      setZoom((z) => clamp(z * (1 + delta), ZOOM_MIN, ZOOM_MAX));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [mapInteractive]);

  // v0.1.10:マップ外クリックで非アクティブ化(document 全体で監視)
  useEffect(() => {
    if (!mapInteractive) return;
    const el = svgWrapRef.current;
    if (!el) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (el.contains(e.target as Node)) return;
      setMapInteractive(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [mapInteractive]);

  // ドラッグでパン。
  // v0.1.10:非アクティブ状態の 1 回目のクリックは「アクティブ化のみ」で消費し、
  //   マップは動かさない(ユーザーがまず「触るぞ」と意思表示するステップ)。
  //   ノードクリックはこれとは別で常に動作する(node 要素側の handler)。
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!mapInteractive) {
      setMapInteractive(true);
      // ドラッグ開始情報は残さない(アクティブ化クリックだけで終わる)
      return;
    }
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
    // v0.1.10:ツアーのハイライト対象。「アプリの全体像」カードだけを囲みたいので
    //   ここに data-tour を付ける(以前は App.tsx 側のより大きな wrapper に付いていて、
    //   マップ以外の下部セクションまで一緒に光ってしまう不具合があった)。
    <div
      className="bg-paper rounded-[16px] border border-border-soft p-5"
      data-tour="map-canvas"
    >
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-base font-bold text-ink-strong">
            {language === "ja" ? "アプリの全体像" : "App overview"}
          </h2>
          <span className="text-sm text-ink-soft">
            {language === "ja" ? "(マインドマップ)" : "(mind map)"}
          </span>
          {/* v0.1.8:サンプル表示中は amber バッジで一目で分かるようにする */}
          {isSample && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border"
              style={{
                background: "rgba(212, 163, 115, 0.14)",
                color: "#8a5a2b",
                borderColor: "rgba(212, 163, 115, 0.55)",
              }}
              title={
                language === "ja"
                  ? "サンプルマップを表示中。フォルダを選ぶと実際のアプリを分析します。"
                  : "Showing the sample map. Pick a folder to analyze your app."
              }
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#c98a3d",
                }}
              />
              {language === "ja" ? "サンプル" : "Sample"}
            </span>
          )}
          {/* 常時表示の操作ヒント:Inspector / ズーム / ドラッグの存在を案内 */}
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-feature-teal-soft text-feature-teal border border-feature-teal/30">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="w-3 h-3 flex-shrink-0"
            >
              <path d="M12 3 V12" />
              <path d="M12 12 L14 20 L15.5 15 L20 14 Z" />
            </svg>
            {language === "ja" ? (
              <>
                ノードクリックで詳細 <span className="opacity-60">/</span>{" "}
                マップを 1 回クリックで操作有効化{" "}
                <span className="opacity-60">→</span> ホイールで拡大縮小{" "}
                <span className="opacity-60">/</span> ドラッグで移動{" "}
                <span className="opacity-60">/</span> マップ外クリックで固定
              </>
            ) : (
              <>
                Click a node for detail <span className="opacity-60">/</span>{" "}
                click the map once to activate{" "}
                <span className="opacity-60">→</span> wheel to zoom{" "}
                <span className="opacity-60">/</span> drag to move{" "}
                <span className="opacity-60">/</span> click outside to lock
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* v0.1.8 削除:重要のみ / 全画面トグルは Settings の Detail level と重複していた。
              かつ 中間ノードだけ非表示にすると枝間の関係が読めなくなり誤解を招いた。
              詳細レベル制御は Settings 側に一本化(§3.2 段階的開示の原則を尊重)。*/}
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

      {/* SVG マップ
          v0.1.10:mapInteractive === false の時はクリック待ちの視覚を出す
          (border 色 + カーソル pointer)。アクティブ化後は通常の grab カーソル。 */}
      <div
        ref={svgWrapRef}
        className={`bg-canvas-soft rounded-[12px] relative overflow-hidden touch-none border-2 transition-colors ${
          mapInteractive
            ? "border-feature-teal/40"
            : "border-transparent cursor-pointer"
        }`}
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
              // v0.1.8 差分マップ:新規追加エッジは橙色で強調
              const isDiffAdded = diffAddedEdgeIds?.has(edge.id) ?? false;
              return (
                <path
                  key={edge.id}
                  d={`M ${fromB.x} ${fromB.y} Q ${pullX} ${pullY} ${toB.x} ${toB.y}`}
                  fill="none"
                  stroke={isDiffAdded ? "#f97316" : fromP.accent}
                  strokeOpacity={isDiffAdded ? 0.9 : emphasis ? 0.8 : 0.32}
                  strokeWidth={isDiffAdded ? 2.4 : emphasis ? 2.2 : 1.4}
                  strokeDasharray={isDiffAdded ? "5 3" : undefined}
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
                      fontSize={showDataDetails ? 10.5 : 11.5}
                      fontWeight="600"
                      style={
                        showDataDetails
                          ? {
                              fontFamily:
                                "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
                            }
                          : undefined
                      }
                    >
                      {showDataDetails ? `> ${leaf.label}` : leaf.label}
                    </text>
                  </g>
                );
              });
            })}
          </g>

          {/* === 4b. 詳細モード追加:葉 → データチップの線 + データチップ本体 === */}
          {showDataDetails && (
            <>
              <g aria-label={language === "ja" ? "データつながり" : "data links"}>
                {nodes.map((node) => {
                  const b = branchPositions.get(node.id);
                  const chips = dataPositions.get(node.id);
                  if (!b || !chips) return null;
                  const off = offsetFor(node.id);
                  const bx = b.x + off.x;
                  const by = b.y + off.y;
                  const p = paletteFor(node.id);
                  const isRight = bx >= cx;
                  const sign = isRight ? 1 : -1;
                  const startX = bx + sign * (BRANCH_W / 2 - 4);
                  const startY = by;
                  return chips.map((chip, i) => {
                    const cx0 = chip.x + off.x;
                    const cy0 = chip.y + off.y;
                    const endX = cx0 - sign * (chip.w / 2);
                    const endY = cy0;
                    const midX = (startX + endX) / 2;
                    return (
                      <path
                        key={`dlink-${node.id}-${i}`}
                        d={`M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}`}
                        fill="none"
                        stroke={p.accent}
                        strokeOpacity={0.35}
                        strokeWidth={1.2}
                        strokeDasharray="2 4"
                        strokeLinecap="round"
                      />
                    );
                  });
                })}
              </g>
              <g aria-label={language === "ja" ? "使うデータ" : "data used"}>
                {nodes.map((node) => {
                  const chips = dataPositions.get(node.id);
                  if (!chips) return null;
                  const off = offsetFor(node.id);
                  const p = paletteFor(node.id);
                  return chips.map((chip, i) => {
                    const cx0 = chip.x + off.x;
                    const cy0 = chip.y + off.y;
                    const boxX = cx0 - chip.w / 2;
                    const boxY = cy0 - chip.h / 2;
                    return (
                      <g
                        key={`dchip-${node.id}-${i}`}
                        onClick={() => handleNodeClickSafe(node.id)}
                        className="cursor-pointer"
                      >
                        {/* テーブル本体 */}
                        <rect
                          x={boxX}
                          y={boxY}
                          width={chip.w}
                          height={chip.h}
                          rx={6}
                          fill="#FFFFFF"
                          stroke={p.border}
                          strokeWidth={1.2}
                          strokeDasharray="4 3"
                        />
                        {/* ヘッダー背景 */}
                        <rect
                          x={boxX}
                          y={boxY}
                          width={chip.w}
                          height={24}
                          rx={6}
                          fill={p.soft}
                          stroke="none"
                        />
                        {/* ヘッダー下のライン */}
                        <line
                          x1={boxX}
                          y1={boxY + 24}
                          x2={boxX + chip.w}
                          y2={boxY + 24}
                          stroke={p.border}
                          strokeWidth={1}
                        />
                        {/* cylinder(データ)アイコン */}
                        <g
                          transform={`translate(${boxX + 8}, ${boxY + 6})`}
                          stroke={p.text}
                          strokeWidth="1.3"
                          fill="none"
                          strokeLinecap="round"
                        >
                          <ellipse cx="5" cy="2" rx="4" ry="1.3" />
                          <path d="M1 2 V7 A4 1.3 0 0 0 9 7 V2" />
                          <path d="M1 5 A4 1.3 0 0 0 9 5" />
                        </g>
                        {/* エンティティ名 */}
                        <text
                          x={boxX + 24}
                          y={boxY + 15}
                          fill={p.text}
                          fontSize="11.5"
                          fontWeight="700"
                          dominantBaseline="middle"
                          style={{
                            fontFamily:
                              "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
                          }}
                        >
                          {chip.name}
                        </text>
                        {/* サブタイトル(人間可読な意味)*/}
                        {chip.subtitle && (
                          <text
                            x={boxX + 12}
                            y={boxY + 24 + 8}
                            fill="#94A3B8"
                            fontSize="10"
                            fontStyle="italic"
                            dominantBaseline="middle"
                          >
                            {chip.subtitle}
                          </text>
                        )}
                        {/* フィールド行(subtitle があれば下にオフセット)*/}
                        {chip.fields.map((f, j) => {
                          const yOffset = chip.subtitle ? 14 : 0;
                          return (
                            <text
                              key={`f-${j}`}
                              x={boxX + 12}
                              y={boxY + 24 + 12 + yOffset + j * 16}
                              fill="#475569"
                              fontSize="10.5"
                              dominantBaseline="middle"
                              style={{
                                fontFamily:
                                  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
                              }}
                            >
                              {f}
                            </text>
                          );
                        })}
                        {/* fields が無い時は「詳細未取得」プレースホルダ */}
                        {chip.fields.length === 0 && !chip.subtitle && (
                          <text
                            x={boxX + 12}
                            y={boxY + 24 + 10}
                            fill="#CBD5E1"
                            fontSize="9"
                            fontStyle="italic"
                            dominantBaseline="middle"
                          >
                            {language === "ja"
                              ? "フィールド情報なし(再分析で取得)"
                              : "no fields (re-analyze)"}
                          </text>
                        )}
                      </g>
                    );
                  });
                })}
              </g>
            </>
          )}

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
              // 詳細モード = 技術者向け:label(短い画面名)を優先、
              // サブタイトルは主要ファイルのベース名。かんたんモードは従来通り userIntent。
              const labelSource = showDataDetails
                ? node.label
                : noCodeMode && node.userIntent
                  ? node.userIntent
                  : node.userIntent ?? node.label;
              const title = pickLocalized(labelSource, language);
              const primaryFile = node.detail.files?.[0];
              const primaryFileBase = primaryFile
                ? primaryFile.split(/[\\/]/).pop() ?? primaryFile
                : null;
              const subtitle =
                showDataDetails && primaryFileBase
                  ? primaryFileBase
                  : pickLocalized(node.detail.title, language);
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
                    stroke={
                      diffAddedNodeIds?.has(node.id)
                        ? "#10b981" // 差分:新規追加は緑外枠で強調
                        : isActive
                          ? p.accent
                          : p.border
                    }
                    strokeWidth={
                      diffAddedNodeIds?.has(node.id) ? 3 : isActive ? 2.5 : 2
                    }
                  />
                  {/* v0.1.8 差分マップ:新規追加ノードに「+ 新規」バッジ */}
                  {diffAddedNodeIds?.has(node.id) && (
                    <g pointerEvents="none">
                      <rect
                        x={b.x - 22}
                        y={y + BRANCH_H - 6}
                        width={44}
                        height={14}
                        rx={7}
                        fill="#10b981"
                      />
                      <text
                        x={b.x}
                        y={y + BRANCH_H + 1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="white"
                        fontSize="9"
                        fontWeight="700"
                      >
                        {language === "ja" ? "+ 新規" : "+ NEW"}
                      </text>
                    </g>
                  )}
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
                  {/* サブタイトル(画面 title / 詳細モードでは主要ファイル名を monospace で)*/}
                  <text
                    x={b.x}
                    y={b.y + 13}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#64748b"
                    fontSize={showDataDetails ? 10 : 10.5}
                    style={
                      showDataDetails
                        ? {
                            fontFamily:
                              "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
                          }
                        : undefined
                    }
                  >
                    {truncate(subtitle, showDataDetails ? 20 : 16)}
                  </text>
                  {/* エントリーポイントバッジ:小さい三角 + テキスト */}
                  {node.isEntryPoint && (
                    <g pointerEvents="none">
                      <rect
                        x={b.x - 40}
                        y={y - 18}
                        width={80}
                        height={16}
                        rx={8}
                        fill={p.accent}
                      />
                      <path
                        d={`M ${b.x - 28} ${y - 13} L ${b.x - 22} ${y - 10} L ${b.x - 28} ${y - 7} Z`}
                        fill="white"
                      />
                      <text
                        x={b.x + 3}
                        y={y - 9}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="white"
                        fontSize="9"
                        fontWeight="700"
                      >
                        {language === "ja" ? "はじまり" : "START"}
                      </text>
                    </g>
                  )}
                  {/* v0.1.8:付箋バッジ(タグ or メモがある場合、ノード右上に色付きドット)*/}
                  {(() => {
                    const note = nodeNotes.get(node.id);
                    if (!note) return null;
                    const hasContent = note.tag !== null || note.memo.length > 0;
                    if (!hasContent) return null;
                    // タグ色優先、無ければ「メモあり」用のグレー
                    const color = tagColor(note.tag) ?? "#94a3b8";
                    const bx = b.x + BRANCH_W / 2 - 4;
                    const by = y + 2;
                    return (
                      <g pointerEvents="none">
                        <circle cx={bx} cy={by} r={7.5} fill="white" />
                        <circle cx={bx} cy={by} r={6} fill={color} />
                        {note.memo.length > 0 && (
                          <text
                            x={bx}
                            y={by + 0.6}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill="white"
                            fontSize="7.5"
                            fontWeight="800"
                          >
                            !
                          </text>
                        )}
                      </g>
                    );
                  })()}
                </g>
              );
            })}
          </g>

          {/* v0.1.7 改修:中心ノード(AppMap ラベル)は撤去
              ─ 分析対象アプリの構成と誤解されるため。
              枝同士の関連線は残し、主枝 + 葉のみで表現する。 */}
        </svg>

        {/* v0.1.10:非アクティブ時のオーバーレイヒント。
            マップ全体をカバーする透明レイヤーで pointer 通過を許容。
            右下に「クリックで操作」小バッジを浮かせる。 */}
        {!mapInteractive && (
          <div
            className="absolute inset-0 flex items-end justify-end pointer-events-none"
            aria-hidden="true"
          >
            <div
              className="m-3 px-3 py-1.5 rounded-full text-[11px] font-semibold shadow-sm border"
              style={{
                background: "rgba(20,184,166,0.14)",
                color: "#0d9488",
                borderColor: "rgba(20,184,166,0.4)",
                backdropFilter: "blur(2px)",
              }}
            >
              {language === "ja"
                ? "クリックして操作を有効化"
                : "Click to enable interaction"}
            </div>
          </div>
        )}
      </div>

      {/* 凡例 */}
      <Legend nodes={nodes} language={language} paletteFor={paletteFor} />
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
  paletteFor: (id: number) => ReturnType<typeof paletteAt>;
};
function Legend({ nodes, language, paletteFor }: LegendProps) {
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
            <span
              key={node.id}
              className="flex items-center gap-1 whitespace-nowrap"
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: p.accent }}
              />
              {labelStr}
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

export default MapCanvas;
