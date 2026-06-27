import { analyzeFolderToScreenMap, type AnalysisOutcome } from "./claudeCli";
import { analyzeFolderToScreenMapLocal } from "./llamaClient";
import type { Engine } from "./storage";
import type { Language } from "./i18n";

/**
 * v0.1.7 AI エンジン振分け器。
 *
 * App.tsx は engine の値に関係なく `analyzeFolder(folder, language, engine)` を
 * 1 つだけ呼べばよく、内部で claudeCli or llamaClient へ dispatch する。
 *
 * 戻り値型(AnalysisOutcome)は両エンジン共通なので、UI 側は engine を意識せず済む。
 */
export async function analyzeFolder(
  folder: string,
  language: Language,
  engine: Engine,
): Promise<AnalysisOutcome> {
  if (engine === "local") {
    return analyzeFolderToScreenMapLocal(folder, language);
  }
  return analyzeFolderToScreenMap(folder, language);
}
