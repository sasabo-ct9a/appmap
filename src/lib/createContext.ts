/**
 * AppMap → Claude の橋渡し。制作モードで Claude Code に指示を出すとき、AppMap が
 * マップ解析で持っている「今のアプリの構造」を、指示に添える短いテキストに変換する。
 *
 * なぜ必要か:これまで Claude に届くのは指示文 1 行だけで、AppMap が見ている画面・
 * つながり・データを Claude は知らないまま毎回直していた。人間が構造を毎回言葉で
 * 補うしかなく、すれ違いの原因になっていた(= 「AppMap→claude の流れが無い」)。
 *
 * 重要(CLAUDE.md §6.6):マップは AI 解析(◐)なので誤り得る。だから Claude には
 * 必ず「参考。実物のコードを正とせよ」と添える。これを確定情報として渡すと、Claude が
 * 誤ったマップに合わせてコードを"直して"しまう危険がある。
 *
 * 方針(§7.1):プロンプト組立ては TypeScript の担当。ここで完成プロンプトを作り、
 * Rust(generate_app)は受け取った prompt をそのまま claude に渡して実行するだけにする。
 */
import type { ScreenMapResult } from "./claudeCli";
import type { ScreenNode } from "../types/screen";
import type { Language } from "./i18n";
import { pickLocalized } from "./i18n";

/** 長い本文はプロンプトを膨らませない範囲に丸める(トークン節約 = ユーザーの枠の節約)。 */
function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** その要素から出ている「つながり先」の要素名。双方向エッジは両側から辿れる。 */
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
 * アプリ全体の構造を一覧化した「常時添付」用の文脈。要素・つながり・扱うデータを
 * 1 行ずつ、粗く(意図・構造の層だけ)並べる。コード=ノードには降りない(n8n 化の罠回避)。
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

  const parts = [
    "## 今のアプリの構造(AppMap が解析した現状・参考情報)",
    "※ AI 解析による現状把握です。実物のコードを正として、必要な所だけ直してください。",
  ];
  if (map.appSummary) {
    parts.push(`概要: ${pickLocalized(map.appSummary, language).trim()}`);
  }
  parts.push(...lines);
  return parts.join("\n");
}

/**
 * ユーザーがタグで「ここ」と指した 1 要素の詳細。曖昧な指さし指示(「ここを直して」)を
 * Claude が正しく掴めるよう、対象要素の役割・データ・つながり・関係ファイルを渡す。
 */
export function buildElementContext(
  node: ScreenNode,
  map: ScreenMapResult,
  language: Language,
): string {
  const name = pickLocalized(node.label, language).trim();
  const parts = [`## いま指している部分:「${name}」`];

  const intent = node.userIntent
    ? pickLocalized(node.userIntent, language).trim()
    : "";
  if (intent) parts.push(`ここでの操作: ${intent}`);

  const body = pickLocalized(node.detail.body, language).trim();
  if (body) parts.push(`役割(参考): ${clip(body, 200)}`);

  const data = (node.detail.dataUsed ?? [])
    .map((d) => pickLocalized(d, language).trim())
    .filter(Boolean);
  if (data.length) parts.push(`扱うデータ: ${data.join(", ")}`);

  const conn = outgoingLabels(node, map, language);
  if (conn.length) parts.push(`つながり: ${conn.join(", ")}`);

  const files = (node.detail.files ?? []).filter(Boolean);
  if (files.length) parts.push(`関係ファイル(参考): ${files.join(", ")}`);

  parts.push(
    "ユーザーはこの部分について指示しています。まずここを対象に直してください。",
  );
  return parts.join("\n");
}

/**
 * Claude Code に渡す完成プロンプトを組み立てる。文脈が無い(初回など)ときは
 * 従来と同じ本文だけを返し、挙動を変えない。指示に合わせて必要な文脈だけ添える。
 */
export function buildGeneratePrompt(opts: {
  instruction: string;
  appContext?: string | null;
  elementContext?: string | null;
}): string {
  const base =
    `この Vite + React アプリを、次の要望に沿って作ってください:「${opts.instruction}」。` +
    "src/App.tsx を中心に実装し、日本語 UI、シンプルで見やすいインラインスタイルに。" +
    "React の useState だけで動く範囲で作る。Vite+React の構成は変えない。" +
    "npm パッケージは追加しない。";

  // 指している要素(最も具体的)を本文の直後に、全体像は後ろに置く。
  const blocks = [base];
  if (opts.elementContext) blocks.push(opts.elementContext);
  if (opts.appContext) blocks.push(opts.appContext);
  return blocks.join("\n\n");
}
