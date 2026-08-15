import { analyzeFolderToScreenMap, type AnalysisOutcome } from "./claudeCli";
import { analyzeFolderToScreenMapLocal } from "./llamaClient";
import { buildFolderStructureMap } from "./fallbackMap";
import type { Engine } from "./storage";
import type { Language } from "./i18n";

/**
 * v0.1.7 AI エンジン振分け器。
 *
 * App.tsx は engine の値に関係なく `analyzeFolder(folder, language, engine)` を
 * 1 つだけ呼べばよく、内部で claudeCli or llamaClient へ dispatch する。
 *
 * 戻り値型(AnalysisOutcome)は両エンジン共通なので、UI 側は engine を意識せず済む。
 *
 * 最優先要件「必ずマップを出す」(Codex 2026-08-15):AI 分析が失敗(タイムアウト・
 * JSON 破損・nodes/edges 無し 等)しても「読み込めない」で終わらせず、フォルダ構成から
 * 作る簡易マップにフォールバックする。ただし認証切れだけは、UI にログイン導線を出させる
 * ため再 throw する(フォールバックの簡易マップでは解決できないため)。
 */
export async function analyzeFolder(
  folder: string,
  language: Language,
  engine: Engine,
): Promise<AnalysisOutcome> {
  try {
    const outcome =
      engine === "local"
        ? await analyzeFolderToScreenMapLocal(folder, language)
        : await analyzeFolderToScreenMap(folder, language);
    // 型検証は通っても nodes 0 件なら「マップ無し」と同じ(Codex #9)。フォールバックへ。
    if (!outcome.screens || outcome.screens.nodes.length === 0) {
      throw new Error("empty map: 0 nodes");
    }
    return outcome;
  } catch (primaryErr) {
    const msg =
      primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    // 認証切れは「ターミナルで claude auth login して」の導線を UI に出させたいので
    //   フォールバックで隠さず再 throw する。
    if (/認証|auth ?login|authenticat|unauthorized/i.test(msg)) {
      throw primaryErr;
    }
    // それ以外は「必ずマップを出す」ためフォルダ構成の簡易マップを返す。実エラーは
    //   デバッグのため console に残す(簡易マップ側で「AI 自動生成に失敗」と明示済み)。
    console.error("[AppMap] 分析失敗、フォルダ構成フォールバックへ:", primaryErr);
    return buildFolderStructureMap(folder);
  }
}
