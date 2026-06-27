import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  buildSystemPrompt,
  USER_PROMPT_TEMPLATE,
  RESPONSE_SCHEMA,
  normalizeAndSanitizeScreenMap,
  extractJsonFromString,
  isScreenMapResult,
  type AnalysisOutcome,
  type ScreenMapResult,
} from "./claudeCli";
import { t, type Language } from "./i18n";

/**
 * v0.1.7 ローカル LLM(llama.cpp + Qwen 2.5-Coder)クライアント。
 *
 * 役割:
 *   - Rust 側 `llama_*` Tauri command 群への薄いラッパー
 *   - `claudeCli.ts` の `analyzeFolderToScreenMap` と **戻り値型が同じ** インターフェース
 *     (`engineSelector.ts` から透過的に呼び替えできる)
 *
 * 設計:
 *   - SYSTEM_PROMPT / USER_PROMPT_TEMPLATE / RESPONSE_SCHEMA は Claude 版を流用
 *   - コスト($)は 0 固定、durationMs は client 側で計測
 *   - llama-server が出した JSON が壊れていた場合、`extractJsonFromString` で
 *     コードフェンスや prose 混入を救済(Claude 版と同じ防御策)
 */

/**
 * llama-server バイナリが配置されているか確認。
 * 戻り値:バージョン文字列 or null(未配置 / 起動失敗)
 */
export async function checkLlamaBinary(): Promise<string | null> {
  try {
    return await invoke<string>("llama_check_binary");
  } catch (err) {
    console.warn("llama_check_binary failed:", err);
    return null;
  }
}

/** デフォルトモデル(Qwen 2.5-Coder 7B Q4)が DL 済みかどうか。 */
export async function checkLlamaModel(): Promise<boolean> {
  try {
    return await invoke<boolean>("llama_check_model");
  } catch (err) {
    console.warn("llama_check_model failed:", err);
    return false;
  }
}

/** モデル保存先パスを返す(UI 表示用)。 */
export async function getLlamaModelPath(): Promise<string> {
  return await invoke<string>("llama_model_path");
}

/**
 * モデルを HuggingFace から DL する。約 4.5 GB、回線次第で 5〜30 分。
 * onProgress は 1 MB ごとに呼ばれる({downloaded, total} bytes)。
 * 完了でモデルパスを返す。
 */
export async function downloadLlamaModel(
  onProgress: (downloaded: number, total: number) => void,
): Promise<string> {
  // Tauri event を購読して進捗を上に流す
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<{ downloaded: number; total: number }>(
      "llama-download-progress",
      (e) => {
        onProgress(e.payload.downloaded, e.payload.total);
      },
    );
    const path = await invoke<string>("llama_download_model");
    return path;
  } finally {
    if (unlisten) unlisten();
  }
}

/** llama-server を起動して /health が ready になるまで待つ。冪等。 */
export async function startLlamaServer(): Promise<string> {
  return await invoke<string>("llama_start_server");
}

/** llama-server を停止(プロセス kill)。 */
export async function stopLlamaServer(): Promise<void> {
  await invoke("llama_stop_server");
}

/**
 * フォルダをローカル LLM で分析 → AnalysisOutcome を返す。
 * Claude 版 (`analyzeFolderToScreenMap`) と同じ戻り値型。
 */
export async function analyzeFolderToScreenMapLocal(
  folder: string,
  language: Language,
): Promise<AnalysisOutcome> {
  const M = t(language).claude;
  const start = Date.now();

  // 1. llama-server を ready 状態に(冪等なので毎回呼んで OK)
  try {
    await startLlamaServer();
  } catch (err) {
    throw new Error(
      `llama-server start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Tauri command で llama-server に POST、生 content(JSON 文字列のはず)を受取り
  let content: string;
  try {
    content = await invoke<string>("llama_analyze", {
      folder,
      userPrompt: USER_PROMPT_TEMPLATE(folder),
      systemPrompt: buildSystemPrompt(language),
      schema: JSON.stringify(RESPONSE_SCHEMA),
    });
  } catch (err) {
    throw new Error(M.analyzeFailed(err instanceof Error ? err.message : String(err)));
  }

  // 3. content を JSON として解釈(直接 parse → ダメなら extract で救済)
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const extracted = extractJsonFromString(content);
    if (extracted === null) {
      throw new Error(M.notJson("could not extract JSON", content.slice(0, 500)));
    }
    parsed = extracted;
  }

  if (!isScreenMapResult(parsed)) {
    throw new Error(M.noNodesEdges(JSON.stringify(parsed).slice(0, 1000)));
  }

  // 4. Claude 版と同じ正規化を通す(language で cleanup を分岐)
  const sanitizedScreens: ScreenMapResult = normalizeAndSanitizeScreenMap(
    parsed,
    language,
  );

  return {
    screens: sanitizedScreens,
    costUsd: 0, // ローカル LLM は無料
    durationMs: Date.now() - start,
  };
}
