import type { ScreenNode, ScreenEdge } from "../types/screen";
import type { Language } from "../lib/i18n";

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
 *
 * v0.1.6: JA / EN の 2 言語版を持ち、UI 言語に応じて選択する。
 *   - getSampleScreens(language) で取得
 *   - ノード id・座標・depth・edges は両言語で完全同一(構造は不変)
 *   - 翻訳されるのはテキストフィールドだけ(label / userIntent / title / body / 等)
 */

type SampleData = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  appSummary: string;
};

const sampleScreensJa: SampleData = {
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

const sampleScreensEn: SampleData = {
  appSummary:
    "This is a desktop app that turns an AI-built application into a single map. Pick a folder and the AI reads the screen structure, then renders the screens and the links between them with short descriptions.",
  nodes: [
    {
      id: 1,
      label: "Pick folder",
      userIntent: "Pick an app",
      isEntryPoint: true,
      position: { x: 50, y: 50 },
      depth: 0,
      detail: {
        title: "Pick-folder screen",
        body: "Entry point. Pick a local folder and hand it to AppMap. Uses the Tauri file API to open the directory.",
        bodyNoCode:
          "The starting screen, where you pick a folder for AppMap to read. It's similar to uploading a file in Bubble or Notion, except you hand over a whole folder, not a single file.",
        files: [
          "src/lib/folderPicker.ts",
          "src/components/ui/Button.tsx",
        ],
        dataUsed: ["Folder path", "File list inside"],
        changeHint: {
          safety: "easy",
          note: "Button text and styling are easy to change. Be a bit careful when touching the file-picker dialog itself.",
        },
      },
    },
    {
      id: 2,
      label: "Analyzing",
      userIntent: "Wait for the AI",
      position: { x: 330, y: 50 },
      depth: 0,
      detail: {
        title: "Analysis (loading)",
        body: "Sends the chosen folder to the Claude API and waits for the map JSON to come back. Shows progress and an estimated time remaining.",
        bodyNoCode:
          "After you hand a folder to the AI, this screen waits for the analysis to come back. While it runs you see a spinner and the elapsed time. It's the same role as the waiting screen while a workflow runs in Bubble.",
        files: [
          "src/lib/claudeCli.ts",
          "src-tauri/src/lib.rs",
          "src/components/ui/Spinner.tsx",
        ],
        dataUsed: ["Analysis progress", "Elapsed time", "Cost"],
        changeHint: {
          safety: "neutral",
          note: "The visuals are easy to tweak, but touching the AI communication logic affects every screen.",
        },
      },
    },
    {
      id: 3,
      label: "Map overview",
      userIntent: "See the whole picture",
      position: { x: 610, y: 50 },
      depth: 0,
      detail: {
        title: "Map overview (center)",
        body: "The core of AppMap. See the whole structure as screen nodes and relation lines. Click a node to open the detail panel.",
        bodyNoCode:
          "The main screen where you see the whole app's structure on one page. Click any screen and a detail panel opens on the right. The feeling is close to surveying an app at a glance in Bubble or Notion.",
        files: [
          "src/components/canvas/MapCanvas.tsx",
          "src/components/canvas/NodeTile.tsx",
          "src/components/canvas/Edge.tsx",
          "src/App.tsx",
        ],
        dataUsed: ["Screen list", "Links between screens", "App summary"],
        changeHint: {
          safety: "risky",
          note: "This is the heart of the app. Layout changes here ripple into almost every other screen.",
        },
      },
    },
    {
      id: 4,
      label: "Detail panel",
      userIntent: "Look at one screen in depth",
      position: { x: 190, y: 230 },
      depth: 1,
      detail: {
        title: "Screen detail panel",
        body: "Opens on the right when you click a node. Shows title, description, and related nodes. Close it to go back to the overview.",
        bodyNoCode:
          "Shows the details of the screen you picked on the main map, on the right side. You see a description, the files involved, and the screens it links to. It plays the same role as the detail pane that opens on the right when you select an item in Bubble or Notion.",
        files: [
          "src/components/inspector/InspectorPanel.tsx",
          "src/components/ui/Tooltip.tsx",
          "src/lib/glossary.ts",
        ],
        dataUsed: ["Detail for the picked screen", "Related screens", "Matching files"],
        changeHint: {
          safety: "easy",
          note: "Wording and item order inside the panel are safe to change.",
        },
      },
    },
    {
      id: 5,
      label: "Settings",
      userIntent: "Tweak the app",
      position: { x: 470, y: 230 },
      depth: 1,
      detail: {
        title: "Settings screen",
        body: "Plain-words toggle, API key, display theme, and so on. A standalone screen you enter and leave from the map.",
        bodyNoCode:
          "A screen for adjusting how the whole app behaves. You can toggle plain-words mode, switch the display theme, browse past analyses, and so on. It's the same kind of place as the settings page in Bubble or Notion.",
        files: [
          "src/components/layout/Header.tsx",
          "src/lib/storage.ts",
          "src/components/ui/HistoryDropdown.tsx",
        ],
        dataUsed: ["Plain-words mode on/off", "Analysis history"],
        changeHint: {
          safety: "neutral",
          note: "Adding or removing settings means you also have to touch the screens that use them.",
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

/** v0.1.6: UI 言語に応じてサンプルマップを返す。 */
export function getSampleScreens(language: Language): SampleData {
  return language === "en" ? sampleScreensEn : sampleScreensJa;
}
