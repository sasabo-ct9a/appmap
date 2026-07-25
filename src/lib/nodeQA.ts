import { invoke } from "@tauri-apps/api/core";
import type { ScreenNode, ScreenEdge } from "../types/screen";
import { pickLocalized, type Language } from "./i18n";
import type { Engine } from "./storage";
import { CLAUDE_MODEL } from "./claudeCli";
import { startLlamaServer } from "./llamaClient";

/**
 * v0.1.8:ノード単位の AI Q&A。
 *
 * 目的:
 *   - Inspector パネルから「この画面って何?」を自由入力で AI に聞ける
 *   - 用語を知らないユーザーが「聞き方も分からない」壁を越えるための入口
 *
 * 設計:
 *   - Rust の `claude_chat` / `llama_chat` を engine に応じて呼び分け
 *   - コード全体は渡さない。ノードの構造情報だけを短く整形して渡す
 *   - 履歴はフォルダ×ノード単位で localStorage(直近 20 件、それ以上は古い順に切る)
 *   - 単発 Q&A(次の質問に前の応答は渡さない)。Phase B の最小構成
 */

export type QAMessage = {
  role: "user" | "assistant";
  content: string;
  /** 受信 or 送信時のミリ秒タイムスタンプ */
  timestamp: number;
};

const MAX_HISTORY = 20;

function keyFor(folderPath: string | null, nodeId: number): string {
  const scope = folderPath ?? "sample";
  return `appmap:qa:v1:${scope}:${nodeId}`;
}

export function loadQAHistory(
  folderPath: string | null,
  nodeId: number,
): QAMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(folderPath, nodeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is QAMessage =>
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        typeof m.timestamp === "number",
    );
  } catch {
    return [];
  }
}

export function saveQAHistory(
  folderPath: string | null,
  nodeId: number,
  history: QAMessage[],
): void {
  try {
    const trimmed = history.slice(-MAX_HISTORY);
    if (trimmed.length === 0) {
      localStorage.removeItem(keyFor(folderPath, nodeId));
      return;
    }
    localStorage.setItem(keyFor(folderPath, nodeId), JSON.stringify(trimmed));
  } catch {
    // storage full 時は諦める
  }
}

export function clearQAHistory(
  folderPath: string | null,
  nodeId: number,
): void {
  try {
    localStorage.removeItem(keyFor(folderPath, nodeId));
  } catch {
    // ignore
  }
}

/**
 * ノード情報を AI 向けに短くまとめる。
 * コード全体は渡さない(トークン節約 + 回答速度優先)。
 * v0.1.8:allNodes + allEdges + changeHint を追加して「変更の影響先」も答えられるように。
 */
