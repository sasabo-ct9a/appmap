/**
 * AppMap → claude の橋渡し。AppMap が解析した「今のアプリの構造」を、ユーザーが
 * 自分の Claude(Cursor / Claude Code / claude.ai など)に貼って頼めるテキストに変換する。
 *
 * なぜ必要か:claude→AppMap(自分の Claude で作る → フォルダを AppMap に読ませて理解)
 * はあるのに、AppMap→claude(理解したことを自分の Claude に持っていく)が無かった。
 * 解析が"行き止まり"で、直したくなると結局ゼロから説明し直しになっていた。
 *
 * CreateMode は中に Claude を持つのでこの出口は不要。これは CreateMode を使わず、
 * 外部の自分の Claude で開発するユーザーのためのもの。
 *
 * 重要(CLAUDE.md §6.6):マップは AI 解析(◐)なので誤り得る。渡す文には必ず
 * 「実物のコードを正とせよ」と添える(buildHandoffPrompt が付ける)。これを確定情報
 * として渡すと、Claude が誤ったマップに合わせてコードを"直して"しまう危険がある。
 */
import type { ScreenMapResult } from "./claudeCli";
import type { ScreenNode } from "../types/screen";
import type { Language } from "./i18n";
import { pickLocalized } from "./i18n";

/** 長い本文は貼り付けを膨らませない範囲に丸める。 */
function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** その要素から辿れる「つながり先」の要素名。双方向エッジは両側から辿れる。 */
function outgoingLabels(
  node: ScreenNode,
  map: ScreenMapResult,
  language: Language,
): string[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const names: string[] = [];
  for (const e of map.edges) {
    if (e.from === node.id) {
      const to = byId.get(e.to);
      if (to) names.push(pickLocalized(to.label, language).trim());
    } else if (e.bidirectional && e.to === node.id) {
      const from = byId.get(e.from);
      if (from) names.push(pickLocalized(from.label, language).trim());
    }
  }
  return names;
}

/**
 * アプリ全体の構造を一覧化したテキスト。要素・つながり・扱うデータを 1 行ずつ、
 * 粗く(意図・構造の層だけ)並べる。事実の羅列だけを持ち、注意書き(◐)は付けない
 * ── 注意書きは buildHandoffPrompt がまとめて付ける。
 */
export function buildAppContext(
  map: ScreenMapResult,
  language: Language,
): string {
  const lines = map.nodes.map((n) => {
    const name = pickLocalized(n.label, language).trim();
    const entry = n.isEntryPoint ? "【最初に見る画面】" : "";
    const conn = outgoingLabels(n, map, language);
    const connText = conn.length ? conn.join(", ") : "なし";
    const data = (n.detail.dataUsed ?? [])
      .map((d) => pickLocalized(d, language).trim())
      .filter(Boolean);
    const dataText = data.length ? ` / 扱うデータ: ${data.join(", ")}` : "";
    return `- ${name}${entry} → つながり: ${connText}${dataText}`;
  });

  const parts = ["## アプリ全体の構造(AppMap 解析)"];
  if (map.appSummary) {
    parts.push(`概要: ${pickLocalized(map.appSummary, language).trim()}`);
  }
  parts.push(...lines);
  return parts.join("\n");
}

/**
 * 1 要素(詳細パネルで見ている画面)の詳細テキスト。役割・データ・つながり・関係ファイルを
 * 渡し、「ここ」を Claude が正しく掴めるようにする。注意書きは付けない(上と同じ理由)。
 */
export function buildElementContext(
  node: ScreenNode,
  map: ScreenMapResult,
  language: Language,
): string {
  const name = pickLocalized(node.label, language).trim();
  const parts = [`## 対象の要素:「${name}」`];

  const intent = node.userIntent
    ? pickLocalized(node.userIntent, language).trim()
    : "";
  if (intent) parts.push(`ここでの操作: ${intent}`);

  const body = pickLocalized(node.detail.body, language).trim();
  if (body) parts.push(`役割: ${clip(body, 200)}`);

  const data = (node.detail.dataUsed ?? [])
    .map((d) => pickLocalized(d, language).trim())
    .filter(Boolean);
  if (data.length) parts.push(`扱うデータ: ${data.join(", ")}`);

  const conn = outgoingLabels(node, map, language);
  if (conn.length) parts.push(`つながり: ${conn.join(", ")}`);

  const files = (node.detail.files ?? []).filter(Boolean);
  if (files.length) parts.push(`関係ファイル: ${files.join(", ")}`);

  return parts.join("\n");
}

/**
 * ユーザーが自分の Claude に貼って頼むための完成テキストを組み立てる。
 * 「やりたいこと」(ユーザーの指示)を主役に置き、AppMap の解析結果は参考として添える。
 * ◐ の注意書き(実物のコードを正とせよ)はここで 1 回だけ付ける。
 */
export function buildHandoffPrompt(opts: {
  instruction: string;
  elementContext?: string | null;
  appContext?: string | null;
}): string {
  const blocks: string[] = [
    "以下のアプリを直したいです。手伝ってください。",
    `【やりたいこと】\n${opts.instruction.trim()}`,
  ];

  const ref: string[] = [];
  if (opts.elementContext) ref.push(opts.elementContext);
  if (opts.appContext) ref.push(opts.appContext);
  if (ref.length) {
    blocks.push(
      "【参考:AppMap が解析した現状(AI 解析なので、実物のコードを正としてください)】\n" +
        ref.join("\n\n"),
    );
  }
  return blocks.join("\n\n");
}
