/**
 * Screens マップで描画するノードと関係性。
 *
 * - ScreenNode: 1 画面 = 1 ノード。位置はマップ上の絶対座標(SVG viewBox 内)。
 *   detail にはノードクリック時に Inspector Panel に表示する情報を持つ。
 * - ScreenEdge: 画面間の遷移。bidirectional=true なら両端に矢印
 *   (例: 詳細パネルを開く/閉じる、設定の出入り)。
 *
 * Phase 2 ではハードコード(`sampleScreens.ts`)。
 * Phase 3 で Claude API がこの形で JSON を返す想定 — 型を先に固めることで、
 * データ供給元(ハードコード → API)が変わっても UI 側に影響しない。
 *
 * detail に body と bodyNoCode を併記するのは §6 MVP「ノーコード語切替トグル」のため。
 * Bubble / Notion / Glide の用語に翻訳した版を bodyNoCode に持たせる
 * (§3.3「ノーコード経験者の言葉で話す」)。
 */
/**
 * 「変更しやすさ」のヒント(機能拡張クイックウィン 5)。
 *   - easy: 文言や表示順など、安全に変えやすい部分
 *   - neutral: 影響を考えれば変えられる
 *   - risky: 触ると他画面まで波及しやすい部分
 *
 * AI(Claude)が判断できなければ undefined のままで OK。
 */
export type ChangeHint = {
  safety: "easy" | "neutral" | "risky";
  note: string;
};

export type ScreenNode = {
  id: number;
  /** ノード矩形の中央に表示する短いラベル(画面名)。Body 1 サイズで描画される想定。 */
  label: string;
  /**
   * 機能拡張クイックウィン 2:ユーザー行動ラベル。技術的な画面名とは別に、
   * 「ここで何をするか」をユーザー目線の短いフレーズで表す(例:「ログインする」
   * 「状況を見る」)。10〜14 字目安。
   *
   * ノーコード語切替モード ON のとき、NodeTile はこれを優先表示する。
   * AI が判断できなければ undefined。
   */
  userIntent?: string;
  /**
   * 機能拡張クイックウィン 3:「最初に見るべき画面」マーカー。
   * マップ全体で 1 ノードだけ true にする(エントリーポイント)。
   * Claude が推定できなければ全ノード undefined。
   */
  isEntryPoint?: boolean;
  /** SVG 座標系での矩形の top-left。NodeTile はデフォルト 120w × 48h(§10.5.2)。 */
  position: { x: number; y: number };
  /**
   * ナビゲーション階層の深さ(Phase 3 polish v4 で追加)。
   * - 0 = 主フロー(最前面、フルサイズで描画)
   * - 1 = サブ画面(親から開く、奥に縮小して描画)
   * - 2 = 孫画面(さらに奥)
   * - 省略時は 0 とみなす(後方互換)
   *
   * 例: AppMap 自身なら「フォルダ選択 / 分析中 / マップ俯瞰」は depth 0、
   * 「詳細パネル / 設定」は depth 1(マップ俯瞰から開く子)。
   */
  depth?: number;
  /** ノードクリックで開く Inspector Panel に表示する詳細。 */
  detail: {
    title: string;
    body: string;
    bodyNoCode: string;
    /**
     * このノード(画面)に関係するファイルのパス(プロジェクトルート相対、
     * 区切りは forward slash)。Phase 3 機能拡張 C で追加。AI が判断できなければ
     * 省略可。最大 5 件目安(多すぎると認知負荷↑)。
     *
     * ノーコード経験者には「自分のアプリのこの画面が、コード上どこに当たるか」を
     * 一目で見せる手がかりになる。
     */
    files?: string[];
    /**
     * 機能拡張クイックウィン 4:この画面で扱っているデータの非技術名(例:
     * 「ユーザー情報」「予約情報」「商品リスト」)。最大 5 件目安。
     *
     * ノーコード経験者は「この画面はどの Data Type / Collection を使っているか」を
     * 知りたい。Bubble / Notion の Data Type に対応する概念。
     */
    dataUsed?: string[];
    /**
     * 機能拡張クイックウィン 5:変更しやすさ / 影響範囲のヒント。
     * AI が判断できれば設定、できなければ undefined。
     */
    changeHint?: ChangeHint;
  };
};

export type ScreenEdge = {
  /** "1-2" のような形式。React の key としても使える一意な識別子。 */
  id: string;
  from: number;
  to: number;
  /** true なら両端に矢印を描画。デフォルト(undefined)は from→to の片方向。 */
  bidirectional?: boolean;
};