function buildNodeContext(
  node: ScreenNode,
  allNodes: ScreenNode[],
  allEdges: ScreenEdge[],
  language: Language,
): string {
  const parts: string[] = [];
  const title = pickLocalized(node.userIntent ?? node.label, language);
  parts.push(`Screen name: ${title}`);

  if (node.detail.title) {
    const desc = pickLocalized(node.detail.title, language);
    if (desc && desc !== title) parts.push(`Subtitle: ${desc}`);
  }
  if (node.detail.body) {
    const body = pickLocalized(node.detail.body, language);
    if (body) parts.push(`What it does: ${body}`);
  }
  if (node.subActions && node.subActions.length > 0) {
    const actions = node.subActions
      .map((a) => pickLocalized(a, language))
      .filter(Boolean)
      .join(", ");
    if (actions) parts.push(`Actions inside: ${actions}`);
  }
  if (node.detail.dataUsed && node.detail.dataUsed.length > 0) {
    const data = node.detail.dataUsed
      .map((d) => pickLocalized(d, language))
      .filter(Boolean)
      .join(", ");
    if (data) parts.push(`Data used: ${data}`);
  }
  if (node.detail.files && node.detail.files.length > 0) {
    parts.push(`Related files: ${node.detail.files.slice(0, 5).join(", ")}`);
  }
  if (node.isEntryPoint) {
    parts.push("This is the app's entry point (starting screen).");
  }

  // v0.1.8:入出力の関係(「変更するとどこに影響するか」を答える根拠になる)
  const nameFor = (id: number): string | null => {
    const n = allNodes.find((x) => x.id === id);
    if (!n) return null;
    return pickLocalized(n.userIntent ?? n.label, language);
  };
  const incoming = allEdges
    .filter((e) => e.to === node.id || (e.bidirectional && e.from === node.id))
    .map((e) => (e.to === node.id ? e.from : e.to))
    .map(nameFor)
    .filter((s): s is string => !!s);
  const outgoing = allEdges
    .filter(
      (e) => e.from === node.id || (e.bidirectional && e.to === node.id),
    )
    .map((e) => (e.from === node.id ? e.to : e.from))
    .map(nameFor)
    .filter((s): s is string => !!s);
  const dedupe = (arr: string[]) => Array.from(new Set(arr));
  const inSet = dedupe(incoming).slice(0, 6);
  const outSet = dedupe(outgoing).slice(0, 6);
  if (inSet.length > 0) {
    parts.push(`Reached from these screens (users arrive here from): ${inSet.join(", ")}`);
  }
  if (outSet.length > 0) {
    parts.push(`Leads to these screens (users leave to): ${outSet.join(", ")}`);
  }
  if (inSet.length === 0 && outSet.length === 0) {
    parts.push("This screen has no known connections to other screens.");
  }

  // v0.1.8:AI 自身が分析時に出した「変更リスク」判定を再利用
  if (node.detail.changeHint) {
    const safetyLabel =
      node.detail.changeHint.safety === "risky"
        ? "high risk (changes may cascade to other screens)"
        : node.detail.changeHint.safety === "neutral"
          ? "moderate risk (changeable if impact is considered)"
          : "low risk (safe to change in isolation)";
    parts.push(`Change safety: ${safetyLabel}`);
    const note = pickLocalized(node.detail.changeHint.note, language);
    if (note) parts.push(`Change note: ${note}`);
  }

  return parts.join("\n");
}

/**
 * v0.1.8:コードが渡される時 / 渡されない時で system prompt を分岐。
 *   - 渡される時:憶測ではなくコードを根拠にした具体的な回答を要求
 *   - 渡されない時:従来通り「マップの情報だけで答える」
 */
function buildSystemPrompt(language: Language, hasCode: boolean): string {
  if (language === "ja") {
    const base = [
      "あなたはノーコード経験者に向けてコードを説明するアシスタントです。",
      "技術用語は避け、Bubble / Notion / Glide の対応概念で例える。",
      "1〜4 文で簡潔に答える。長くなるほど負担が増えるので、要点だけ。",
    ];
    if (hasCode) {
      base.push(
        "この画面の関連ファイル(実コード)が下に貼られています。憶測ではなくコードを読んで答えてください。",
        "コード内で見つけた根拠(関数名、変数名、ファイル名)を1つは引用する。",
        "コードから明確に読み取れない場合は「コードだけでは断言できません」と明示する。",
      );
    } else {
      base.push(
        "コードそのものは渡されない。渡された画面情報だけを根拠に答える。",
        "情報が足りずに答えられない場合は素直に「その情報からは分かりません」と答える。",
      );
    }
    return base.join("\n");
  }
  const base = [
    "You are an assistant explaining code to former no-code users.",
    "Avoid technical jargon; use Bubble / Notion / Glide analogies when possible.",
    "Answer concisely in 1-4 sentences. Longer answers increase cognitive load.",
  ];
  if (hasCode) {
    base.push(
      "The screen's related source files are pasted below. Base your answer on the actual code, not guesses.",
      "Cite at least one concrete grounding (function name, variable name, or file name) from the code.",
      "If the code doesn't make it definitive, say so plainly (\"the code alone doesn't confirm this\").",
    );
  } else {
    base.push(
      "You are NOT given the actual source code — only the screen info below.",
      "If the info is not enough to answer, say so plainly.",
    );
  }
  return base.join("\n");
}

