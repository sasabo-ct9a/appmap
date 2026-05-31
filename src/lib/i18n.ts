/**
 * v0.1.6 機能拡張:UI を日本語 / 英語に切替できるようにする。
 *
 * 設計方針:
 *   - 外部 i18n ライブラリは入れない(KISS、CLAUDE.md §7)
 *   - 1 つの TRANSLATIONS オブジェクトに全 UI 文字列を集約 → 翻訳漏れが見つけやすい
 *   - 各コンポーネントは `t(language)` で自分のキーを取り出す(型補完が効く)
 *   - 補間が要る箇所は関数で書く(`(args) => string`)
 *   - language の永続化は storage.ts 側
 *
 * 翻訳スコープ(2026-05-30 Option B 確定):
 *   - UI chrome(本ファイル) + AI プロンプト(claudeCli.ts の SYSTEM_PROMPT)
 *   - 既存の localStorage 履歴は触らない(日本語データは日本語のまま、再分析で英語化可能)
 */

export type Language = "ja" | "en";

export type Translations = {
  ui: {
    spinnerLabel: string;
    folderPickerTitle: string;
  };
  header: {
    noCodeLabel: string;
    noCodeAriaLabel: string;
    languageAriaLabel: string;
  };
  app: {
    pickFolder: string;
    analyzing: string;
    resetToSample: string;
    summaryBadge: string;
    errorPrefix: string;
    statusChecking: string;
    statusSetupIncomplete: string;
    statusLoginIncomplete: string;
    statusClaudeReady: (version: string) => string;
    statusAnalyzing: (folder: string, fileCount: number | null, elapsed: number) => string;
    statusAiMap: (screens: number, links: number, costPart: string, folder: string) => string;
    statusDone: string;
    statusSelected: (folder: string, fileCount: number | null) => string;
    costPart: (cost: number) => string;
    reAnalyzeConfirmTitle: string;
    reAnalyzeConfirmBody: (lastCost: number) => string;
  };
  tabBar: {
    tabsAriaLabel: string;
    closeAriaLabel: (label: string) => string;
  };
  history: {
    button: (count: number) => string;
    buttonAriaLabel: string;
    justNow: string;
    minutesAgo: (n: number) => string;
    hoursAgo: (n: number) => string;
    daysAgo: (n: number) => string;
    screens: (n: number) => string;
    removeAriaLabel: (label: string) => string;
  };
  canvas: {
    mapAriaLabel: string;
    edgesAriaLabel: string;
    nodesAriaLabel: string;
    planeAriaLabel: (label: string) => string;
    planeLabel: (depth: number) => string;
  };
  nodeTile: {
    entryPointBadge: string;
  };
  inspector: {
    panelAriaLabel: string;
    closeAriaLabel: string;
    entryPointHint: string;
    descriptionLabel: string;
    relatedLabel: string;
    filesLabel: string;
    dataLabel: string;
    hintLabel: string;
    safetyEasy: string;
    safetyRisky: string;
    safetyNeutral: string;
  };
  setupWizard: {
    title: string;
    progress: (done: number) => string;
    stepDone: string;
    detailsLogSummary: string;
    step1Title: string;
    step1Description: string;
    step1ActionLabel: string;
    step1Hint: string;
    step2Title: string;
    step2Description: string;
    step2InstallLabel: string;
    step2InstallingLabel: string;
    step2HintNeedNode: string;
    step2HintTime: string;
    pathLagHeader: string;
    pathLagIntro: string;
    pathLagBullet1: string;
    pathLagBullet2Prefix: string;
    pathLagBullet2Suffix: string;
    pathLagBullet3Prefix: string;
    pathLagBullet3Suffix: string;
    eaccesHeader: string;
    eaccesBody: string;
    eaccesPasteHint: string;
    eaccesFooter: string;
    step3Title: string;
    step3Description: string;
    step3DoneDetail: string;
    step3LoggingInLabel: string;
    step3LoginLabel: string;
    step3HintNeedClaude: string;
    step3HintReady: string;
    finalHint: string;
    errorEacces: string;
    errorNetwork: string;
    errorProxy: string;
    errorEngine: string;
    errorRegistry: string;
    errorGeneric: string;
  };
  claude: {
    notAuthenticated: string;
    analyzeFailed: (msg: string) => string;
    notJson: (msg: string, preview: string) => string;
    noNodesEdges: (detail: string) => string;
    structuredOutputPreview: (text: string) => string;
    resultPreview: (text: string) => string;
    resultPreviewTyped: (typeName: string, text: string) => string;
  };
};

