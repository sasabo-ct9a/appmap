/**
 * ノーコード経験者向け技術用語辞書(機能拡張 G、§10.5.7 + §3.3 実装)。
 *
 * 目的:
 *   Inspector 本文に AI が出してきた専門用語を hover で解説する。CLAUDE.md
 *   §3.3「ノーコード経験者の言葉で話す」のため、必ず Bubble / Notion / Glide
 *   の対応概念を併記する(analogy フィールド)。
 *
 * 含める基準(ノーコード経験者にとって):
 *   - 「概念は分かるが、実装が見えていない」ものは brief だけ薄く説明
 *   - 「言葉自体を見たことがない」ものは brief + analogy で深め
 *   - Bubble/Notion で 1:1 対応概念があるものを優先(語彙地図を伸ばさない)
 *
 * 含めない:
 *   - "ノーコード語" トグル ON のとき AI 本文に出ないはずの専門用語
 *     (bodyNoCode 側で既に翻訳されているはず)
 *   - 一般語(画面、ボタン、データ など)
 *
 * 注意:
 *   key は本文に「そのまま部分文字列として現れる」ものにする。「データベース」
 *   は OK だが「ルーティングテーブル」のような長い複合語はキーにせず、構成要素
 *   (「ルーティング」)を入れて部分マッチで拾う。
 */
export type GlossaryEntry = {
  /** 1 行で簡潔に説明(15-30 字目安)。 */
  brief: string;
  /** Bubble / Notion / Glide での対応概念。 */
  analogy: string;
};

export const TECH_TERM_GLOSSARY: Record<string, GlossaryEntry> = {
  API: {
    brief: "外部サービスとデータをやり取りする通信窓口",
    analogy: "Bubble の API Connector / Notion の Integrations と同じ役割",
  },
  データベース: {
    brief: "データを保存しておく場所。一覧・追加・編集の対象",
    analogy: "Bubble の Data Type / Notion の Database そのもの",
  },
  認証: {
    brief: "ユーザーが本人かを確かめるログインの仕組み",
    analogy: "Bubble の User account / Notion の Workspace member 周りと同じ",
  },
  ルーティング: {
    brief: "どの URL でどの画面を出すかを決める対応表",
    analogy: "Bubble の Page navigation / Notion の Pages の階層に近い",
  },
  状態管理: {
    brief: "画面の「いまの状態」(開いてる / 入力中 / 読込中)を保持する仕組み",
    analogy: "Bubble の Custom states / Notion のページ内 toggle 状態に対応",
  },
  コンポーネント: {
    brief: "画面を組み立てる再利用可能な部品",
    analogy: "Bubble の Reusable element / Notion の Synced block に対応",
  },
  ライブラリ: {
    brief: "他人が作った便利機能セット。インストールして使う",
    analogy: "Bubble の Plugin / Notion の Integration アドオンに近い",
  },
  フレームワーク: {
    brief: "アプリの土台。決まった作法に従うことで早く作れる",
    analogy: "Bubble そのものがフレームワーク。Notion テンプレートも近い",
  },
  HTTP: {
    brief: "ブラウザとサーバが話すときの共通言語(プロトコル)",
    analogy: "Bubble の API Connector が裏で使ってる通信規格",
  },
  JSON: {
    brief: "データを「ラベル付きの箱」で表現するテキスト形式",
    analogy: "Bubble/Notion の Data セルを文字列にしたようなもの",
  },
  フック: {
    brief: "React 特有。コンポーネントに「機能を引っ掛ける」関数(useState 等)",
    analogy: "Bubble の Workflow にイベントを紐付けるイメージに近い",
  },
  バックエンド: {
    brief: "サーバー側の処理。データベース操作・認証などの裏側",
    analogy: "Bubble の Backend workflow / Notion の API 経由 server 処理に対応",
  },
  フロントエンド: {
    brief: "ユーザーが直接見る画面側の処理",
    analogy: "Bubble の Design tab / Notion の Page view 部分",
  },
  ビルド: {
    brief: "ソースコードを配布できる完成形に変換する作業",
    analogy: "Bubble の Deploy ボタン押下時に裏で起きていることに対応",
  },
  デプロイ: {
    brief: "完成したアプリをサーバーやストアに配置して公開する作業",
    analogy: "Bubble の Deploy to live / Notion の Publish to web に対応",
  },
  セッション: {
    brief: "ログイン後の「この人は本人」状態をしばらく保つ仕組み",
    analogy: "Bubble の Current User が継続している間の状態",
  },
  トークン: {
    brief: "認証済みであることを示す合言葉(文字列)",
    analogy: "Bubble の API key / Notion の Integration secret に近い",
  },
};

/**
 * 辞書のキーを文字列長の降順で取得(長いキーから先にマッチさせ、
 * 短いキーが長いキーの一部を切り刻んでしまうのを防ぐ)。
 */
export const GLOSSARY_KEYS_SORTED = Object.keys(TECH_TERM_GLOSSARY).sort(
  (a, b) => b.length - a.length,
);
