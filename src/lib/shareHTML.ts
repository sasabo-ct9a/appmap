// v0.1.8 shareHTML: single-file exporter
import type { ScreenNode, ScreenEdge } from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";
import { pickLocalized, type Language } from "./i18n";
import { NODE_PALETTE, computeStableColorIndex, paletteAt } from "./nodeColors";

/**
 * v0.1.8:単一 HTML ファイルとして分析結果を書き出す。
 *
 * 目的:
 *   AppMap を持たない相手(上司・投資家・共同創業者)にも Slack / メール /
 *   Notion で送るだけでマップを閲覧してもらえる。ブラウザ 1 個あれば動く。
 *
 * 前提と設計:
 *   - 外部依存ゼロ(CSS / JS / データ / SVG 全部 inline)
 *   - AI 呼び出しなし(閲覧専用)
 *   - 現在の言語(JA/EN)で固定書き出し(受け手が読める前提で送信者が選ぶ)
 *   - 付箋・差分・AI 質問・仕様書・チェックリストは含めない(それらはローカル側の機能)
 *   - HTML エスケープは念入りに(ユーザーのファイルパス・画面名を安全に埋める)
 */

// ────────────────────────────────────────────────────────────────
// HTML エスケープ(データを HTML に埋める前に必ず通す)
// ────────────────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON を <script> タグ内に埋める用に、`</script>` シーケンスをエスケープ */
function safeJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// ────────────────────────────────────────────────────────────────
// マインドマップのレイアウト計算(SpecDocMap 由来、静的向けに簡略化)
// ────────────────────────────────────────────────────────────────
const BRANCH_W = 172;
const BRANCH_H = 70;
const LEAF_H = 28;
const LEAF_GAP_X = 90;
const LEAF_SPACING_Y = 38;
const LEAF_FAN_X = 14;

