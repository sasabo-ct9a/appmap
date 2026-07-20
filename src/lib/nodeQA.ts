import { invoke } from "@tauri-apps/api/core";
import type { ScreenNode } from "../types/screen";
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
 */
function buildNodeContext(node: ScreenNode, language: Language): string {
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
  return parts.join("\n");
}

function buildSystemPrompt(language: Language): string {
  if (language === "ja") {
    return [
      "あなたはノーコード経験者に向けてコードを説明するアシスタントです。",
      "技術用語は避け、Bubble / Notion / Glide の対応概念で例える。",
      "1〜4 文で簡潔に答える。長くなるほど負担が増えるので、要点だけ。",
      "コードそのものは渡されない。渡された画面情報だけを根拠に答える。",
      "情報が足りずに答えられない場合は素直に「その情報からは分かりません」と答える。",
    ].join("\n");
  }
  return [
    "You are an assistant explaining code to former no-code users.",
    "Avoid technical jargon; use Bubble / Notion / Glide analogies when possible.",
    "Answer concisely in 1-4 sentences. Longer answers increase cognitive load.",
    "You are NOT given the actual source code — only the screen info below.",
    "If the info is not enough to answer, say so plainly.",
  ].join("\n");
}

export type AskNodeArgs = {
  node: ScreenNode;
  question: string;
  engine: Engine;
  language: Language;
};

/**
 * 質問を送って回答を待つ。エンジンに応じて Rust command を呼び分ける。
 * Claude は Sonnet 4.5(analyze と同じ)を使う。ローカルは llama-server 起動済み前提。
 */
export async function askNode(args: AskNodeArgs): Promise<string> {
  const { node, question, engine, language } = args;
  const systemPrompt = buildSystemPrompt(language);
  const nodeContext = buildNodeContext(node, language);
  const userPrompt = [
    "Below is the screen the user is asking about:",
    "",
    nodeContext,
    "",
    "User's question:",
    question.trim(),
  ].join("\n");

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
