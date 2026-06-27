import type { ScreenNode, ScreenEdge } from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";
import { t, pickLocalized, type Language } from "./i18n";

/**
 * v0.1.7 機能拡張:出来上がったマップから「アプリ仕様書」(Markdown)を組み立てる。
 *
 * 設計判断:
 *   - **AI 追加コール無し**:既存マップ(saveAnalysis 時に取得済み)から決定的に
 *     文字列を組み立てる → 追加コストゼロ、瞬時に出る
 *   - 読者(audience)で出力を切替える:
 *       - engineer:  body(技術)+ files 可視 + changeHint
 *       - noCode:    bodyNoCode(Bubble/Notion 語彙)+ files 非表示 + changeHint
 *       - endUser:   bodyNoCode + userIntent を見出し化 + files 非表示 + changeHint 非表示
 *   - 言語(language)で セクション見出し・固定語彙を切替(i18n.ts 由来)
 *   - 出力は Markdown 文字列。受け側がそのまま Markdown viewer や PDF 印刷で読める
 *
 * 入力: ScreenMapResult(nodes, edges, appSummary)
 * 出力: Markdown 文字列
 */

export type SpecAudience = "engineer" | "noCode" | "endUser";

type BuildOptions = {
  screens: ScreenMapResult;
  audience: SpecAudience;
  language: Language;
  /** 表示中フォルダパス(あれば見出しに含める)。サンプル時は null。 */
  folderPath: string | null;
};

/** ScreenEdge → from/to ペアの隣接情報を引きやすくするためのインデックス。 */
function indexEdges(edges: ScreenEdge[]): {
  outgoing: Map<number, Array<{ to: number; bidi: boolean }>>;
  incoming: Map<number, Array<{ from: number; bidi: boolean }>>;
} {
  const outgoing = new Map<number, Array<{ to: number; bidi: boolean }>>();
  const incoming = new Map<number, Array<{ from: number; bidi: boolean }>>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push({ to: e.to, bidi: !!e.bidirectional });
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push({ from: e.from, bidi: !!e.bidirectional });
  }
  return { outgoing, incoming };
}