function estimateTextWidth(text: string, isJa: boolean): number {
  return text.length * (isJa ? 12 : 7) + 32;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

type LayoutBranch = { id: number; x: number; y: number; angle: number };
type LayoutLeaf = { x: number; y: number; w: number; label: string };

function computeLayout(
  nodes: ScreenNode[],
  edges: ScreenEdge[],
  language: Language,
): {
  vbX: number;
  vbY: number;
  vbW: number;
  vbH: number;
  cx: number;
  cy: number;
  branchPositions: Map<number, LayoutBranch>;
  leafPositions: Map<number, LayoutLeaf[]>;
} {
  const isJa = language === "ja";
  const N = nodes.length;
  const entry = nodes.find((n) => n.isEntryPoint);
  const othersRaw = entry ? nodes.filter((n) => n.id !== entry.id) : nodes;

  // 決定的な並び:degree 降順 + ラベル 辞書順
  const degreeAll = (id: number) =>
    edges.reduce(
      (a, e) => a + (e.from === id ? 1 : 0) + (e.to === id ? 1 : 0),
      0,
    );
  const labelOf = (n: ScreenNode) =>
    pickLocalized(n.userIntent ?? n.label, language) || String(n.id);
  const sorted = [...othersRaw].sort((a, b) => {
    const dd = degreeAll(b.id) - degreeAll(a.id);
    if (dd !== 0) return dd;
    return labelOf(a).localeCompare(labelOf(b), "ja");
  });

  const M = sorted.length;
  const leafCap = N >= 10 ? 4 : N >= 7 ? 5 : 7;
  const R_branch = M > 0 ? Math.max(220, 110 + M * 36) : 0;
  const leafOuterReach = BRANCH_W / 2 + LEAF_GAP_X + 200;
  const reach = R_branch + leafOuterReach;
  const W = Math.max(1100, reach * 2 + 120);
  const heightForLeaves = leafCap * LEAF_SPACING_Y + 80;
  const H = Math.max(620, reach * 2 + heightForLeaves * 0.4);
  const cx = W / 2;
  const cy = H / 2;

  const branchPositions = new Map<number, LayoutBranch>();
  const leafPositions = new Map<number, LayoutLeaf[]>();

  if (entry) {
    branchPositions.set(entry.id, { id: entry.id, x: cx, y: cy, angle: 0 });
    leafPositions.set(entry.id, []);
  }
  sorted.forEach((node, i) => {
    const angleDeg = M > 0 ? -135 + (360 / M) * i : 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const bx = cx + R_branch * Math.cos(angleRad);
    const by = cy + R_branch * Math.sin(angleRad);
    branchPositions.set(node.id, { id: node.id, x: bx, y: by, angle: angleRad });

    const leafSource = (
      node.subActions && node.subActions.length > 0
        ? node.subActions
        : node.detail.dataUsed ?? []
    ).slice(0, leafCap);
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

  // viewBox 拡張(全要素を内包)
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
  return {
    vbX: minX,
    vbY: minY,
    vbW: maxX - minX,
    vbH: maxY - minY,
    cx,
    cy,
    branchPositions,
    leafPositions,
  };
}

// ────────────────────────────────────────────────────────────────
// SVG マップ生成
// ────────────────────────────────────────────────────────────────
function renderMapSvg(
  screens: ScreenMapResult,
  language: Language,
  palette: (id: number) => (typeof NODE_PALETTE)[number],
): string {
  const layout = computeLayout(screens.nodes, screens.edges, language);
  const { vbX, vbY, vbW, vbH, cx, cy, branchPositions, leafPositions } = layout;

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="${vbX} ${vbY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block" aria-label="${escHtml(language === "ja" ? "アプリ構造マインドマップ" : "App mind map")}">`,
  );

  // エッジ
  for (const edge of screens.edges) {
    const fromB = branchPositions.get(edge.from);
    const toB = branchPositions.get(edge.to);
    if (!fromB || !toB) continue;
    const fromP = palette(edge.from);
    const midX = (fromB.x + toB.x) / 2;
    const midY = (fromB.y + toB.y) / 2;
    const dx = midX - cx;
    const dy = midY - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const pushOut = 80;
    const pullX = midX + (dx / d) * pushOut;
    const pullY = midY + (dy / d) * pushOut;
    parts.push(
      `<path d="M ${fromB.x} ${fromB.y} Q ${pullX} ${pullY} ${toB.x} ${toB.y}" fill="none" stroke="${fromP.accent}" stroke-opacity="0.35" stroke-width="1.4" stroke-linecap="round"/>`,
    );
  }

  // 主枝 → 葉のライン
  for (const node of screens.nodes) {
    const b = branchPositions.get(node.id);
    const leaves = leafPositions.get(node.id);
    if (!b || !leaves) continue;
    const p = palette(node.id);
    const isRight = b.x >= cx;
    const sign = isRight ? 1 : -1;
    const branchEdgeX = b.x + sign * (BRANCH_W / 2 - 4);
    const branchEdgeY = b.y;
    leaves.forEach((leaf, i) => {
      const leafEdgeX = leaf.x - sign * (leaf.w / 2);
      const midX = (branchEdgeX + leafEdgeX) / 2;
      const midY = (branchEdgeY + leaf.y) / 2;
      parts.push(
        `<path d="M ${branchEdgeX} ${branchEdgeY} Q ${midX} ${midY} ${leafEdgeX} ${leaf.y}" fill="none" stroke="${p.accent}" stroke-opacity="0.5" stroke-width="1.3" stroke-dasharray="3 4" stroke-linecap="round"/>`,
      );
      void i;
    });
  }

  // 葉チップ
  for (const node of screens.nodes) {
    const leaves = leafPositions.get(node.id);
    if (!leaves) continue;
    const p = palette(node.id);
    for (const leaf of leaves) {
      parts.push(
        `<g>` +
          `<rect x="${leaf.x - leaf.w / 2}" y="${leaf.y - LEAF_H / 2}" width="${leaf.w}" height="${LEAF_H}" rx="${LEAF_H / 2}" fill="${p.soft}" stroke="${p.border}" stroke-width="1"/>` +
          `<text x="${leaf.x}" y="${leaf.y + 1}" text-anchor="middle" dominant-baseline="middle" fill="${p.text}" font-size="11.5" font-weight="600">${escHtml(leaf.label)}</text>` +
          `</g>`,
      );
    }
  }

  // 主枝ピル(クリック可能:data-node-id を付与)
  for (const node of screens.nodes) {
    const b = branchPositions.get(node.id);
    if (!b) continue;
    const p = palette(node.id);
    const title = truncate(
      pickLocalized(node.userIntent ?? node.label, language),
      11,
    );
    const subtitle = truncate(pickLocalized(node.detail.title, language), 16);
    const x = b.x - BRANCH_W / 2;
    const y = b.y - BRANCH_H / 2;
    parts.push(
      `<g data-node-id="${node.id}" class="am-node" style="cursor:pointer">` +
        `<rect x="${x}" y="${y}" width="${BRANCH_W}" height="${BRANCH_H}" rx="${BRANCH_H / 2}" fill="${p.soft}" stroke="${p.border}" stroke-width="2"/>` +
        `<text x="${b.x}" y="${b.y - 8}" text-anchor="middle" dominant-baseline="middle" fill="${p.text}" font-size="15" font-weight="700">${escHtml(title)}</text>` +
        `<text x="${b.x}" y="${b.y + 13}" text-anchor="middle" dominant-baseline="middle" fill="#64748b" font-size="10.5">${escHtml(subtitle)}</text>`,
    );
    if (node.isEntryPoint) {
      parts.push(
        `<rect x="${b.x - 40}" y="${y - 18}" width="80" height="16" rx="8" fill="${p.accent}"/>` +
          `<text x="${b.x}" y="${y - 9}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="9" font-weight="700">${escHtml(language === "ja" ? "はじまり" : "START")}</text>`,
      );
    }
    parts.push(`</g>`);
  }

  parts.push(`</svg>`);
  return parts.join("");
}