export type AskNodeArgs = {
  node: ScreenNode;
  /** v0.1.8:全ノード(関連画面名の解決に必要) */
  allNodes: ScreenNode[];
  /** v0.1.8:全エッジ(接続情報を AI に渡す) */
  allEdges: ScreenEdge[];
  question: string;
  engine: Engine;
  language: Language;
  /** v0.1.8:実フォルダパス(あれば関連ファイルの実コードを AI に渡す)。null = サンプル / 未分析 */
  folderPath: string | null;
};

/** v0.1.8:Rust 側 read_files_for_qa の返り値 */
type QAFileContent = {
  file: string;
  content: string;
  truncated: boolean;
};

/**
 * 質問を送って回答を待つ。エンジンに応じて Rust command を呼び分ける。
 * Claude は Sonnet 4.5(analyze と同じ)を使う。ローカルは llama-server 起動済み前提。
 */
export async function askNode(args: AskNodeArgs): Promise<string> {
  const { node, allNodes, allEdges, question, engine, language, folderPath } = args;

  // v0.1.8:folder があるときだけ、ノードの関連ファイル実物を Rust 経由で読み込む。
  // 失敗しても致命的にはせず、code なしで従来通りマップ情報だけで答えさせる。
  let codeBlocks: QAFileContent[] = [];
  if (folderPath && node.detail.files && node.detail.files.length > 0) {
    try {
      codeBlocks = await invoke<QAFileContent[]>("read_files_for_qa", {
        folder: folderPath,
        files: node.detail.files.slice(0, 10),
      });
    } catch {
      codeBlocks = [];
    }
  }
  const hasCode = codeBlocks.length > 0;

  const systemPrompt = buildSystemPrompt(language, hasCode);
  const nodeContext = buildNodeContext(node, allNodes, allEdges, language);

  const promptParts: string[] = [
    "Below is the screen the user is asking about:",
    "",
    nodeContext,
    "",
  ];
  if (hasCode) {
    promptParts.push(
      "Related source files (truncated to fit budget — some content may be cut off):",
      "",
    );
    for (const cb of codeBlocks) {
      promptParts.push(
        `--- FILE: ${cb.file}${cb.truncated ? " (truncated)" : ""} ---`,
      );
      promptParts.push(cb.content);
      promptParts.push("--- END FILE ---");
      promptParts.push("");
    }
  }
  promptParts.push("User's question:");
  promptParts.push(question.trim());
  const userPrompt = promptParts.join("\n");

  if (engine === "local") {
    // llama-server を ready 状態に(冪等なので毎回呼んで OK。既に走ってれば no-op)
    // 起動失敗時は言語別に分かりやすいメッセージに翻訳
    try {
      await startLlamaServer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        language === "ja"
          ? `ローカル LLM を起動できませんでした。設定画面でセットアップを確認してください。(${msg})`
          : `Failed to start the local LLM. Check setup in Settings. (${msg})`,
      );
    }
    try {
      return await invoke<string>("llama_chat", {
        systemPrompt,
        userPrompt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 起動直後 or モデルロード中は接続失敗しがち。分かりやすくラップ
      if (msg.includes("error sending request") || msg.includes("connection")) {
        throw new Error(
          language === "ja"
            ? "ローカル LLM に接続できません。起動直後の場合はモデル読込みに数十秒かかります。少し待ってから再送信してください。"
            : "Can't reach the local LLM. If it just started, model loading takes tens of seconds. Wait a moment and resend.",
        );
      }
      throw err;
    }
  }
  // Claude:analyze と同じモデルで一貫性を保つ
  return await invoke<string>("claude_chat", {
    systemPrompt,
    userPrompt,
    model: CLAUDE_MODEL,
  });
}
