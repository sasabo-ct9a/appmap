import { invoke } from "@tauri-apps/api/core";

/**
 * v0.1.8:Inspector の関連ファイルをクリックで外部エディタ / OS デフォルトで開く。
 * Rust コマンド `open_in_editor` を薄くラップ。
 *
 * 想定エディタ:
 *   - "cursor" : Cursor(AI コーディング標準)、cursor://file/... プロトコル
 *   - "vscode" : VS Code、vscode://file/... プロトコル
 *   - "system" : OS デフォルト(Windows Explorer / Finder / xdg-open)
 *
 * URL scheme は該当エディタが未インストールだと OS 側でエラーダイアログが出る。
 * その場合は例外にはならないので、呼び出し側は「開いたか?」を保証できない前提。
 */
export type EditorChoice = "cursor" | "vscode" | "system";

export type OpenInEditorArgs = {
  editor: EditorChoice;
  /** 分析対象のフォルダ絶対パス(null = サンプル時、その場合は呼ばない)*/
  folder: string;
  /** フォルダ相対のファイルパス */
  file: string;
  /** 該当行(オプション、あれば URL の末尾に `:line` として付与)*/
  line?: number;
};

export async function openInEditor(args: OpenInEditorArgs): Promise<void> {
  await invoke("open_in_editor", {
    editor: args.editor,
    folder: args.folder,
    file: args.file,
    line: args.line ?? null,
  });
}
