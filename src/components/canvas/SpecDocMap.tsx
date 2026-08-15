import type {
  ScreenNode,
  ScreenEdge,
  LocalizedText,
} from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";
import { computeStableColorIndex, paletteAt } from "../../lib/nodeColors";
import {
  orderRingNodes,
  ringBasePosition,
  buildEdgeSeparation,
  ringEdgePath,
} from "../../lib/mapLayout";

/**
 * v0.1.7 仕様書 PDF 用の静的マインドマップ SVG。
 *
 * MapCanvas のレイアウト計算と同じ式を使うが、interactivity(zoom/pan/drag)は
 * 全部削ぎ落とす。コンポーネントは pure に状態を持たないので、印刷時にも安定する。
 *
 * 中心ノードは持たない(MapCanvas と同じく撤去済み)。主枝 + 葉 + 関連エッジを描く。
 *
 * v0.1.7 追記:showDataDetails=true のとき MapCanvas と同じ「詳細モード」を再現。
 *   - 主枝の label は短い画面名 + 主要ファイル名(monospace)
 *   - 葉に `> ` プレフィックス + monospace
 *   - 葉のさらに外に dataTech スキーマチップ(エンティティ名 + 副題 + フィールド行)
 */
type SpecDocMapProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  language: Language;
  /** ユーザーが MapCanvas で動かした位置の差分(SVG 座標)*/
  nodeOffsets?: Map<number, { x: number; y: number }>;
  /** 詳細モード:DB スキーマチップを追加描画 */
  showDataDetails?: boolean;
};

const BRANCH_W = 172;
const BRANCH_H = 70;
const LEAF_H = 28;
const LEAF_GAP_X = 90;
const LEAF_SPACING_Y = 38;
const LEAF_FAN_X = 14;

// v0.1.7:色統一のため nodeColors.paletteAt(stableIndex) を使用