const JA: Translations = {
  ui: {
    spinnerLabel: "読み込み中",
    folderPickerTitle: "コードフォルダを選択",
  },
  header: {
    noCodeLabel: "ノーコード語",
    noCodeAriaLabel: "ノーコード語切替",
    languageAriaLabel: "言語切替",
  },
  app: {
    pickFolder: "フォルダを選ぶ",
    analyzing: "分析中…",
    resetToSample: "サンプルに戻す",
    summaryBadge: "サマリー",
    errorPrefix: "エラー:",
    statusChecking: "Claude CLI を確認中…",
    statusSetupIncomplete: "セットアップを完了してください(上の案内を参照)",
    statusLoginIncomplete: "Claude にログインしてください(上の案内を参照)",
    statusClaudeReady: (version) =>
      `Claude CLI 検出 (${version}) — サンプルマップ表示中、フォルダを選んで実分析`,
    statusAnalyzing: (folder, fileCount, elapsed) =>
      `分析中: ${folder} (${fileCount} ファイル) — 経過 ${elapsed} 秒`,
    statusAiMap: (screens, links, costPart, folder) =>
      `AI 生成マップ表示中: ${screens} 画面 / ${links} リンク${costPart}(${folder})`,
    statusDone: "完了",
    statusSelected: (folder, fileCount) =>
      `選択中: ${folder} (${fileCount} ファイル)`,
    costPart: (cost) => ` / コスト $${cost.toFixed(4)}`,
    reAnalyzeConfirmTitle: "再分析の確認",
    reAnalyzeConfirmBody: (lastCost) =>
      `同じフォルダの再分析になります。前回 $${lastCost.toFixed(4)} 消費しました。再実行しますか?`,
  },
  tabBar: {
    tabsAriaLabel: "開いている分析タブ",
    closeAriaLabel: (label) => `${label} のタブを閉じる`,
  },
  history: {
    button: (count) => `履歴 (${count}) ▾`,
    buttonAriaLabel: "分析履歴",
    justNow: "たった今",
    minutesAgo: (n) => `${n} 分前`,
    hoursAgo: (n) => `${n} 時間前`,
    daysAgo: (n) => `${n} 日前`,
    screens: (n) => `${n} 画面`,
    removeAriaLabel: (label) => `${label} を履歴から削除`,
  },
  canvas: {
    mapAriaLabel: "アプリ構造マップ",
    edgesAriaLabel: "リンク線",
    nodesAriaLabel: "画面一覧",
    planeAriaLabel: (label) => `${label} 層`,
    planeLabel: (depth) => {
      if (depth === 0) return "メイン";
      if (depth === 1) return "サブ";
      if (depth === 2) return "詳細";
      return "深層";
    },
  },
  nodeTile: {
    entryPointBadge: "▶ まずここ",
  },
  inspector: {
    panelAriaLabel: "画面の詳細パネル",
    closeAriaLabel: "閉じる",
    entryPointHint: "▶ この画面から理解するとアプリ全体が掴みやすいです",
    descriptionLabel: "説明",
    relatedLabel: "リンク先",
    filesLabel: "対応ファイル",
    dataLabel: "使うデータ",
    hintLabel: "変更目安",
    safetyEasy: "変更しやすい",
    safetyRisky: "影響大",
    safetyNeutral: "影響を確認",
  },
  setupWizard: {
    title: "AppMap を使う準備",
    progress: (done) => `${done} / 3 完了`,
    stepDone: "完了",
    detailsLogSummary: "詳細ログ(コピー可)",
    step1Title: "Node.js",
    step1Description: "AppMap が裏で使うプログラムの土台です",
    step1ActionLabel: "Node.js を入手",
    step1Hint:
      "ボタンを押すと nodejs.org が開きます。LTS をインストールしたら、AppMap をいったん閉じて再起動してください。",
    step2Title: "Claude Code CLI",
    step2Description: "AppMap と Claude を繋ぐツール",
    step2InstallLabel: "インストール",
    step2InstallingLabel: "インストール中…",
    step2HintNeedNode: "(先に Node.js を入れてください)",
    step2HintTime: "30 秒〜数分かかります。",
    pathLagHeader:
      "⚠ インストールは完了しましたが、AppMap からまだ Claude Code が見えません",
    pathLagIntro:
      "npm のグローバルパス反映に時間がかかっていることがあります。下記のいずれかを試してください:",
    pathLagBullet1: "AppMap をいったん閉じて再起動",
    pathLagBullet2Prefix: "ターミナルで ",
    pathLagBullet2Suffix:
      " が動くか確認(動かなければ別シェルを開いて再試行)",
    pathLagBullet3Prefix: "",
    pathLagBullet3Suffix: " の出力が PATH に含まれているか確認",
    eaccesHeader: "⚠ 権限エラー(Mac)",
    eaccesBody:
      "Mac の権限の都合で、自動インストールに失敗しました。ターミナルを開いて、以下を",
    eaccesPasteHint: "コピペして",
    eaccesFooter: "完了したら AppMap を再起動してください。",
    step3Title: "Claude にログイン",
    step3Description: "ブラウザで Claude Pro / Max アカウントを認証",
    step3DoneDetail: "ログイン済み",
    step3LoggingInLabel: "ブラウザで認証中…",
    step3LoginLabel: "ログイン",
    step3HintNeedClaude: "(先に Claude Code CLI を入れてください)",
    step3HintReady:
      "ボタンを押すとブラウザが開きます。Anthropic のログイン画面で Claude Pro / Max アカウントを認証してください。",
    finalHint:
      "ここまで完了したら、「フォルダを選ぶ」が使えるようになります。",
    errorEacces:
      "Mac の権限で書き込めません。下のコマンドをターミナルで実行してください。",
    errorNetwork:
      "ネットワークに繋がっていません。Wi-Fi / 有線 / VPN を確認して、もう一度試してください。",
    errorProxy:
      "Proxy 経由のネットワークでブロックされています。会社・学校ならネット管理者に確認するか、`npm config set proxy <url>` を試してください。",
    errorEngine:
      "Node.js のバージョンが合いません。nodejs.org から最新の LTS を入れ直してください。",
    errorRegistry:
      "npm レジストリの認証で弾かれました。`npm logout` のあと再試行するか、private registry 設定を確認してください。",
    errorGeneric:
      "想定外のエラーです。下のメッセージをコピーして作者に共有してください。",
  },
  claude: {
    notAuthenticated:
      "Claude に認証されていません。ターミナルで `claude auth login` を実行してください。",
    analyzeFailed: (msg) => `claude analyze 失敗: ${msg}`,
    notJson: (msg, preview) =>
      `応答が JSON として解釈できません: ${msg}\n\nstdout (先頭 500 文字): ${preview}`,
    noNodesEdges: (detail) => `応答に nodes / edges が見当たらない:\n${detail}`,
    structuredOutputPreview: (text) =>
      `structured_output (先頭 1000 文字):\n${text}`,
    resultPreview: (text) => `result (先頭 1000 文字):\n${text}`,
    resultPreviewTyped: (typeName, text) =>
      `result (型: ${typeName}):\n${text}`,
  },
};

