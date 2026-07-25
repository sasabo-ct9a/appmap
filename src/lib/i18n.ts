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
    detailLevelAriaLabel: string;
    detailLevelSimple: string;
    detailLevelDetailed: string;
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
  specDoc: {
    // UI(ボタン・モーダル)
    buttonLabel: string;
    modalTitle: string;
    audienceLabel: string;
    audienceEngineer: string;
    audienceNoCode: string;
    audienceEndUser: string;
    copyButton: string;
    copied: string;
    printButton: string;
    closeButton: string;
    previewHeading: string;
    // 仕様書本体のセクション見出し・固定語彙
    docTitle: string;
    emptyAppSummary: string;
    sectionOverview: string;
    sectionScreenList: string;
    sectionScreenDetail: string;
    sectionTransitions: string;
    tableNum: string;
    tableName: string;
    tableRole: string;
    fieldRole: string;
    fieldEntryPoint: string;
    fieldDescription: string;
    fieldDataUsed: string;
    fieldFiles: string;
    fieldRelatedScreens: string;
    fieldChangeHint: string;
  };
  sidebar: {
    navHomeTitle: string;
    navHomeSubtitle: string;
    navImpactTitle: string;
    navImpactSubtitle: string;
    navChecklistTitle: string;
    navChecklistSubtitle: string;
    sectionProjectInfo: string;
    projectOverview: string;
    projectData: string;
    projectSettings: string;
    sectionOpenProjects: string;
    closeTabAria: (label: string) => string;
    tabSearchPlaceholder: string;
    tabSearchNoMatch: string;
    tipTitle: string;
    tipLine1: string;
    tipLine2: string;
  };
  topBar: {
    easyTitle: string;
    easySubtitle: string;
    detailTitle: string;
    detailSubtitle: string;
    exportButton: string;
    exportMenuSpecDoc: string;
    exportMenuShareHTML: string;
    exportShareHTMLDialogTitle: string;
    exportShareHTMLSuccess: string;
    exportShareHTMLFailure: string;
    engineToggleAria: string;
    engineTooltipClaude: string;
    engineTooltipLocal: string;
    engineLabelClaude: string;
    engineLabelLocal: string;
    engineNoteClaude: string;
    engineNoteLocal: string;
  };
  intro: {
    heading: string;
    subheading: string;
    countsScreens: string;
    countsLinks: string;
  };
  featureCard: {
    badgeMain: string;
    badgeSupport: string;
  };
  notes: {
    sectionTitle: string;
    tagsLabel: string;
    tagLater: string;
    tagImportant: string;
    tagQuestion: string;
    tagReviewed: string;
    tagClear: string;
    tagHintImportant: string;
    tagHintLater: string;
    tagHintQuestion: string;
    tagHintReviewed: string;
    memoLabel: string;
    memoPlaceholder: string;
    hint: string;
  };
  qa: {
    sectionTitle: string;
    hint: string;
    placeholder: string;
    sendButton: string;
    sending: string;
    clearButton: string;
    clearConfirm: string;
    emptyState: string;
    errorGeneric: string;
    suggestionsLabel: string;
    suggestionWhat: string;
    suggestionRisk: string;
    suggestionRename: string;
    youLabel: string;
    aiLabel: string;
  };
  diff: {
    toggleLabel: string;
    toggleAvailable: string;
    noChanges: string;
    addedNodesLabel: (n: number) => string;
    removedNodesLabel: (n: number) => string;
    addedEdgesLabel: (n: number) => string;
    removedEdgesLabel: (n: number) => string;
    addedBadge: string;
    removedBadge: string;
    removedSectionTitle: string;
    edgeArrow: string;
    bidiArrow: string;
  };
  localLLM: {
    // エンジン切替 UI(設定モーダル)
    settingsButtonAria: string;
    settingsTitle: string;
    engineLabel: string;
    engineClaude: string;
    engineLocal: string;
    engineClaudeNote: string;
    engineLocalNote: string;
    // v0.1.8:外部エディタ選択(Inspector の関連ファイルクリック時)
    editorLabel: string;
    editorNote: string;
    editorCursor: string;
    editorVscode: string;
    editorSystem: string;
    editorOpenFailedTitle: string;
    editorOpenFailedBody: string;
    // セットアップウィザード
    wizardTitle: string;
    wizardProgress: (done: number) => string;
    stepDone: string;
    step1Title: string;
    step1Description: string;
    step1ManualHint: string;
    step1NotFound: string;
    step1ShowPath: string;
    step1Recheck: string;
    step2Title: string;
    step2Description: string;
    step2DownloadLabel: string;
    step2DownloadingLabel: string;
    step2Progress: (downloadedMB: number, totalMB: number) => string;
    step2NeedBinary: string;
    finalHint: string;
    statusUsingLocal: (modelName: string) => string;
    errorBinaryMissing: string;
    errorDownloadFailed: (msg: string) => string;
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
    detailLevelAriaLabel: "詳細レベル切替",
    detailLevelSimple: "簡素",
    detailLevelDetailed: "詳細",
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
      `分析中: ${folder} (${fileCount} ファイル) — 経過 ${formatElapsed(elapsed, "ja")}`,
    statusAiMap: (screens, links, costPart, folder) =>
      `AI 生成マップ表示中: ${screens} 要素 / ${links} リンク${costPart}(${folder})`,
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
    screens: (n) => `${n} 要素`,
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
    entryPointBadge: "まずここ",
  },
  inspector: {
    panelAriaLabel: "画面の詳細パネル",
    closeAriaLabel: "閉じる",
    entryPointHint: "この画面から理解するとアプリ全体が掴みやすいです",
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
  specDoc: {
    buttonLabel: "仕様書を作成",
    modalTitle: "アプリ仕様書",
    audienceLabel: "想定読者",
    audienceEngineer: "エンジニア",
    audienceNoCode: "ノーコード経験者",
    audienceEndUser: "エンドユーザー",
    copyButton: "Markdown をコピー",
    copied: "コピーしました",
    printButton: "PDF で保存",
    closeButton: "閉じる",
    previewHeading: "プレビュー",
    docTitle: "アプリ仕様書",
    emptyAppSummary: "(AI が判断できませんでした)",
    sectionOverview: "概要",
    sectionScreenList: "画面一覧",
    sectionScreenDetail: "画面詳細",
    sectionTransitions: "画面遷移",
    tableNum: "#",
    tableName: "画面名",
    tableRole: "役割",
    fieldRole: "役割",
    fieldEntryPoint: "起点画面",
    fieldDescription: "説明",
    fieldDataUsed: "使うデータ",
    fieldFiles: "関連ファイル",
    fieldRelatedScreens: "関連画面",
    fieldChangeHint: "変更目安",
  },
  sidebar: {
    navHomeTitle: "ホーム",
    navHomeSubtitle: "このアプリでできること",
    navImpactTitle: "変更の影響を確認",
    navImpactSubtitle: "どこを変えると影響する?",
    navChecklistTitle: "リリース前チェック",
    navChecklistSubtitle: "本番に出せる状態か診断",
    sectionProjectInfo: "プロジェクト情報",
    projectOverview: "概要",
    projectData: "データ",
    projectSettings: "設定",
    sectionOpenProjects: "開いているプロジェクト",
    closeTabAria: (label) => `${label} を閉じる`,
    tabSearchPlaceholder: "検索",
    tabSearchNoMatch: "該当なし",
    tipTitle: "3 分で理解するコツ",
    tipLine1: "まずは「できること」から",
    tipLine2: "全体像をつかみましょう",
  },
  topBar: {
    easyTitle: "かんたんモード",
    easySubtitle: "ノーコード向け",
    detailTitle: "詳細モード",
    detailSubtitle: "技術者向け",
    exportButton: "エクスポート",
    exportMenuSpecDoc: "仕様書として出力",
    exportMenuShareHTML: "共有 HTML として出力",
    exportShareHTMLDialogTitle: "共有 HTML の保存先を選ぶ",
    exportShareHTMLSuccess: "共有 HTML を保存しました",
    exportShareHTMLFailure: "共有 HTML の保存に失敗しました",
    engineToggleAria: "AI エンジン切替",
    engineTooltipClaude: "Claude を使用中 — クリックでローカル LLM に切替",
    engineTooltipLocal: "ローカル LLM を使用中 — クリックで Claude に切替",
    engineLabelClaude: "Claude",
    engineLabelLocal: "ローカル LLM",
    engineNoteClaude: "クラウド利用中",
    engineNoteLocal: "ローカル動作",
  },
  intro: {
    heading: "このアプリでできること",
    subheading:
      "分析したアプリの構造を可視化できます。各要素をクリックすると詳細が右に開きます。",
    countsScreens: "要素",
    countsLinks: "つながり",
  },
  featureCard: {
    badgeMain: "主要機能",
    badgeSupport: "サポート機能",
  },
  notes: {
    sectionTitle: "メモとタグ",
    tagsLabel: "タグ(自分専用の目印)",
    tagLater: "あとで確認",
    tagImportant: "重要",
    tagQuestion: "疑問",
    tagReviewed: "確認済み",
    tagClear: "解除",
    tagHintImportant: "本番に出す前に必ず見直したい要素に付ける",
    tagHintLater: "今は流したが、時間があるときに戻ってきたい要素",
    tagHintQuestion: "何をしているか分からない・要確認の要素",
    tagHintReviewed: "内容を理解して問題なしと確認できた要素",
    memoLabel: "メモ",
    memoPlaceholder: "気になったこと・理解したこと・次に確認することを書き残せます",
    hint: "この画面についてのメモ。あなたのローカルにだけ保存されます。",
  },
  qa: {
    sectionTitle: "AI に聞く",
    hint: "この画面について自由に聞けます。用語を知らなくて OK。",
    placeholder: "例:これって何のために必要? もし消したらどうなる?",
    sendButton: "送信",
    sending: "AI が考えています…",
    clearButton: "履歴を消す",
    clearConfirm: "この画面の質問履歴を消してもいい?",
    emptyState: "まだ質問はありません。下の入力欄から気軽に聞いてみましょう。",
    errorGeneric: "AI から回答を取得できませんでした。少し待って再試行してください。",
    suggestionsLabel: "よくある質問",
    suggestionWhat: "この画面は何のためにあるの?",
    suggestionRisk: "ここを変えるとどこに影響する?",
    suggestionRename: "この画面をノーコードで例えるなら?",
    youLabel: "あなた",
    aiLabel: "AI",
  },
  diff: {
    toggleLabel: "前回との差分",
    toggleAvailable: "前回の分析と比較して表示",
    noChanges: "前回と変わっていません",
    addedNodesLabel: (n) => `追加された画面 ${n}`,
    removedNodesLabel: (n) => `消えた画面 ${n}`,
    addedEdgesLabel: (n) => `追加されたつながり ${n}`,
    removedEdgesLabel: (n) => `消えたつながり ${n}`,
    addedBadge: "追加",
    removedBadge: "削除",
    removedSectionTitle: "今回消えた画面(前回分析にはあった)",
    edgeArrow: "→",
    bidiArrow: "↔",
  },
  localLLM: {
    settingsButtonAria: "設定",
    settingsTitle: "設定",
    engineLabel: "AI エンジン",
    engineClaude: "Claude(クラウド)",
    engineLocal: "ローカル LLM(オフライン)",
    engineClaudeNote: "高品質。Claude Pro/Max 契約が必要、1 回 ~$0.6。",
    engineLocalNote: "オフライン・無料。初回 4.5 GB DL が必要、品質はやや劣る。",
    editorLabel: "外部エディタ",
    editorNote:
      "Inspector で関連ファイルをクリックしたとき、どのエディタで開くかを選びます。",
    editorCursor: "Cursor(AI コーディング標準)",
    editorVscode: "VS Code",
    editorSystem: "OS のデフォルト(エクスプローラ等)",
    editorOpenFailedTitle: "エディタを起動できませんでした",
    editorOpenFailedBody:
      "選んだエディタが未インストール、または OS にプロトコルが登録されていません。設定で別のエディタに切り替えてください。",
    wizardTitle: "ローカル LLM の準備",
    wizardProgress: (done) => `${done} / 2 完了`,
    stepDone: "完了",
    step1Title: "llama-server バイナリ",
    step1Description: "ローカル LLM を動かす本体",
    step1ManualHint:
      "現状(Phase 1)は手動配置が必要です。llama.cpp の release から llama-server.exe を落として、下のパスに置いてください。",
    step1NotFound: "llama-server が見つかりません",
    step1ShowPath: "配置先パスを開く",
    step1Recheck: "再確認",
    step2Title: "AI モデル(Qwen 2.5-Coder 14B、約 8.4 GB)",
    step2Description: "コード分析用の AI モデル",
    step2DownloadLabel: "ダウンロード開始",
    step2DownloadingLabel: "ダウンロード中…",
    step2Progress: (downloadedMB, totalMB) =>
      `${downloadedMB} MB / ${totalMB > 0 ? totalMB + " MB" : "? MB"}`,
    step2NeedBinary: "(先に llama-server を配置してください)",
    finalHint:
      "両方完了したら「フォルダを選ぶ」が使えるようになります。",
    statusUsingLocal: (modelName) => `ローカル LLM 使用中(${modelName})`,
    errorBinaryMissing:
      "llama-server バイナリが見つかりません。手動配置パスに置いてください。",
    errorDownloadFailed: (msg) => `ダウンロードに失敗しました: ${msg}`,
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
    detailLevelAriaLabel: "Toggle detail level",
    detailLevelSimple: "Simple",
    detailLevelDetailed: "Detailed",
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
      `Analyzing: ${folder} (${fileCount} files) — ${formatElapsed(elapsed, "en")} elapsed`,
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
    entryPointBadge: "Start here",
  },
  inspector: {
    panelAriaLabel: "Screen detail panel",
    closeAriaLabel: "Close",
    entryPointHint:
      "Start here to grasp the whole app's structure",
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
  specDoc: {
    buttonLabel: "Generate spec",
    modalTitle: "App specification",
    audienceLabel: "Audience",
    audienceEngineer: "Engineer",
    audienceNoCode: "Non-coder",
    audienceEndUser: "End user",
    copyButton: "Copy Markdown",
    copied: "Copied",
    printButton: "Save as PDF",
    closeButton: "Close",
    previewHeading: "Preview",
    docTitle: "App Specification",
    emptyAppSummary: "(Not determined by AI)",
    sectionOverview: "Overview",
    sectionScreenList: "Screen list",
    sectionScreenDetail: "Screen details",
    sectionTransitions: "Screen transitions",
    tableNum: "#",
    tableName: "Screen",
    tableRole: "Role",
    fieldRole: "Role",
    fieldEntryPoint: "Entry point",
    fieldDescription: "Description",
    fieldDataUsed: "Data used",
    fieldFiles: "Related files",
    fieldRelatedScreens: "Related screens",
    fieldChangeHint: "Change hint",
  },
  sidebar: {
    navHomeTitle: "Home",
    navHomeSubtitle: "What this app can do",
    navImpactTitle: "Impact preview",
    navImpactSubtitle: "See what a change affects",
    navChecklistTitle: "Pre-release check",
    navChecklistSubtitle: "Ready to ship?",
    sectionProjectInfo: "Project info",
    projectOverview: "Overview",
    projectData: "Data",
    projectSettings: "Settings",
    sectionOpenProjects: "Open projects",
    closeTabAria: (label) => `Close ${label}`,
    tabSearchPlaceholder: "Search",
    tabSearchNoMatch: "No match",
    tipTitle: "Understand in 3 minutes",
    tipLine1: "Start with what it does,",
    tipLine2: "then grasp the whole picture.",
  },
  topBar: {
    easyTitle: "Easy mode",
    easySubtitle: "For no-code users",
    detailTitle: "Detail mode",
    detailSubtitle: "For engineers",
    exportButton: "Export",
    exportMenuSpecDoc: "Export as spec doc",
    exportMenuShareHTML: "Export as shareable HTML",
    exportShareHTMLDialogTitle: "Save shareable HTML",
    exportShareHTMLSuccess: "Shareable HTML saved",
    exportShareHTMLFailure: "Failed to save shareable HTML",
    engineToggleAria: "Switch AI engine",
    engineTooltipClaude: "Using Claude — click to switch to local LLM",
    engineTooltipLocal: "Using local LLM — click to switch to Claude",
    engineLabelClaude: "Claude",
    engineLabelLocal: "Local LLM",
    engineNoteClaude: "Cloud in use",
    engineNoteLocal: "Local mode",
  },
  intro: {
    heading: "What this app can do",
    subheading:
      "See the analyzed app's structure at a glance. Click any piece for details on the right.",
    countsScreens: "pieces",
    countsLinks: "links",
  },
  featureCard: {
    badgeMain: "Main feature",
    badgeSupport: "Support feature",
  },
  notes: {
    sectionTitle: "Notes & tags",
    tagsLabel: "Tag (your own marker)",
    tagLater: "Check later",
    tagImportant: "Important",
    tagQuestion: "Question",
    tagReviewed: "Reviewed",
    tagClear: "Clear",
    tagHintImportant: "For screens you must double-check before shipping",
    tagHintLater: "Skimmed for now — come back when you have time",
    tagHintQuestion: "Not sure what this does — needs a closer look",
    tagHintReviewed: "You've read it through and confirmed it's fine",
    memoLabel: "Memo",
    memoPlaceholder:
      "Jot down what caught your eye, what you now understand, or what to revisit.",
    hint: "Notes for this screen. Saved locally on your machine only.",
  },
  qa: {
    sectionTitle: "Ask AI",
    hint: "Ask anything about this screen — no jargon needed.",
    placeholder: "e.g. Why is this needed? What breaks if I remove it?",
    sendButton: "Send",
    sending: "AI is thinking…",
    clearButton: "Clear history",
    clearConfirm: "Clear the Q&A history for this screen?",
    emptyState: "No questions yet. Ask anything from the box below.",
    errorGeneric: "Couldn't get an answer from the AI. Please wait and try again.",
    suggestionsLabel: "Common questions",
    suggestionWhat: "What is this screen for?",
    suggestionRisk: "What breaks if I change this?",
    suggestionRename: "How would you describe this in no-code terms?",
    youLabel: "You",
    aiLabel: "AI",
  },
  diff: {
    toggleLabel: "Diff since last",
    toggleAvailable: "Compare against the previous analysis",
    noChanges: "No changes since last analysis",
    addedNodesLabel: (n) => `Added screens: ${n}`,
    removedNodesLabel: (n) => `Removed screens: ${n}`,
    addedEdgesLabel: (n) => `Added links: ${n}`,
    removedEdgesLabel: (n) => `Removed links: ${n}`,
    addedBadge: "New",
    removedBadge: "Gone",
    removedSectionTitle: "Removed screens (were in the previous analysis)",
    edgeArrow: "→",
    bidiArrow: "↔",
  },
  localLLM: {
    settingsButtonAria: "Settings",
    settingsTitle: "Settings",
    engineLabel: "AI engine",
    engineClaude: "Claude (cloud)",
    engineLocal: "Local LLM (offline)",
    engineClaudeNote:
      "Highest quality. Requires Claude Pro/Max, ~$0.6 per analysis.",
    engineLocalNote:
      "Offline and free. Needs a one-time 4.5 GB download. Quality is lower.",
    editorLabel: "External editor",
    editorNote:
      "Choose which editor opens when you click a related file in the Inspector.",
    editorCursor: "Cursor (AI-coding standard)",
    editorVscode: "VS Code",
    editorSystem: "OS default (Explorer / Finder)",
    editorOpenFailedTitle: "Couldn't launch the editor",
    editorOpenFailedBody:
      "The selected editor isn't installed, or its protocol isn't registered with the OS. Switch to a different editor in Settings.",
    wizardTitle: "Set up local LLM",
    wizardProgress: (done) => `${done} / 2 done`,
    stepDone: "done",
    step1Title: "llama-server binary",
    step1Description: "The runtime that drives the local LLM",
    step1ManualHint:
      "Phase 1: please place the binary manually. Download llama-server from llama.cpp releases and place it at the path below.",
    step1NotFound: "llama-server not found",
    step1ShowPath: "Open destination folder",
    step1Recheck: "Recheck",
    step2Title: "AI model (Qwen 2.5-Coder 14B, ~8.4 GB)",
    step2Description: "The model used for code analysis",
    step2DownloadLabel: "Start download",
    step2DownloadingLabel: "Downloading…",
    step2Progress: (downloadedMB, totalMB) =>
      `${downloadedMB} MB / ${totalMB > 0 ? totalMB + " MB" : "? MB"}`,
    step2NeedBinary: "(Place the llama-server binary first)",
    finalHint:
      'Once both steps are done, "Pick folder" becomes available.',
    statusUsingLocal: (modelName) => `Using local LLM (${modelName})`,
    errorBinaryMissing:
      "llama-server binary not found. Please place it at the manual install path.",
    errorDownloadFailed: (msg) => `Download failed: ${msg}`,
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

/**
 * v0.1.7 経過時間を読みやすくフォーマット。
 *   - < 60 秒: 「45 秒」/ "45s"
 *   - >= 60 秒: 「1 分 20 秒」/ "1m 20s"
 * 分析中ステータスで 60 秒超えると秒数だけだと分かりにくい問題への対応。
 */
function formatElapsed(seconds: number, language: Language): string {
  if (seconds < 60) {
    return language === "ja" ? `${seconds} 秒` : `${seconds}s`;
  }
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return language === "ja" ? `${min} 分 ${sec} 秒` : `${min}m ${sec}s`;
}

/**
 * v0.1.7 多言語対応:LocalizedText(string | {ja, en})から現在の UI 言語の
 * 文字列を取り出す。
 *   - string(旧 v0.1.6 以前のデータ):そのまま返す(言語問わず同じ文字)
 *   - {ja, en}(v0.1.7+ の AI 出力):lang のキーを返す。欠落時は反対側 → 空文字
 *
 * 言語切替時はこの関数が render 時に呼ばれるので、再分析なしで JA/EN 即切替が成立する。
 */
export function pickLocalized(
  text: string | { ja: string; en: string } | undefined,
  language: Language,
): string {
  if (text === undefined || text === null) return "";
  if (typeof text === "string") return text;
  return text[language] || text[language === "ja" ? "en" : "ja"] || "";
}