function estimateTextWidth(text: string, isJa: boolean): number {
  return text.length * (isJa ? 12 : 7) + 32;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function SpecDocMap({
  nodes,
  edges,
  language,
  nodeOffsets,
  showDataDetails = false,
}: SpecDocMapProps) {
  if (nodes.length === 0) return null;
  const offsetFor = (id: number) =>
    nodeOffsets?.get(id) ?? { x: 0, y: 0 };
  // v0.1.7 色統一
  const stableColorIndex = computeStableColorIndex(nodes, edges, language);
  const paletteFor = (id: number) =>
    paletteAt(stableColorIndex.get(id) ?? 0);

  const N = nodes.length;
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
  // エッジ描画用:スロット index と、同回廊の平行エッジを扇状に分ける index/count。
  const slotIndex = new Map<number, number>();
  others.forEach((n, i) => slotIndex.set(n.id, i));
  const edgeSep = buildEdgeSeparation(edges, (id) => slotIndex.get(id));
  // ノードが多いほど葉チップを減らして密度を抑える(大規模時の保険。MapCanvas と統一)。
  const leafCap = N >= 14 ? 3 : N >= 10 ? 4 : N >= 7 ? 5 : 7;
  const R_branch = M > 0 ? Math.max(220, 110 + M * 36) : 0;
  const leafOuterReach = BRANCH_W / 2 + LEAF_GAP_X + 200;
  // 詳細モードはデータチップ分を余計に確保
  const detailExtraReach = showDataDetails ? 320 : 0;
  const reach = R_branch + leafOuterReach + detailExtraReach;
  const W = Math.max(1100, reach * 2 + 120);
  const heightForLeaves = leafCap * LEAF_SPACING_Y + 80;
  const H = Math.max(620, reach * 2 + heightForLeaves * 0.4);
  const cx = W / 2;
  const cy = H / 2;

  type BranchPos = { x: number; y: number; angle: number };
  type LeafPos = { x: number; y: number; w: number; label: string };
  type DataChip = {
    x: number;
    y: number;
    w: number;
    h: number;
    name: string;
    subtitle: string;
    fields: string[];
  };
  const branchPositions = new Map<number, BranchPos>();
  const leafPositions = new Map<number, LeafPos[]>();
  const dataPositions = new Map<number, DataChip[]>();

  // 中心にエントリーポイント(葉なし)
  if (entry) {
    const off = offsetFor(entry.id);
    branchPositions.set(entry.id, { x: cx + off.x, y: cy + off.y, angle: 0 });
    leafPositions.set(entry.id, []);
  }

  // 周囲のノードを放射状に
  others.forEach((node, i) => {
    const base = ringBasePosition(cx, cy, R_branch, i, M);
    const angleRad = base.angle;
    const off = offsetFor(node.id);
    const bx = base.x + off.x;
    const by = base.y + off.y;
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
      // 詳細モードで `> ` プレフィックスを付けるので追加幅を確保(MapCanvas と同じ)
      const w = estimateTextWidth(label, isJa) + (showDataDetails ? 14 : 0);
      const offset = k - (K - 1) / 2;
      const leafY = by + offset * LEAF_SPACING_Y;
      const leafX = baseColumnX + sign * Math.abs(offset) * LEAF_FAN_X;
      return { x: leafX, y: leafY, w, label };
    });
    leafPositions.set(node.id, leaves);
  });

  // 詳細モード:各画面の使うデータをさらに外側に「データチップ」として並べる(MapCanvas と同ロジック)
  if (showDataDetails) {
    const DATA_EXTRA_GAP_MIN = 60;
    others.forEach((node) => {
      const bpos = branchPositions.get(node.id);
      if (!bpos) return;
      const isRight = Math.cos(bpos.angle) >= 0;
      const sign = isRight ? 1 : -1;
      const nodeLeaves = leafPositions.get(node.id) ?? [];
      const maxLeafHalf = nodeLeaves.reduce(
        (m, l) => Math.max(m, l.w / 2),
        0,
      );
      const maxLeafFanOffset =
        nodeLeaves.length > 1
          ? ((nodeLeaves.length - 1) / 2) * LEAF_FAN_X
          : 0;
      const baseColumnX =
        bpos.x +
        sign *
          (BRANCH_W / 2 +
            LEAF_GAP_X +
            maxLeafHalf +
            maxLeafFanOffset +
            DATA_EXTRA_GAP_MIN);
      const humanAt = (i: number): string => {
        const arr = node.detail.dataUsed ?? [];
        if (i < arr.length) return pickLocalized(arr[i], language);
        return "";
      };
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

      const boxHeights = dataSource.map((d) => {
        const shownFieldsN = Math.max(0, Math.min(6, d.fields.length));
        const subtitleH = d.subtitle ? 14 : 0;
        const emptyHintH = shownFieldsN === 0 && !d.subtitle ? 14 : 0;
        return 24 + subtitleH + shownFieldsN * 16 + emptyHintH + 8;
      });
      const boxGap = 14;
      const totalH = boxHeights.reduce((a, b) => a + b + boxGap, 0) - boxGap;
      let cursorY = bpos.y - totalH / 2;

      const chips: DataChip[] = dataSource.map((d) => {
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
      dataPositions.set(node.id, chips);
    });
  }

  // ユーザーがノードを動かした分も含めて viewBox を再計算(全要素を内包するよう拡張)
  let minX = 0,
    minY = 0,
    maxX = W,
    maxY = H;
  branchPositions.forEach((b) => {
    minX = Math.min(minX, b.x - BRANCH_W / 2 - 20);
    minY = Math.min(minY, b.y - BRANCH_H / 2 - 40);
    maxX = Math.max(maxX, b.x + BRANCH_W / 2 + 20);
    maxY = Math.max(maxY, b.y + BRANCH_H / 2 + 20);
  });
  leafPositions.forEach((leaves) => {
    leaves.forEach((leaf) => {
      minX = Math.min(minX, leaf.x - leaf.w / 2 - 10);
      minY = Math.min(minY, leaf.y - LEAF_H / 2 - 10);
      maxX = Math.max(maxX, leaf.x + leaf.w / 2 + 10);
      maxY = Math.max(maxY, leaf.y + LEAF_H / 2 + 10);
    });
  });
  dataPositions.forEach((chips) => {
    chips.forEach((chip) => {
      minX = Math.min(minX, chip.x - chip.w / 2 - 10);
      minY = Math.min(minY, chip.y - chip.h / 2 - 10);
      maxX = Math.max(maxX, chip.x + chip.w / 2 + 10);
      maxY = Math.max(maxY, chip.y + chip.h / 2 + 10);
    });
  });
  const vbX = minX;
  const vbY = minY;
  const vbW = maxX - minX;
  const vbH = maxY - minY;

  const monoStyle = {
    fontFamily:
      "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
  };

  return (
    <div className="spec-doc-map">
      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}
        aria-label={language === "ja" ? "アプリ構造マインドマップ" : "App mind map"}
      >
        {/* 関連エッジ(実線、控えめ)*/}
        <g>
          {edges.map((edge) => {
            const fromB = branchPositions.get(edge.from);
            const toB = branchPositions.get(edge.to);
            if (!fromB || !toB) return null;
            const fromP = paletteFor(edge.from);
            const sepInfo = edgeSep.get(edge.id) ?? { index: 0, count: 1 };
            const edgeD = ringEdgePath({
              from: fromB,
              to: toB,
              mapCenter: { x: cx, y: cy },
              R: R_branch,
              halfW: BRANCH_W / 2,
              halfH: BRANCH_H / 2,
              isEntryFrom: entry ? edge.from === entry.id : false,
              isEntryTo: entry ? edge.to === entry.id : false,
              index: sepInfo.index,
              count: sepInfo.count,
            });
            return (
              <path
                key={edge.id}
                d={edgeD}
                fill="none"
                stroke={fromP.accent}
                strokeOpacity={0.35}
                strokeWidth={1.4}
                strokeLinecap="round"
              />
            );
          })}
        </g>

        {/* 主枝 → 葉(色付きライン)*/}
        <g>
          {nodes.map((node) => {
            const b = branchPositions.get(node.id);
            const leaves = leafPositions.get(node.id);
            if (!b || !leaves) return null;
            const p = paletteFor(node.id);
            const isRight = b.x >= cx;
            const sign = isRight ? 1 : -1;
            const branchEdgeX = b.x + sign * (BRANCH_W / 2 - 4);
            const branchEdgeY = b.y;
            return leaves.map((leaf, i) => {
              const leafEdgeX = leaf.x - sign * (leaf.w / 2);
              const leafEdgeY = leaf.y;
              const midX = (branchEdgeX + leafEdgeX) / 2;
              const midY = (branchEdgeY + leafEdgeY) / 2;
              return (
                <path
                  key={`leaf-${node.id}-${i}`}
                  d={`M ${branchEdgeX} ${branchEdgeY} Q ${midX} ${midY} ${leafEdgeX} ${leafEdgeY}`}
                  fill="none"
                  stroke={p.accent}
                  strokeOpacity={0.5}
                  strokeWidth={1.3}
                  strokeDasharray="3 4"
                  strokeLinecap="round"
                />
              );
            });
          })}
        </g>

        {/* 葉チップ */}
        <g>
          {nodes.map((node) => {
            const leaves = leafPositions.get(node.id);
            if (!leaves) return null;
            const p = paletteFor(node.id);
            return leaves.map((leaf, i) => (
              <g key={`chip-${node.id}-${i}`}>
                <rect
                  x={leaf.x - leaf.w / 2}
                  y={leaf.y - LEAF_H / 2}
                  width={leaf.w}
                  height={LEAF_H}
                  rx={LEAF_H / 2}
                  fill={p.soft}
                  stroke={p.border}
                  strokeWidth={1}
                />
                <text
                  x={leaf.x}
                  y={leaf.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={p.text}
                  fontSize={showDataDetails ? 10.5 : 11.5}
                  fontWeight="600"
                  style={showDataDetails ? monoStyle : undefined}
                >
                  {showDataDetails ? `> ${leaf.label}` : leaf.label}
                </text>
              </g>
            ));
          })}
        </g>

        {/* 詳細モード:葉 → データチップの線 + データチップ本体 */}
        {showDataDetails && (
          <>
            <g aria-label={language === "ja" ? "データつながり" : "data links"}>
              {nodes.map((node) => {
                const b = branchPositions.get(node.id);
                const chips = dataPositions.get(node.id);
                if (!b || !chips) return null;
                const p = paletteFor(node.id);
                const isRight = b.x >= cx;
                const sign = isRight ? 1 : -1;
                const startX = b.x + sign * (BRANCH_W / 2 - 4);
                const startY = b.y;
                return chips.map((chip, i) => {
                  const endX = chip.x - sign * (chip.w / 2);
                  const endY = chip.y;
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
                const p = paletteFor(node.id);
                return chips.map((chip, i) => {
                  const boxX = chip.x - chip.w / 2;
                  const boxY = chip.y - chip.h / 2;
                  return (
                    <g key={`dchip-${node.id}-${i}`}>
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
                      <rect
                        x={boxX}
                        y={boxY}
                        width={chip.w}
                        height={24}
                        rx={6}
                        fill={p.soft}
                        stroke="none"
                      />
                      <line
                        x1={boxX}
                        y1={boxY + 24}
                        x2={boxX + chip.w}
                        y2={boxY + 24}
                        stroke={p.border}
                        strokeWidth={1}
                      />
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
                      <text
                        x={boxX + 24}
                        y={boxY + 15}
                        fill={p.text}
                        fontSize="11.5"
                        fontWeight="700"
                        dominantBaseline="middle"
                        style={monoStyle}
                      >
                        {chip.name}
                      </text>
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
                            style={monoStyle}
                          >
                            {f}
                          </text>
                        );
                      })}
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

        {/* 主枝ピル */}
        <g>
          {nodes.map((node) => {
            const b = branchPositions.get(node.id);
            if (!b) return null;
            const p = paletteFor(node.id);
            // 詳細モードでは短い画面名 + 主要ファイル名を使う(MapCanvas と同じ表記)
            const labelSource = showDataDetails
              ? node.label
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
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width={BRANCH_W}
                  height={BRANCH_H}
                  rx={BRANCH_H / 2}
                  fill={p.soft}
                  stroke={p.border}
                  strokeWidth={2}
                />
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
                <text
                  x={b.x}
                  y={b.y + 13}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#64748b"
                  fontSize={showDataDetails ? 10 : 10.5}
                  style={showDataDetails ? monoStyle : undefined}
                >
                  {truncate(subtitle, showDataDetails ? 20 : 16)}
                </text>
                {node.isEntryPoint && (
                  <g>
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
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export default SpecDocMap;