/** Markdown テーブル用に "|" をエスケープ(本文には残す)。 */
function escTable(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** changeHint.safety → 翻訳語(InspectorPanel と同じ語彙を流用)。 */
function safetyLabel(
  safety: "easy" | "neutral" | "risky",
  language: Language,
): string {
  const T = t(language).inspector;
  if (safety === "easy") return T.safetyEasy;
  if (safety === "risky") return T.safetyRisky;
  return T.safetyNeutral;
}

/** ノードを id でルックアップする Map。 */
function indexNodes(nodes: ScreenNode[]): Map<number, ScreenNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** audience + language に応じて description テキストを選ぶ(v0.1.7 多言語化)。 */
function pickDescription(
  node: ScreenNode,
  audience: SpecAudience,
  language: Language,
): string {
  const source =
    audience === "engineer" ? node.detail.body : node.detail.bodyNoCode;
  return pickLocalized(source, language);
}

/** メイン:マップから Markdown 仕様書を組み立てる。 */
export function buildSpecDoc(opts: BuildOptions): string {
  const { screens, audience, language, folderPath } = opts;
  const S = t(language).specDoc;
  const { outgoing, incoming } = indexEdges(screens.edges);
  const nodeById = indexNodes(screens.nodes);

  // 並び順:depth 昇順 → 同 depth 内は position.x 昇順(画面一覧の見やすさ)
  const sortedNodes = [...screens.nodes].sort((a, b) => {
    const da = a.depth ?? 0;
    const db = b.depth ?? 0;
    if (da !== db) return da - db;
    return a.position.x - b.position.x;
  });

  const lines: string[] = [];

  // ── タイトル + メタ
  lines.push(`# ${S.docTitle}`);
  lines.push("");
  if (folderPath) lines.push(`> \`${folderPath}\``);
  lines.push("");

  // ── 概要(appSummary があれば)
  // v0.1.7 多言語化:LocalizedText から言語別文字列を取り出す。
  lines.push(`## ${S.sectionOverview}`);
  lines.push("");
  lines.push(
    screens.appSummary
      ? pickLocalized(screens.appSummary, language)
      : S.emptyAppSummary,
  );
  lines.push("");

  // ── 画面一覧(テーブル)
  lines.push(`## ${S.sectionScreenList}`);
  lines.push("");
  lines.push(`| ${S.tableNum} | ${S.tableName} | ${S.tableRole} |`);
  lines.push(`| --- | --- | --- |`);
  for (const n of sortedNodes) {
    const label = pickLocalized(n.label, language);
    const role = n.userIntent ? pickLocalized(n.userIntent, language) : "-";
    lines.push(`| ${n.id} | ${escTable(label)} | ${escTable(role)} |`);
  }
  lines.push("");

  // ── 画面詳細
  lines.push(`## ${S.sectionScreenDetail}`);
  lines.push("");

  for (const n of sortedNodes) {
    const title = pickLocalized(n.detail.title, language);
    const userIntent = n.userIntent ? pickLocalized(n.userIntent, language) : null;
    // 見出し:endUser は「○○ する」というユーザー目的を主見出しに、画面名を副見出しに
    if (audience === "endUser" && userIntent) {
      lines.push(`### ${n.id}. ${userIntent}`);
      lines.push(`*${title}*`);
    } else {
      lines.push(`### ${n.id}. ${title}`);
    }
    lines.push("");

    // 役割(userIntent)
    if (userIntent && audience !== "endUser") {
      lines.push(`- **${S.fieldRole}**: ${userIntent}`);
    }

    // 起点画面
    if (n.isEntryPoint) {
      lines.push(`- **${S.fieldEntryPoint}**: ✅`);
    }

    // 説明
    lines.push("");
    lines.push(`**${S.fieldDescription}**`);
    lines.push("");
    lines.push(pickDescription(n, audience, language));
    lines.push("");

    // 使うデータ
    const data = n.detail.dataUsed ?? [];
    if (data.length > 0) {
      lines.push(`**${S.fieldDataUsed}**`);
      lines.push("");
      for (const d of data) lines.push(`- ${pickLocalized(d, language)}`);
      lines.push("");
    }

    // 関連ファイル(engineer のみ)
    const files = n.detail.files ?? [];
    if (audience === "engineer" && files.length > 0) {
      lines.push(`**${S.fieldFiles}**`);
      lines.push("");
      for (const f of files) lines.push(`- \`${f}\``);
      lines.push("");
    }

    // 関連画面(遷移先 / 遷移元)
    const outs = outgoing.get(n.id) ?? [];
    const ins = incoming.get(n.id) ?? [];
    // 双方向は outs と ins 両方に乗るので重複させない:from < to の側だけに乗せる
    const relatedDescs: string[] = [];
    for (const o of outs) {
      const target = nodeById.get(o.to);
      if (!target) continue;
      const arrow = o.bidi ? "↔" : "→";
      relatedDescs.push(`${arrow} ${pickLocalized(target.label, language)}`);
    }
    for (const i of ins) {
      // 双方向(bidi)エッジは outs で既に出してあるのでスキップ
      if (i.bidi) continue;
      const source = nodeById.get(i.from);
      if (!source) continue;
      relatedDescs.push(`← ${pickLocalized(source.label, language)}`);
    }
    if (relatedDescs.length > 0) {
      lines.push(`**${S.fieldRelatedScreens}**`);
      lines.push("");
      for (const r of relatedDescs) lines.push(`- ${r}`);
      lines.push("");
    }

    // 変更目安(endUser は非表示 — 実装の話なのでエンドユーザーには不要)
    const hint = n.detail.changeHint;
    if (hint && audience !== "endUser") {
      lines.push(
        `**${S.fieldChangeHint}**: ${safetyLabel(hint.safety, language)} — ${pickLocalized(hint.note, language)}`,
      );
      lines.push("");
    }

    lines.push("");
  }

  // ── 画面遷移(全 edges を箇条書きで)
  if (screens.edges.length > 0) {
    lines.push(`## ${S.sectionTransitions}`);
    lines.push("");
    for (const e of screens.edges) {
      const from = nodeById.get(e.from);
      const to = nodeById.get(e.to);
      if (!from || !to) continue;
      const arrow = e.bidirectional ? "↔" : "→";
      const fromLabel = pickLocalized(from.label, language);
      const toLabel = pickLocalized(to.label, language);
      lines.push(`- ${fromLabel} ${arrow} ${toLabel}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