const EN: Translations = {
  ui: {
    spinnerLabel: "Loading",
    folderPickerTitle: "Pick a code folder",
  },
  header: {
    noCodeLabel: "Plain words",
    noCodeAriaLabel: "Toggle plain-words mode",
    languageAriaLabel: "Toggle language",
  },
  app: {
    pickFolder: "Pick folder",
    analyzing: "Analyzing…",
    resetToSample: "Back to sample",
    summaryBadge: "SUMMARY",
    errorPrefix: "Error:",
    statusChecking: "Checking Claude CLI…",
    statusSetupIncomplete:
      "Please finish setup (see the guide above)",
    statusLoginIncomplete:
      "Please sign in to Claude (see the guide above)",
    statusClaudeReady: (version) =>
      `Claude CLI detected (${version}) — showing sample map. Pick a folder for a real analysis.`,
    statusAnalyzing: (folder, fileCount, elapsed) =>
      `Analyzing: ${folder} (${fileCount} files) — ${elapsed}s elapsed`,
    statusAiMap: (screens, links, costPart, folder) =>
      `AI map: ${screens} screens / ${links} links${costPart} (${folder})`,
    statusDone: "Done",
    statusSelected: (folder, fileCount) =>
      `Selected: ${folder} (${fileCount} files)`,
    costPart: (cost) => ` / cost $${cost.toFixed(4)}`,
    reAnalyzeConfirmTitle: "Re-analyze?",
    reAnalyzeConfirmBody: (lastCost) =>
      `This will re-analyze the same folder. Last run cost $${lastCost.toFixed(4)}. Proceed?`,
  },
  tabBar: {
    tabsAriaLabel: "Open analysis tabs",
    closeAriaLabel: (label) => `Close tab ${label}`,
  },
  history: {
    button: (count) => `History (${count}) ▾`,
    buttonAriaLabel: "Analysis history",
    justNow: "just now",
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    screens: (n) => `${n} screens`,
    removeAriaLabel: (label) => `Remove ${label} from history`,
  },
  canvas: {
    mapAriaLabel: "App structure map",
    edgesAriaLabel: "Links",
    nodesAriaLabel: "Screens",
    planeAriaLabel: (label) => `${label} layer`,
    planeLabel: (depth) => {
      if (depth === 0) return "Main";
      if (depth === 1) return "Sub";
      if (depth === 2) return "Detail";
      return "Deep";
    },
  },
  nodeTile: {
    entryPointBadge: "▶ Start here",
  },
  inspector: {
    panelAriaLabel: "Screen detail panel",
    closeAriaLabel: "Close",
    entryPointHint:
      "▶ Start here to grasp the whole app's structure",
    descriptionLabel: "Description",
    relatedLabel: "Related",
    filesLabel: "Files",
    dataLabel: "Data used",
    hintLabel: "Change hint",
    safetyEasy: "Easy to change",
    safetyRisky: "High impact",
    safetyNeutral: "Check impact",
  },
  setupWizard: {
    title: "Getting AppMap ready",
    progress: (done) => `${done} / 3 done`,
    stepDone: "done",
    detailsLogSummary: "Details (copyable)",
    step1Title: "Node.js",
    step1Description: "The runtime AppMap uses behind the scenes",
    step1ActionLabel: "Get Node.js",
    step1Hint:
      "Clicking the button opens nodejs.org. After installing the LTS, please close AppMap and reopen it.",
    step2Title: "Claude Code CLI",
    step2Description: "The bridge between AppMap and Claude",
    step2InstallLabel: "Install",
    step2InstallingLabel: "Installing…",
    step2HintNeedNode: "(Install Node.js first)",
    step2HintTime: "Takes 30 seconds to a few minutes.",
    pathLagHeader:
      "⚠ Install finished, but AppMap still doesn't see Claude Code",
    pathLagIntro:
      "npm's global path may take a moment to register. Try one of the following:",
    pathLagBullet1: "Close AppMap and reopen it",
    pathLagBullet2Prefix: "Run ",
    pathLagBullet2Suffix:
      " in a terminal to confirm it works (if not, open a new shell and retry)",
    pathLagBullet3Prefix: "Check whether the output of ",
    pathLagBullet3Suffix: " is on your PATH",
    eaccesHeader: "⚠ Permission error (Mac)",
    eaccesBody:
      "macOS permissions blocked the automatic install. Open Terminal and",
    eaccesPasteHint: "paste",
    eaccesFooter:
      "After it finishes, please restart AppMap.",
    step3Title: "Sign in to Claude",
    step3Description:
      "Authorize your Claude Pro / Max account in the browser",
    step3DoneDetail: "Signed in",
    step3LoggingInLabel: "Authorizing in browser…",
    step3LoginLabel: "Sign in",
    step3HintNeedClaude: "(Install Claude Code CLI first)",
    step3HintReady:
      "Clicking the button opens the browser. Authorize your Claude Pro / Max account on the Anthropic sign-in page.",
    finalHint:
      'Once this is done, "Pick folder" becomes available.',
    errorEacces:
      "macOS permissions can't write here. Run the command below in Terminal.",
    errorNetwork:
      "No network connection. Check Wi-Fi / Ethernet / VPN and try again.",
    errorProxy:
      "Blocked by a proxy. If you're on a corporate or school network, ask your admin, or try `npm config set proxy <url>`.",
    errorEngine:
      "Your Node.js version doesn't fit. Install the latest LTS from nodejs.org.",
    errorRegistry:
      "npm registry rejected the auth. Try `npm logout` and retry, or check your private registry config.",
    errorGeneric:
      "Unexpected error. Please copy the message below and share it with the author.",
  },
  claude: {
    notAuthenticated:
      "Not signed in to Claude. Run `claude auth login` in your terminal.",
    analyzeFailed: (msg) => `claude analyze failed: ${msg}`,
    notJson: (msg, preview) =>
      `Response is not valid JSON: ${msg}\n\nstdout (first 500 chars): ${preview}`,
    noNodesEdges: (detail) =>
      `Response is missing nodes / edges:\n${detail}`,
    structuredOutputPreview: (text) =>
      `structured_output (first 1000 chars):\n${text}`,
    resultPreview: (text) => `result (first 1000 chars):\n${text}`,
    resultPreviewTyped: (typeName, text) =>
      `result (type: ${typeName}):\n${text}`,
  },
};

const TRANSLATIONS: Record<Language, Translations> = { ja: JA, en: EN };

/** language を渡すと、そのコンポーネント用に文字列辞書スライスを返す。型補完あり。 */
export function t(language: Language): Translations {
  return TRANSLATIONS[language];
}

/** 不正な値が入っても "ja" に fallback する安全ユーティリティ。 */
export function asLanguage(v: unknown): Language {
  return v === "en" ? "en" : "ja";
}
