import type { ScreenNode, ScreenEdge } from "../types/screen";

/**
 * Phase 2 用のハードコードサンプル(全 5 ノード + 4 エッジ)。
 *
 * 題材は AppMap 自身の Screens マップ。Codex feature review のクイックウィン
 * 5 つを反映:appSummary / userIntent / isEntryPoint / dataUsed / changeHint。
 *
 * 配置方針(機能拡張で N 階層対応 + 単一 SVG レイアウトに合わせて修正):
 *   - depth 0(主フロー)= フォルダ選択 / 分析中 / マップ俯瞰
 *   - depth 1(サブ画面)= 詳細パネル / 設定
 *   - y 座標は MapCanvas 側で depth から自動計算するので、ここで指定する y 値は
 *     互換のための残骸(意味は無い)。x と depth のみが効く。
 */
export const sampleScreens: {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  appSummary: string;
} = {
  appSummary:
    "これは「AI で作ったアプリ」を 1 枚の地図に変換するデスクトップアプリです。フォルダを選ぶと AI が画面構造を読み取り、画面同士の繋がりとそれぞれの説明をマップ表示します。",
  nodes: [
    {
      id: 1,
      label: "フォルダ選択",
      userIntent: "アプリを選ぶ",
      isEntryPoint: true,
      position: { x: 50, y: 50 },
      depth: 0,
      detail: {
        title: "フォルダ選択画面",
        body: "ローカルのフォルダを選んで AppMap に読み込ませる入り口。Tauri のファイル API でディレクトリを開く。",
        bodyNoCode:
          "解析したいフォルダを選んで AppMap に読ませる入口の画面です。Bubble や Notion でファイルをアップロードする感覚に似ていますが、ファイル単体ではなくフォルダ全体を渡します。",
        files: [
          "src/lib/folderPicker.ts",
          "src/components/ui/Button.tsx",
        ],
        dataUsed: ["フォルダのパス", "中のファイル一覧"],
        changeHint: {
          safety: "easy",
          note: "ボタンの文言や見た目は変えやすい。ファイル選択ダイアログそのものに手を入れるのは少し慎重に。",
        },
      },
    },
    {
      id: 2,
      label: "分析中",
      userIntent: "AI を待つ",
      position: { x: 330, y: 50 },
      depth: 0,
      detail: {
        title: "分析中(ローディング)",
        body: "選んだフォルダを Claude API に送り、マップ用の JSON が返ってくるのを待つ画面。プログレスと推定残り時間を表示。",
        bodyNoCode:
          "選んだフォルダを AI に渡し、画面構造の解析結果が返ってくるのを待つ画面です。進行中はぐるぐるマークと経過時間が表示されます。Bubble でワークフローが走っているときの待ち画面と同じ役割です。",
        files: [
          "src/lib/claudeCli.ts",
          "src-tauri/src/lib.rs",
          "src/components/ui/Spinner.tsx",
        ],
        dataUsed: ["分析の進捗", "経過時間", "コスト"],
        changeHint: {
          safety: "neutral",
          note: "表示の見た目は変えやすいですが、AI との通信ロジックを触ると全画面に影響します。",
        },
      },
    },
    {
      id: 3,
      label: "マップ俯瞰",
      userIntent: "全体を見渡す",
      position: { x: 610, y: 50 },
      depth: 0,
      detail: {
        title: "マップ俯瞰画面(中心)",
        body: "AppMap の本体。画面ノードと関係線で構造を一望できる。気になるノードをクリックすると詳細パネルが開く。",
        bodyNoCode:
          "アプリ全体の画面構成を 1 枚で見渡せるメイン画面です。気になる画面をクリックすると右側に詳細が開きます。Bubble や Notion でアプリ全体を俯瞰するときの感覚に近い使い方になります。",
        files: [
          "src/components/canvas/MapCanvas.tsx",
          "src/components/canvas/NodeTile.tsx",
          "src/components/canvas/Edge.tsx",
          "src/App.tsx",
        ],
        dataUsed: ["画面の一覧", "画面同士の繋がり", "アプリ概要"],
        changeHint: {
          safety: "risky",
          note: "ここはアプリの中心。レイアウトを変えると他のほぼ全画面に影響します。",
        },
      },
    },
    {
      id: 4,
      label: "詳細パネル",
      userIntent: "1 画面を深く見る",
      position: { x: 190, y: 230 },
      depth: 1,
      detail: {
        title: "画面の詳細パネル",
        body: "ノードクリックで右端に開くパネル。タイトル・説明・関連ノードを表示。閉じるとマップ俯瞰に戻る。",
        bodyNoCode:
          "メインマップで選んだ画面の中身を、画面の右側に詳しく表示するパネルです。説明・関わるファイル・つながる画面が見えます。Bubble や Notion で項目を選んだときに右側に出る詳細欄と同じ役割です。",
        files: [
          "src/components/inspector/InspectorPanel.tsx",
          "src/components/ui/Tooltip.tsx",
          "src/lib/glossary.ts",
        ],
        dataUsed: ["選んだ画面の詳細", "つながる画面の一覧", "対応ファイル"],
        changeHint: {
          safety: "easy",
          note: "パネル内の文言や項目順は安全に変えられます。",
        },
      },
    },
    {
      id: 5,
      label: "設定",
      userIntent: "アプリを設定する",
      position: { x: 470, y: 230 },
      depth: 1,
      detail: {
        title: "設定画面",
        body: "ノーコード語切替トグル、API キー、表示テーマなど。マップから出入りする独立した画面。",
        bodyNoCode:
          "アプリ全体の挙動を調整する画面です。ノーコード語の ON / OFF、表示テーマ、過去の分析履歴などを切り替えられます。Bubble や Notion の設定画面に相当する場所です。",
        files: [
          "src/components/layout/Header.tsx",
          "src/lib/storage.ts",
          "src/components/ui/HistoryDropdown.tsx",
        ],
        dataUsed: ["ノーコード語モードの ON / OFF", "分析の履歴"],
        changeHint: {
          safety: "neutral",
          note: "設定項目を増減すると、その項目を使う画面にも合わせて手を入れる必要があります。",
        },
      },
    },
  ],
  edges: [
    { id: "1-2", from: 1, to: 2 },
    { id: "2-3", from: 2, to: 3 },
    { id: "3-4", from: 3, to: 4, bidirectional: true },
    { id: "3-5", from: 3, to: 5, bidirectional: true },
  ],
};
