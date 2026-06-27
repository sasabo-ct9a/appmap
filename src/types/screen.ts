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
 * v0.1.7 多言語対応:1 回の AI 分析で JA / EN の両方を持ち、UI 切替で再分析せず表示変更する。
 *   - 新規分析:Bilingual({ja, en} オブジェクト)で来る
 *   - 旧データ(v0.1.6 以前):string のまま入っている
 *   どちらでも動くよう LocalizedText = string | Bilingual の union とし、表示側は
 *   `pickLocalized(text, language)` で抽出する。
 */
export type Bilingual = { ja: string; en: string };
export type LocalizedText = string | Bilingual;

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
  note: LocalizedText;
};

export type ScreenNode = {
  id: number;
  /** ノード矩形の中央に表示する短いラベル(画面名)。Body 1 サイズで描画される想定。
   *  v0.1.7 多言語:Bilingual({ja, en})または旧 string。 */
  label: LocalizedText;
  /**
   * 機能拡張クイックウィン 2:ユーザー行動ラベル。技術的な画面名とは別に、
   * 「ここで何をするか」をユーザー目線の短いフレーズで表す(例:「ログインする」
   * 「状況を見る」)。10〜14 字目安。
   *
   * ノーコード語切替モード ON のとき、NodeTile はこれを優先表示する。
   * AI が判断できなければ undefined。
   * v0.1.7 多言語:Bilingual または旧 string。
   */
  userIntent?: LocalizedText;
  /**
   * 機能拡張クイックウィン 3:「最初に見るべき画面」マーカー。
   * マップ全体で 1 ノードだけ true にする(エントリーポイント)。
   * Claude が推定できなければ全ノード undefined。
   */
  isEntryPoint?: boolean;
  /**
   * v0.1.7 機能拡張:詳細レベル(ヘッダーの「簡素 / 標準 / 詳細」トグル連動)。
   *   - 0 = 必須レベル(主フロー)。常に表示。エントリーポイントや主要画面はここに置く
   *   - 1 = 標準レベル(サブ画面)。標準モード以降で表示。設定画面、詳細パネル等
   *   - 2 = 詳細レベル(モーダル / 状態遷移 / エラー画面 / 隠し機能)。詳細モードのみ表示
   * 省略時は 0(必ず表示)扱い。後方互換のため optional。
   * 表示フィルタは App.tsx 側で行う(1 回の分析データから 3 段切替可能)。
   */
  detailLevel?: 0 | 1 | 2;
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
  /**
   * v0.1.7 マインドマップ化:この画面に紐づく「短いアクションチップ」3〜7 個。
   * マップ上の主枝(この screen ノード)から放射状に伸びる葉として描画される。
   * 各要素は 6〜12 字目安の動詞句(例:「会話を始める」「履歴を見る」「音声入力」)。
   *
   * AI が判断できなければ undefined / 空配列。古いデータも optional なので壊れない。
   * 表示側は subActions が無ければ dataUsed をフォールバックに使う。
   * v0.1.7 多言語:各要素が Bilingual({ja,en})または旧 string。
   */
  subActions?: LocalizedText[];
  /** ノードクリックで開く Inspector Panel に表示する詳細。 */
  detail: {
    /** v0.1.7 多言語:Bilingual または旧 string。 */
    title: LocalizedText;
    body: LocalizedText;
    bodyNoCode: LocalizedText;
    /**
     * このノード(画面)に関係するファイルのパス(プロジェクトルート相対、
     * 区切りは forward slash)。Phase 3 機能拡張 C で追加。AI が判断できなければ
     * 省略可。最大 5 件目安(多すぎると認知負荷↑)。
     *
     * 言語非依存(パスはどちらの言語でも同じ)なので string[] のまま。
     */
    files?: string[];
    /**
     * 機能拡張クイックウィン 4:この画面で扱っているデータの非技術名(例:
     * 「ユーザー情報」「予約情報」「商品リスト」)。最大 5 件目安。
     *
     * v0.1.7 多言語:各要素が Bilingual または旧 string。
     */
    dataUsed?: LocalizedText[];
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
