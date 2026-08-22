/**
 * 「大きいアプリ」の判定しきい値(UI の注意書き用)。
 *
 * 分析マップも コードチェックも、アプリが大きいほど「全部を見た結果」ではなく
 * 「主要な一部を見た結果」になる(マップ = 主要ファイルからの AI 要約、コードチェック =
 * 上限内で読めたソースの走査)。過信を避けるため、規模が一定以上のときだけ
 * 控えめな注意書きを添える。その境界がこの値。
 *
 * 使う数はそれぞれ違うが(マップ = 意味のあるファイル総数 fileCount、コードチェック =
 * 実際に読んだソース数 files_scanned)、どちらもアプリ規模に比例するので同じ目安で判定する。
 * 厳密なしきい値ではなく体感優先のヒント。
 */
export const LARGE_APP_FILE_THRESHOLD = 500;

export function isLargeApp(fileCount: number | null | undefined): boolean {
  return typeof fileCount === "number" && fileCount >= LARGE_APP_FILE_THRESHOLD;
}
