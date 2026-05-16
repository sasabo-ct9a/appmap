import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";

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
 */
export async function pickFolderAndListFiles(): Promise<FolderPickResult | null> {
  const folder = await open({
    directory: true,
    multiple: false,
    title: "コードフォルダを選択",
  });
  if (folder === null) return null;

  const fileCount = await countFiles(folder);
  return { folder, fileCount };
}

async function countFiles(path: string): Promise<number> {
  let count = 0;
  const entries = await readDir(path);
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      count += await countFiles(`${path}/${entry.name}`);
    } else if (entry.isFile) {
      count += 1;
    }
  }
  return count;
}
