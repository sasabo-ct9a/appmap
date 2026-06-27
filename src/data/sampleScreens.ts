import type { ScreenNode, ScreenEdge, Bilingual } from "../types/screen";
import type { Language } from "../lib/i18n";

/**
 * Phase 2 用のハードコードサンプル(全 5 ノード + 4 エッジ)。
 *
 * v0.1.7 多言語化:**1 つの bilingual サンプル** に統合。
 *   - 全テキストフィールドが Bilingual({ja, en})オブジェクト
 *   - getSampleScreens(language) は **引数 language を無視** して bilingual サンプルを返す
 *     (旧 API シグネチャを保つだけ、内部で表示時に pickLocalized で言語を選ぶ)
 *
 * 配置方針(機能拡張で N 階層対応 + 単一 SVG レイアウトに合わせて修正):
 *   - depth 0(主フロー)= フォルダ選択 / 分析中 / マップ俯瞰
 *   - depth 1(サブ画面)= 詳細パネル / 設定
 *   - y 座標は MapCanvas 側で depth から自動計算するので、ここで指定する y 値は意味無し。
 */

type SampleData = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  appSummary: Bilingual;
};

/** Bilingual テキストを作るショートカット。 */
const bi = (ja: string, en: string): Bilingual => ({ ja, en });

