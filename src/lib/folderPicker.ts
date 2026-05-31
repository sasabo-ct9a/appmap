import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { t, type Language } from "./i18n";

/**
 * フォルダピッカー + ファイル一覧の再帰列挙(Phase 3 Step 3-2)。
 *
 * Tauri の plugin-dialog でフォルダピッカーを開き、ユーザー選択後に
 * plugin-fs で再帰的にファイル数をカウントして返す(UI 表示用)。
 *
 * Phase 3 Step 3-3 で Claude Code CLI に切替えたため、ファイル内容を
 * 事前読込みする必要はなくなった(claude が `--add-dir` で自分で読む agentic 方式)。
 * この関数は **フォルダパスとファイル数の取得** のみ担当。
 *
 * `node_modules` などの「内容を AI に見せる価値が低く、ファイル数が膨大」な
 * ディレクトリは事前にスキップして、ファイル数の表示が現実的な値になるように。
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target", // Rust build output
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".idea",
  ".vscode",
]);

export type FolderPickResult = {
  folder: string;
  fileCount: number;
};

/**
 * フォルダ選択ダイアログを開き、選んだフォルダ配下のファイル数を再帰カウントする。
 * ユーザーがキャンセルした場合は null を返す。
 *
 * v0.1.6: ダイアログタイトルを UI 言語に合わせて切替(EN モードで日本語が出ないように)。
 */
export async function pickFolderAndListFiles(
  language: Language = "ja",
): Promise<FolderPickResult | null> {
  const folder = await open({
    directory: true,
    multiple: false,
    title: t(language).ui.folderPickerTitle,
  });
  if (folder === null) return null;

  const fileCount = await countFiles(folder);
  return { folder, fileCount };
}

async function countFiles(path: string): Promise<number> {
  let count = 0;

  // readDir は fs:scope 外のパスや権限不足で例外を投げる。ファイル数表示は
  // あくまで補助情報なので、読めなかった枝は警告だけ残してスキップし、
  // 全体カウントは継続する(v0.1.0 配布後 partner フィードバック 2026-05-16 修正 2)。
  let entries;
  try {
    entries = await readDir(path);
  } catch (err) {
    console.warn(`[AppMap] readDir failed for ${path}:`, err);
    return 0;
  }

  for (const entry of entries) {
    if (entry.isDirectory) {
      // 明示スキップリスト
      if (SKIP_DIRS.has(entry.name)) continue;
      // ドット始まりディレクトリ(.vercel / .turbo / .nuxt / .svelte-kit / .git
      // / .next / .config 等)は AI 分析価値が低く、Tauri の fs:scope `$HOME/**`
      // glob も「ドット始まりにマッチしない」POSIX 慣習のため scope エラーの
      // 主要因。一律スキップで安全側に倒す。
      if (entry.name.startsWith(".")) continue;
      count += await countFiles(`${path}/${entry.name}`);
    } else if (entry.isFile) {
      count += 1;
    }
  }
  return count;
}
