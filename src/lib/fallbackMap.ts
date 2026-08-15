import { invoke } from "@tauri-apps/api/core";
import type { AnalysisOutcome, ScreenMapResult } from "./claudeCli";
import type { Bilingual, ScreenNode } from "../types/screen";

/**
 * AI 分析が失敗したときの最終フォールバック:フォルダ構成から「必ず出る簡易マップ」を組む。
 *
 * 目的(最優先要件):AI が画面マップを生成できなくても「読み込めない」で終わらせない。
 *   「読み込めない=アプリの存在意義が無い」ため、少なくともフォルダの主要ディレクトリを
 *   ノードとして出す。
 *
 * 信頼性の原則(CLAUDE.md §6.6):これは AI 解析ではなく機械的なフォルダ列挙なので、
 *   appSummary と各ノード本文で「AI 自動生成に失敗した簡易版」と明示し、確定情報の
 *   ように見せない。
 */
export async function buildFolderStructureMap(
  folder: string,
): Promise<AnalysisOutcome> {
  let areas: string[] = [];
  try {
    areas = await invoke<string[]>("list_project_areas", { folder });
  } catch {
    areas = [];
  }

  const bi = (ja: string, en: string): Bilingual => ({ ja, en });

  const nodes: ScreenNode[] = [
    {
      id: 1,
      label: bi("このアプリ", "This app"),
      position: { x: 330, y: 40 },
      depth: 0,
      detailLevel: 0,
      isEntryPoint: true,
      detail: {
        title: bi("このアプリ", "This app"),
        body: bi(
          "AI が画面マップを自動生成できませんでした。以下はフォルダ構成から作った簡易マップです。",
          "The AI could not auto-generate a screen map. Below is a simple map built from the folder structure.",
        ),
        bodyNoCode: bi(
          "自動でマップを作れなかったので、フォルダの中身をそのまま並べています。もう一度分析するか、ローカル AI もお試しください。",
          "We couldn't build the map automatically, so we're just showing the folders. Try analyzing again, or use the Local AI.",
        ),
      },
    },
  ];

  const count = areas.length;
  areas.forEach((area, i) => {
    const x = count > 1 ? 40 + (560 * i) / (count - 1) : 330;
    nodes.push({
      id: i + 2,
      label: bi(area, area),
      position: { x, y: 220 },
      depth: 1,
      detailLevel: 1,
      detail: {
        title: bi(area, area),
        body: bi(
          `「${area}」フォルダ。中身はまだ解析していません。`,
          `The "${area}" folder. Its contents are not analyzed yet.`,
        ),
        bodyNoCode: bi(
          `「${area}」というまとまりがあります。詳しい中身はまだ読めていません。`,
          `There is a group called "${area}". Its details haven't been read yet.`,
        ),
      },
    });
  });

  const edges = areas.map((_, i) => ({
    id: `1-${i + 2}`,
    from: 1,
    to: i + 2,
  }));

  const screens: ScreenMapResult = {
    nodes,
    edges,
    appSummary: bi(
      "フォルダ構成から作った簡易マップです(AI による自動生成には失敗しました)。",
      "A simple map built from the folder structure (AI auto-generation failed).",
    ),
  };

  return { screens, costUsd: null, durationMs: null };
}