const sampleScreensBilingual: SampleData = {
  appSummary: bi(
    "これは「AI で作ったアプリ」を 1 枚の地図に変換するデスクトップアプリです。フォルダを選ぶと AI が画面構造を読み取り、画面同士の繋がりとそれぞれの説明をマップ表示します。",
    "This is a desktop app that turns an AI-built application into a single map. Pick a folder and the AI reads the screen structure, then renders the screens and the links between them with short descriptions.",
  ),
  nodes: [
    {
      id: 1,
      label: bi("フォルダ選択", "Pick folder"),
      userIntent: bi("アプリを選ぶ", "Pick an app"),
      isEntryPoint: true,
      position: { x: 50, y: 50 },
      depth: 0,
      detailLevel: 0,
      subActions: [
        bi("フォルダを選ぶ", "Open a folder"),
        bi("ドラッグで渡す", "Drop a folder"),
        bi("最近使ったフォルダ", "Recent folders"),
        bi("読み込み開始", "Start reading"),
      ],
      detail: {
        title: bi("フォルダ選択画面", "Pick-folder screen"),
        body: bi(
          "ローカルのフォルダを選んで AppMap に読み込ませる入り口。Tauri のファイル API でディレクトリを開く。",
          "Entry point. Pick a local folder and hand it to AppMap. Uses the Tauri file API to open the directory.",
        ),
        bodyNoCode: bi(
          "解析したいフォルダを選んで AppMap に読ませる入口の画面です。Bubble や Notion でファイルをアップロードする感覚に似ていますが、ファイル単体ではなくフォルダ全体を渡します。",
          "The starting screen, where you pick a folder for AppMap to read. It's similar to uploading a file in Bubble or Notion, except you hand over a whole folder, not a single file.",
        ),
        files: ["src/lib/folderPicker.ts", "src/components/ui/Button.tsx"],
        dataUsed: [
          bi("フォルダのパス", "Folder path"),
          bi("中のファイル一覧", "File list inside"),
        ],
        changeHint: {
          safety: "easy",
          note: bi(
            "ボタンの文言や見た目は変えやすい。ファイル選択ダイアログそのものに手を入れるのは少し慎重に。",
            "Button text and styling are easy to change. Be a bit careful when touching the file-picker dialog itself.",
          ),
        },
      },
    },
    {
      id: 2,
      label: bi("分析中", "Analyzing"),
      userIntent: bi("AI を待つ", "Wait for the AI"),
      position: { x: 330, y: 50 },
      depth: 0,
      detailLevel: 1,
      subActions: [
        bi("進捗を見る", "Watch progress"),
        bi("経過時間を確認", "Check elapsed"),
        bi("コストを見る", "See the cost"),
        bi("キャンセル", "Cancel"),
      ],
      detail: {
        title: bi("分析中(ローディング)", "Analysis (loading)"),
        body: bi(
          "選んだフォルダを Claude API に送り、マップ用の JSON が返ってくるのを待つ画面。プログレスと推定残り時間を表示。",
          "Sends the chosen folder to the Claude API and waits for the map JSON to come back. Shows progress and an estimated time remaining.",
        ),
        bodyNoCode: bi(
          "選んだフォルダを AI に渡し、画面構造の解析結果が返ってくるのを待つ画面です。進行中はぐるぐるマークと経過時間が表示されます。Bubble でワークフローが走っているときの待ち画面と同じ役割です。",
          "After you hand a folder to the AI, this screen waits for the analysis to come back. While it runs you see a spinner and the elapsed time. It's the same role as the waiting screen while a workflow runs in Bubble.",
        ),
        files: [
          "src/lib/claudeCli.ts",
          "src-tauri/src/lib.rs",
          "src/components/ui/Spinner.tsx",
        ],
        dataUsed: [
          bi("分析の進捗", "Analysis progress"),
          bi("経過時間", "Elapsed time"),
          bi("コスト", "Cost"),
        ],
        changeHint: {
          safety: "neutral",
          note: bi(
            "表示の見た目は変えやすいですが、AI との通信ロジックを触ると全画面に影響します。",
            "The visuals are easy to tweak, but touching the AI communication logic affects every screen.",
          ),
        },
      },
    },
    {
      id: 3,
      label: bi("マップ俯瞰", "Map overview"),
      userIntent: bi("全体を見渡す", "See the whole picture"),
      position: { x: 610, y: 50 },
      depth: 0,
      detailLevel: 0,
      subActions: [
        bi("画面をクリック", "Click a screen"),
        bi("つながりを辿る", "Follow links"),
        bi("ズーム", "Zoom"),
        bi("全体を再表示", "Reset view"),
        bi("仕様書を作る", "Make a spec"),
      ],
      detail: {
        title: bi("マップ俯瞰画面(中心)", "Map overview (center)"),
        body: bi(
          "AppMap の本体。画面ノードと関係線で構造を一望できる。気になるノードをクリックすると詳細パネルが開く。",
          "The core of AppMap. See the whole structure as screen nodes and relation lines. Click a node to open the detail panel.",
        ),
        bodyNoCode: bi(
          "アプリ全体の画面構成を 1 枚で見渡せるメイン画面です。気になる画面をクリックすると右側に詳細が開きます。Bubble や Notion でアプリ全体を俯瞰するときの感覚に近い使い方になります。",
          "The main screen where you see the whole app's structure on one page. Click any screen and a detail panel opens on the right. The feeling is close to surveying an app at a glance in Bubble or Notion.",
        ),
        files: [
          "src/components/canvas/MapCanvas.tsx",
          "src/components/canvas/NodeTile.tsx",
          "src/components/canvas/Edge.tsx",
          "src/App.tsx",
        ],
        dataUsed: [
          bi("画面の一覧", "Screen list"),
          bi("画面同士の繋がり", "Links between screens"),
          bi("アプリ概要", "App summary"),
        ],
        changeHint: {
          safety: "risky",
          note: bi(
            "ここはアプリの中心。レイアウトを変えると他のほぼ全画面に影響します。",
            "This is the heart of the app. Layout changes here ripple into almost every other screen.",
          ),
        },
      },
    },
    {
      id: 4,
      label: bi("詳細パネル", "Detail panel"),
      userIntent: bi("1 画面を深く見る", "Look at one screen in depth"),
      position: { x: 190, y: 230 },
      depth: 1,
      detailLevel: 1,
      subActions: [
        bi("説明を読む", "Read the description"),
        bi("関わるファイル", "See related files"),
        bi("つながる画面", "See linked screens"),
        bi("変更の影響を見る", "Check impact"),
        bi("閉じる", "Close panel"),
      ],
      detail: {
        title: bi("画面の詳細パネル", "Screen detail panel"),
        body: bi(
          "ノードクリックで右端に開くパネル。タイトル・説明・関連ノードを表示。閉じるとマップ俯瞰に戻る。",
          "Opens on the right when you click a node. Shows title, description, and related nodes. Close it to go back to the overview.",
        ),
        bodyNoCode: bi(
          "メインマップで選んだ画面の中身を、画面の右側に詳しく表示するパネルです。説明・関わるファイル・つながる画面が見えます。Bubble や Notion で項目を選んだときに右側に出る詳細欄と同じ役割です。",
          "Shows the details of the screen you picked on the main map, on the right side. You see a description, the files involved, and the screens it links to. It plays the same role as the detail pane that opens on the right when you select an item in Bubble or Notion.",
        ),
        files: [
          "src/components/inspector/InspectorPanel.tsx",
          "src/components/ui/Tooltip.tsx",
          "src/lib/glossary.ts",
        ],
        dataUsed: [
          bi("選んだ画面の詳細", "Detail for the picked screen"),
          bi("つながる画面の一覧", "Related screens"),
          bi("対応ファイル", "Matching files"),
        ],
        changeHint: {
          safety: "easy",
          note: bi(
            "パネル内の文言や項目順は安全に変えられます。",
            "Wording and item order inside the panel are safe to change.",
          ),
        },
      },
    },
    {
      id: 5,
      label: bi("設定", "Settings"),
      userIntent: bi("アプリを設定する", "Tweak the app"),
      position: { x: 470, y: 230 },
      depth: 1,
      detailLevel: 2,
      subActions: [
        bi("言語を切り替え", "Switch language"),
        bi("ノーコード語 ON/OFF", "Plain-words mode"),
        bi("AI エンジン切替", "Switch engine"),
        bi("分析履歴を見る", "View history"),
      ],
      detail: {
        title: bi("設定画面", "Settings screen"),
        body: bi(
          "ノーコード語切替トグル、API キー、表示テーマなど。マップから出入りする独立した画面。",
          "Plain-words toggle, API key, display theme, and so on. A standalone screen you enter and leave from the map.",
        ),
        bodyNoCode: bi(
          "アプリ全体の挙動を調整する画面です。ノーコード語の ON / OFF、表示テーマ、過去の分析履歴などを切り替えられます。Bubble や Notion の設定画面に相当する場所です。",
          "A screen for adjusting how the whole app behaves. You can toggle plain-words mode, switch the display theme, browse past analyses, and so on. It's the same kind of place as the settings page in Bubble or Notion.",
        ),
        files: [
          "src/components/layout/Header.tsx",
          "src/lib/storage.ts",
          "src/components/ui/HistoryDropdown.tsx",
        ],
        dataUsed: [
          bi("ノーコード語モードの ON / OFF", "Plain-words mode on/off"),
          bi("分析の履歴", "Analysis history"),
        ],
        changeHint: {
          safety: "neutral",
          note: bi(
            "設定項目を増減すると、その項目を使う画面にも合わせて手を入れる必要があります。",
            "Adding or removing settings means you also have to touch the screens that use them.",
          ),
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

/**
 * v0.1.7 多言語化:bilingual サンプルを返す(language 引数は後方互換のため残置するが内部では未使用)。
 * 表示時は `pickLocalized(text, language)` で各テキストの言語版を取り出す。
 */
export function getSampleScreens(_language: Language): SampleData {
  return sampleScreensBilingual;
}