// ────────────────────────────────────────────────────────────────
// メイン:HTML 全体を組み立て
// ────────────────────────────────────────────────────────────────
export type BuildShareHTMLOptions = {
  screens: ScreenMapResult;
  language: Language;
  appName: string;
  /** 生成時のタイムスタンプを footer に入れる用(呼び出し側で Date.now()) */
  generatedAt: number;
};

export function buildShareHTML(opts: BuildShareHTMLOptions): string {
  const { screens, language, appName, generatedAt } = opts;
  const isJa = language === "ja";
  const colorIndex = computeStableColorIndex(
    screens.nodes,
    screens.edges,
    language,
  );
  const palette = (id: number) => paletteAt(colorIndex.get(id) ?? 0);

  const summary = screens.appSummary
    ? pickLocalized(screens.appSummary, language)
    : "";
  const svg = renderMapSvg(screens, language, palette);

  // ノード詳細を JS 用にシリアライズ(必要な部分だけ)
  const inspectorData = screens.nodes.map((n) => {
    const outgoing = screens.edges
      .filter((e) => e.from === n.id || (e.bidirectional && e.to === n.id))
      .map((e) => (e.from === n.id ? e.to : e.from));
    const incoming = screens.edges
      .filter((e) => e.to === n.id && !e.bidirectional)
      .map((e) => e.from);
    const connectedIds = Array.from(new Set([...outgoing, ...incoming]));
    return {
      id: n.id,
      colorIndex: colorIndex.get(n.id) ?? 0,
      title: pickLocalized(n.userIntent ?? n.label, language),
      subtitle: pickLocalized(n.detail.title, language),
      body: pickLocalized(n.detail.body, language),
      subActions: (n.subActions ?? []).map((a) => pickLocalized(a, language)),
      dataUsed: (n.detail.dataUsed ?? []).map((d) =>
        pickLocalized(d, language),
      ),
      files: n.detail.files ?? [],
      isEntryPoint: !!n.isEntryPoint,
      connectedIds,
      connectedTitles: connectedIds
        .map((cid) => {
          const t = screens.nodes.find((x) => x.id === cid);
          return t
            ? { id: cid, title: pickLocalized(t.userIntent ?? t.label, language) }
            : null;
        })
        .filter(Boolean),
      changeHint: n.detail.changeHint
        ? {
            safety: n.detail.changeHint.safety,
            note: pickLocalized(n.detail.changeHint.note, language),
          }
        : null,
    };
  });

  // 主要ユーザーフロー(BottomSection と同じ簡易派生)
  const flowIds: number[] = [];
  const entry =
    screens.nodes.find((n) => n.isEntryPoint) ?? screens.nodes[0] ?? null;
  if (entry) {
    const seen = new Set<number>([entry.id]);
    flowIds.push(entry.id);
    let cur: ScreenNode | undefined = entry;
    for (let i = 0; i < 6 && cur; i++) {
      const next: ScreenNode | undefined = screens.edges
        .filter((e) => e.from === cur!.id && !seen.has(e.to))
        .map((e) => screens.nodes.find((n) => n.id === e.to))
        .filter((n): n is ScreenNode => !!n)
        .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))[0];
      if (!next) break;
      flowIds.push(next.id);
      seen.add(next.id);
      cur = next;
    }
  }
  const flow = flowIds
    .map((id) => screens.nodes.find((n) => n.id === id))
    .filter((n): n is ScreenNode => !!n)
    .map((n) => ({
      id: n.id,
      colorIndex: colorIndex.get(n.id) ?? 0,
      label: pickLocalized(n.userIntent ?? n.label, language),
    }));

  // 上位 4 画面 = 機能カード(degree 降順)
  const cards = [...screens.nodes]
    .sort((a, b) => {
      const da = screens.edges.filter(
        (e) => e.from === a.id || e.to === a.id,
      ).length;
      const db = screens.edges.filter(
        (e) => e.from === b.id || e.to === b.id,
      ).length;
      return db - da;
    })
    .slice(0, 4)
    .map((n) => ({
      id: n.id,
      colorIndex: colorIndex.get(n.id) ?? 0,
      title: pickLocalized(n.userIntent ?? n.label, language),
      subtitle: pickLocalized(n.detail.title, language),
      isMain: !!n.isEntryPoint || (n.depth ?? 0) === 0,
    }));

  const dateStr = new Date(generatedAt).toISOString().slice(0, 10);
  const strings = isJa
    ? {
        docTitle: `${appName} - アプリの全体像`,
        heading: appName,
        overviewLabel: "アプリの全体像",
        countsScreens: (n: number) => `${n} 要素`,
        countsLinks: (n: number) => `${n} つながり`,
        cardsHeading: "このアプリでできること",
        mapHeading: "アプリ全体マップ",
        mapHint: "要素をクリックして詳細を表示",
        inspectorEmpty: "左のマップで要素をクリックすると詳細が表示されます。",
        inspectorConnectedLabel: "つながっている要素",
        inspectorDataLabel: "使うデータ",
        inspectorFilesLabel: "関連ファイル",
        inspectorImpactLabel: "変更したときの影響",
        badgeMain: "主要",
        badgeSupport: "サポート",
        badgeEntry: "はじまり",
        flowHeading: "主なユーザーフロー",
        footer: `AppMap で生成 · ${dateStr}`,
        safetyEasy: "低",
        safetyNeutral: "中",
        safetyRisky: "高",
      }
    : {
        docTitle: `${appName} - App overview`,
        heading: appName,
        overviewLabel: "App overview",
        countsScreens: (n: number) => `${n} pieces`,
        countsLinks: (n: number) => `${n} links`,
        cardsHeading: "What this app can do",
        mapHeading: "App map",
        mapHint: "Click a screen for details",
        inspectorEmpty:
          "Click any screen on the left to see its details here.",
        inspectorConnectedLabel: "Connected pieces",
        inspectorDataLabel: "Data used",
        inspectorFilesLabel: "Related files",
        inspectorImpactLabel: "Impact of changes",
        badgeMain: "Main",
        badgeSupport: "Support",
        badgeEntry: "START",
        flowHeading: "Main user flow",
        footer: `Generated by AppMap · ${dateStr}`,
        safetyEasy: "Low",
        safetyNeutral: "Med",
        safetyRisky: "High",
      };

  const css = `
    :root {
      --charcoal: #111827;
      --slate: #1F2937;
      --paper: #FFFFFF;
      --canvas: #F5F7FA;
      --ink: #334155;
      --ink-strong: #0F172A;
      --ink-soft: #64748B;
      --border: #E5E7EB;
      --teal: #14B8A6;
      --teal-soft: #E6FFFB;
      --purple: #A78BFA;
      --purple-soft: #F5F0FF;
      --safety-easy: #14B8A6;
      --safety-neutral: #F59E0B;
      --safety-risky: #EF4444;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      font-family: "Inter", "Noto Sans JP", system-ui, -apple-system, "Segoe UI", sans-serif;
      background: var(--canvas);
      color: var(--ink-strong);
      -webkit-font-smoothing: antialiased;
    }
    header.top {
      background: var(--paper);
      border-bottom: 1px solid var(--border);
      padding: 20px 32px;
    }
    header.top h1 { font-size: 22px; font-weight: 800; margin: 0; letter-spacing: -0.01em; }
    header.top p { font-size: 13px; color: var(--ink-soft); margin: 4px 0 0; line-height: 1.55; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px 32px; }
    .counts { display: flex; gap: 10px; margin-bottom: 16px; }
    .count-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 14px; border: 2px solid;
      font-weight: 600; font-size: 13px;
    }
    .count-pill.teal { border-color: var(--teal); background: var(--teal-soft); color: var(--teal); }
    .count-pill.purple { border-color: var(--purple); background: var(--purple-soft); color: #7C3AED; }
    .count-pill strong { font-size: 20px; font-weight: 800; }
    h2.section {
      font-size: 16px; font-weight: 800; margin: 24px 0 12px;
      display: flex; align-items: center; gap: 8px;
      color: var(--ink-strong);
    }
    .feature-cards {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px; margin-bottom: 24px;
    }
    .feature-card {
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .feature-card:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(15,23,42,0.06); }
    .feature-card .card-title { font-weight: 800; font-size: 16px; margin-bottom: 4px; }
    .feature-card .card-subtitle { font-size: 12px; color: var(--ink-soft); margin-bottom: 12px; }
    .feature-card .card-badge {
      display: inline-block;
      font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px;
    }
    .layout {
      display: grid; grid-template-columns: 1fr 360px; gap: 16px;
      align-items: start;
    }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
    .map-panel {
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      overflow: hidden;
    }
    .map-panel .map-header {
      display: flex; align-items: baseline; gap: 10px; padding: 4px 6px 10px;
    }
    .map-panel .map-header .title { font-weight: 800; font-size: 14px; }
    .map-panel .map-header .hint { font-size: 11px; color: var(--ink-soft); }
    .map-panel svg { width: 100%; height: auto; display: block; }
    .am-node:hover rect:first-of-type { filter: brightness(0.97); }
    .am-node.selected rect:first-of-type { stroke-width: 3.5 !important; }
    .inspector {
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      position: sticky; top: 20px;
      max-height: calc(100vh - 40px);
      overflow-y: auto;
    }
    .inspector .empty {
      color: var(--ink-soft); font-size: 13px; line-height: 1.6;
      padding: 12px; text-align: center;
    }
    .inspector .hero {
      border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
      border-left: 4px solid;
    }
    .inspector .hero .h-title { font-weight: 800; font-size: 15px; }
    .inspector .hero .h-sub { font-size: 11px; color: var(--ink-soft); margin-top: 2px; }
    .inspector .body { font-size: 13px; color: var(--ink); line-height: 1.65; margin-bottom: 16px; }
    .inspector .section { margin-bottom: 14px; }
    .inspector .section .label {
      font-size: 10px; font-weight: 800; text-transform: uppercase;
      color: var(--ink-soft); letter-spacing: 0.06em; margin-bottom: 6px;
    }
    .inspector .connected li {
      list-style: none; padding: 6px 10px; border-radius: 6px;
      background: var(--canvas); font-size: 12px; margin-bottom: 4px;
      cursor: pointer; display: flex; align-items: center; gap: 6px;
    }
    .inspector .connected li:hover { background: #EFF2F6; }
    .inspector .connected .dot {
      width: 7px; height: 7px; border-radius: 50%;
    }
    .inspector .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .inspector .chip {
      display: inline-flex; align-items: center;
      font-size: 11px; padding: 4px 8px; border-radius: 100px;
      background: var(--canvas); border: 1px solid var(--border);
    }
    .inspector .files { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; color: var(--ink-soft); }
    .inspector .files code { display: block; padding: 3px 0; word-break: break-all; }
    .inspector .impact {
      padding: 10px 12px; border-radius: 8px; border-left: 4px solid;
      font-size: 12px; line-height: 1.55; margin-bottom: 8px;
    }
    .inspector .impact.easy { background: #ECFDF5; border-color: var(--safety-easy); color: #065F46; }
    .inspector .impact.neutral { background: #FFFBEB; border-color: var(--safety-neutral); color: #78350F; }
    .inspector .impact.risky { background: #FEF2F2; border-color: var(--safety-risky); color: #7F1D1D; }
    .flow-panel {
      background: var(--paper); border: 1px solid var(--border);
      border-radius: 14px; padding: 16px; margin-top: 16px;
    }
    .flow-panel .flow-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .flow-chip {
      display: inline-block; font-size: 11px; font-weight: 600;
      padding: 5px 10px; border-radius: 8px;
    }
    .flow-arrow { color: var(--ink-soft); font-size: 12px; }
    footer.bottom {
      text-align: center; font-size: 11px; color: var(--ink-soft);
      padding: 24px 0; border-top: 1px solid var(--border); margin-top: 32px;
      background: var(--paper);
    }
  `;

  const js = `
    (function() {
      const NODES = __INSPECTOR_DATA__;
      const PALETTE = __PALETTE__;
      const S = __STRINGS__;
      const nodeById = new Map(NODES.map(n => [n.id, n]));
      const inspector = document.getElementById('am-inspector');

      function paletteFor(idx) { return PALETTE[idx % PALETTE.length]; }
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function renderInspector(id) {
        const n = nodeById.get(id);
        if (!n) return;
        const p = paletteFor(n.colorIndex);
        const impact = n.changeHint ? \`
          <div class="section">
            <div class="label">\${esc(S.inspectorImpactLabel)}</div>
            <div class="impact \${n.changeHint.safety || 'neutral'}">
              \${esc(n.changeHint.note)}
            </div>
          </div>\` : '';
        const connected = (n.connectedTitles && n.connectedTitles.length) ? \`
          <div class="section">
            <div class="label">\${esc(S.inspectorConnectedLabel)}</div>
            <ul class="connected">
              \${n.connectedTitles.map(c => {
                const cp = paletteFor(nodeById.get(c.id)?.colorIndex ?? 0);
                return '<li data-goto="' + c.id + '"><span class="dot" style="background:' + cp.accent + '"></span>' + esc(c.title) + '</li>';
              }).join('')}
            </ul>
          </div>\` : '';
        const dataChips = (n.dataUsed && n.dataUsed.length) ? \`
          <div class="section">
            <div class="label">\${esc(S.inspectorDataLabel)}</div>
            <div class="chips">
              \${n.dataUsed.map(d => '<span class="chip">' + esc(d) + '</span>').join('')}
            </div>
          </div>\` : '';
        const filesBlock = (n.files && n.files.length) ? \`
          <div class="section">
            <div class="label">\${esc(S.inspectorFilesLabel)} (\${n.files.length})</div>
            <div class="files">
              \${n.files.map(f => '<code>' + esc(f) + '</code>').join('')}
            </div>
          </div>\` : '';
        inspector.innerHTML = \`
          <div class="hero" style="background:\${p.soft};border-color:\${p.accent};color:\${p.text}">
            <div class="h-title">\${esc(n.title)}</div>
            <div class="h-sub">\${esc(n.subtitle)}</div>
          </div>
          <div class="body">\${esc(n.body)}</div>
          \${impact}
          \${connected}
          \${dataChips}
          \${filesBlock}
        \`;
        inspector.scrollTo({ top: 0, behavior: 'smooth' });
        document.querySelectorAll('.am-node.selected').forEach(el => el.classList.remove('selected'));
        const target = document.querySelector('[data-node-id="' + id + '"]');
        if (target) target.classList.add('selected');
      }

      // クリック配線:SVG のノード + 機能カード + connected リスト + flow chip
      document.body.addEventListener('click', function(e) {
        const nodeEl = e.target.closest('[data-node-id]');
        if (nodeEl) { renderInspector(parseInt(nodeEl.dataset.nodeId, 10)); return; }
        const gotoEl = e.target.closest('[data-goto]');
        if (gotoEl) { renderInspector(parseInt(gotoEl.dataset.goto, 10)); }
      });
    })();
  `
    .replace("__INSPECTOR_DATA__", safeJson(inspectorData))
    .replace("__PALETTE__", safeJson(NODE_PALETTE))
    .replace("__STRINGS__", safeJson(strings));

  // 機能カード HTML
  const cardsHtml = cards
    .map((c) => {
      const p = paletteAt(c.colorIndex);
      const badge = c.isMain ? strings.badgeMain : strings.badgeSupport;
      const badgeStyle = c.isMain
        ? `background:${p.soft};color:${p.text}`
        : `background:#F1F5F9;color:#64748b`;
      return `<div class="feature-card" data-node-id="${c.id}" style="border-color:${p.border}">` +
        `<div class="card-title" style="color:${p.text}">${escHtml(c.title)}</div>` +
        `<div class="card-subtitle">${escHtml(c.subtitle)}</div>` +
        `<span class="card-badge" style="${badgeStyle}">${escHtml(badge)}</span>` +
        `</div>`;
    })
    .join("");

  // フローチップ HTML
  const flowHtml = flow
    .map((f, i) => {
      const p = paletteAt(f.colorIndex);
      const chip = `<span class="flow-chip" style="background:${p.soft};color:${p.text}" data-node-id="${f.id}" role="button">${escHtml(f.label.length > 12 ? f.label.slice(0, 11) + "…" : f.label)}</span>`;
      const arrow = i < flow.length - 1 ? `<span class="flow-arrow">→</span>` : "";
      return chip + arrow;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="${escHtml(language)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(strings.docTitle)}</title>
<style>${css}</style>
</head>
<body>
<header class="top">
  <h1>${escHtml(strings.heading)}</h1>
  ${summary ? `<p>${escHtml(summary)}</p>` : ""}
</header>

<div class="container">
  <div class="counts">
    <span class="count-pill teal"><strong>${screens.nodes.length}</strong>${escHtml(strings.countsScreens(screens.nodes.length).replace(String(screens.nodes.length), "").trim())}</span>
    <span class="count-pill purple"><strong>${screens.edges.length}</strong>${escHtml(strings.countsLinks(screens.edges.length).replace(String(screens.edges.length), "").trim())}</span>
  </div>

  <h2 class="section">${escHtml(strings.cardsHeading)}</h2>
  <div class="feature-cards">${cardsHtml}</div>

  <div class="layout">
    <div class="map-panel">
      <div class="map-header">
        <span class="title">${escHtml(strings.mapHeading)}</span>
        <span class="hint">${escHtml(strings.mapHint)}</span>
      </div>
      ${svg}
    </div>
    <aside class="inspector" id="am-inspector">
      <div class="empty">${escHtml(strings.inspectorEmpty)}</div>
    </aside>
  </div>

  ${flow.length > 1 ? `<div class="flow-panel">
    <h2 class="section" style="margin-top:0">${escHtml(strings.flowHeading)}</h2>
    <div class="flow-chips">${flowHtml}</div>
  </div>` : ""}
</div>

<footer class="bottom">${escHtml(strings.footer)}</footer>

<script>${js}</script>
</body>
</html>`;
}
