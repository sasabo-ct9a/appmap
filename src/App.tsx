import { useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import Header from "./components/layout/Header";
import MapCanvas from "./components/canvas/MapCanvas";
import InspectorPanel from "./components/inspector/InspectorPanel";
import Button from "./components/ui/Button";
import Spinner from "./components/ui/Spinner";
import HistoryDropdown from "./components/ui/HistoryDropdown";
import SetupWizard from "./components/ui/SetupWizard";
import TabBar from "./components/ui/TabBar";
import { getSampleScreens } from "./data/sampleScreens";
import { pickFolderAndListFiles } from "./lib/folderPicker";
import {
  analyzeFolderToScreenMap,
  checkClaudeAvailable,
  checkNodeAvailable,
  normalizeAndSanitizeScreenMap,
  type ScreenMapResult,
} from "./lib/claudeCli";
import {
  loadStore,
  saveAnalysis,
  setCurrent,
  removeAnalysis,
  markLoginCompleted,
  saveDragOffsets,
  saveOpenTabs,
  saveLanguage,
  type StoredAnalysis,
} from "./lib/storage";
import { t, asLanguage, type Language } from "./lib/i18n";

/**
 * Phase 3 Step 3-5(polish 込み完成版):
 *
 * フォルダ選択 → Rust 経由で claude.exe を spawn → JSON で {nodes, edges} 受取り →
 * マップに反映。
 *
 * Step 3-5 polish 項目:
 *   - 起動時に Tauri command (`claude_check_version`) で CLI チェック、未検出なら案内
 *   - 分析中は Spinner + 経過秒数表示でユーザーに進行を見せる
 *   - 分析完了時に直近のコスト($X.XX)を表示 — Pro/Max 定額枠の感覚を掴める
 *   - 同じフォルダ再分析時は確認ダイアログ(誤操作 + 課金防止)
 *   - 「サンプルに戻す」ボタンで AI マップ → サンプルに戻せる
 *   - エラー本文は select-text で選択 + コピー可能に
 */
type AnalysisStatus = "idle" | "loading" | "done" | "error";
type ClaudeAvailability =
  | { state: "checking" }
  | { state: "ok"; version: string }
  | { state: "missing" };

function App() {
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [noCodeMode, setNoCodeMode] = useState<boolean>(false);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<ScreenMapResult | null>(null);
  const [lastCostUsd, setLastCostUsd] = useState<number | null>(null);
  const [lastAnalyzedFolder, setLastAnalyzedFolder] = useState<string | null>(
    null,
  );
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [claudeAvail, setClaudeAvail] = useState<ClaudeAvailability>({
    state: "checking",
  });
  // Setup wizard 用の追加状態(Option A): Node.js 検出 / login 完了タイムスタンプ
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [loginCompletedAt, setLoginCompletedAt] = useState<number | null>(null);
  // 履歴(localStorage 由来)。初期マウント時に load、変更時に refreshHistory() で再ロード。
  const [history, setHistory] = useState<StoredAnalysis[]>([]);
  // v0.1.2 ドラッグ機能:現在表示中の分析に紐づく X 軸オフセット
  const [dragOffsetsX, setDragOffsetsX] = useState<Record<string, number>>({});
  // v0.1.4 タブ機能:今開いているタブの folderPath 一覧
  const [openTabPaths, setOpenTabPaths] = useState<string[]>([]);
  // v0.1.6 UI 言語(英日切替)。デフォルトは "ja"、localStorage で復元。
  const [language, setLanguageState] = useState<Language>("ja");
  const T = t(language);

  /**
   * v0.1.6: 言語を変更しつつ localStorage に永続化。
   *
   * 切替後の表示整合性:
   *   - 今表示中のマップが「別言語で分析されたもの」だった場合、そのまま見せると
   *     EN 選択中に日本語ラベルが出てしまう(or 逆)ため、サンプルマップに戻す。
   *   - 現在の lastAnalyzedFolder から history を引いて language を確認する。
   */
  const handleLanguageChange = (next: Language) => {
    if (next === language) return;
    setLanguageState(next);
    saveLanguage(next);
    // 現在表示中のマップが別言語ならサンプルに戻す(タブもアクティブ解除)
    if (lastAnalyzedFolder !== null) {
      const entry = history.find((h) => h.folderPath === lastAnalyzedFolder);
      if (entry && entry.language !== next) {
        handleResetToSample();
      }
    }
  };

  // localStorage から最新の履歴を読み直す(削除や保存の後に呼ぶ)
  const refreshHistory = () => {
    const store = loadStore();
    setHistory(store.history);
  };

  /**
   * v0.1.4 タブを開く(既に開いてれば順序維持、なければ末尾に追加)→ localStorage 永続化
   */
  const openTabFor = (folderPath: string) => {
    setOpenTabPaths((prev) => {
      const next = prev.includes(folderPath) ? prev : [...prev, folderPath];
      saveOpenTabs(next);
      return next;
    });
  };

  /** v0.1.4 タブを閉じる(履歴は残るが workspace から外れる) */
  const closeTab = (folderPath: string) => {
    setOpenTabPaths((prev) => {
      const next = prev.filter((p) => p !== folderPath);
      saveOpenTabs(next);
      return next;
    });
    // アクティブだったタブを閉じたら別タブに切替 or サンプル
    if (lastAnalyzedFolder === folderPath) {
      const remaining = openTabPaths.filter((p) => p !== folderPath);
      if (remaining.length > 0) {
        const next = history.find((h) => h.folderPath === remaining[0]);
        if (next) {
          handleSelectFromHistory(next);
          return;
        }
      }
      handleResetToSample();
    }
  };

  /**
   * Setup wizard の前提状態(Node / Claude Code)を一斉に再チェック。
   * インストール完了直後に呼ばれて UI を ✗ → ✓ に更新する。
   */
  const refreshSetup = async () => {
    const [node, claude] = await Promise.all([
      checkNodeAvailable(),
      checkClaudeAvailable(),
    ]);
    setNodeVersion(node);
    if (claude === null) {
      setClaudeAvail({ state: "missing" });
    } else {
      setClaudeAvail({ state: "ok", version: claude });
    }
  };

  // 起動時:Claude CLI / Node.js チェック + localStorage から最後に見ていた分析を復元
  useEffect(() => {
    void refreshSetup();

    // 永続化された履歴 + ログイン完了タイムスタンプを読み込み、current があれば復元
    const store = loadStore();
    setHistory(store.history);
    // v0.1.6: 言語設定を復元(不正値・未保存は asLanguage で "ja" に倒れる)
    const restoredLang = asLanguage(store.language);
    setLanguageState(restoredLang);
    // 過去に成功分析が 1 件でもあれば、login も済んでいるはず。Backfill して
    // SetupWizard が「2/3 完了」と訴え続けないようにする。
    if (store.history.length > 0 && store.loginCompletedAt === undefined) {
      markLoginCompleted();
      setLoginCompletedAt(Date.now());
    } else {
      setLoginCompletedAt(store.loginCompletedAt ?? null);
    }
    // v0.1.4: タブ一覧を復元(履歴に存在するパスだけに絞る)
    const validPaths = new Set(store.history.map((e) => e.folderPath));
    const restoredTabs = (store.openTabFolderPaths ?? []).filter((p) =>
      validPaths.has(p),
    );
    // current が tabs に無ければ先頭に追加(歴史的データとの整合性)
    if (store.currentFolderPath && validPaths.has(store.currentFolderPath)) {
      if (!restoredTabs.includes(store.currentFolderPath)) {
        restoredTabs.unshift(store.currentFolderPath);
      }
    }
    setOpenTabPaths(restoredTabs);
    if (store.currentFolderPath) {
      const entry = store.history.find(
        (e) => e.folderPath === store.currentFolderPath,
      );
      // v0.1.6: 復元対象の分析言語が現在の UI 言語と一致するときだけ復元する。
      // 不一致なら復元せずサンプルマップで起動(EN ユーザーが JA 分析を見ない)。
      if (entry && entry.language === restoredLang) {
        // 古い localStorage 形式(depth 欠落・複数 isEntryPoint 等)を、
        // 最新のルールに通してから state に流す(Codex review Med #3)。
        setAiResult(normalizeAndSanitizeScreenMap(entry.screens, restoredLang));
        setFolderPath(entry.folderPath);
        setFileCount(entry.fileCount);
        setLastCostUsd(entry.costUsd);
        setLastAnalyzedFolder(entry.folderPath);
        setAnalysisStatus("done");
        // v0.1.2: ドラッグオフセットも復元
        setDragOffsetsX(entry.dragOffsetsX ?? {});
      }
    }
  }, []);

  // v0.1.6: 「表示中マップ」と「UI 言語」のミスマッチを検出して自動でサンプルへ戻す。
  //   - 言語切替時:handleLanguageChange でも reset するが、保険として
  //   - 古い localStorage を読み直したとき
  //   - 旧 v0.1.5 から v0.1.6 にアップグレード直後の HMR 中
  //   いずれも EN モードに JA データが流れ込むのを防ぐ。
  useEffect(() => {
    if (lastAnalyzedFolder === null || aiResult === null) return;
    const entry = history.find((h) => h.folderPath === lastAnalyzedFolder);
    if (entry && entry.language !== language) {
      handleResetToSample();
    }
  }, [language, lastAnalyzedFolder, aiResult, history]);

  // 分析中に経過秒数を更新(進行中だとユーザーに伝える)
  useEffect(() => {
    if (analysisStatus !== "loading") {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [analysisStatus]);

  // 表示するマップデータ: AI 結果があればそれを、なければ「現在の UI 言語」の
  // サンプルにフォールバック(v0.1.6: 英日サンプル切替)。
  //
  // ノードの y 座標は MapCanvas 側で depth から自動計算するため、ここで上書きしない。
  // x と depth だけが効く。
  const screens = aiResult ?? getSampleScreens(language);

  const selectedNode =
    selectedNodeId !== null
      ? screens.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  // v0.1.4: タブとして開いている StoredAnalysis 配列(順序保持、無いものは除外)
  // v0.1.6 追加:現在の UI 言語と一致するエントリだけにフィルタ(EN モードに JA タブを混ぜない)
  const tabEntries = useMemo(() => {
    return openTabPaths
      .map((p) => history.find((h) => h.folderPath === p))
      .filter((e): e is StoredAnalysis => e !== undefined)
      .filter((e) => e.language === language);
  }, [openTabPaths, history, language]);

  // v0.1.6: 履歴 dropdown 用も同様に言語フィルタ。EN モード時は JA エントリを完全に隠す。
  const visibleHistory = useMemo(
    () => history.filter((e) => e.language === language),
    [history, language],
  );

  const handlePickFolder = async () => {
    setAnalysisError(null);
    try {
      const result = await pickFolderAndListFiles(language);
      if (result === null) return;

      // 直前と同じフォルダ + AI 結果あり → 再分析確認(コスト防止)
      if (
        result.folder === lastAnalyzedFolder &&
        aiResult !== null &&
        lastCostUsd !== null
      ) {
        const proceed = await ask(T.app.reAnalyzeConfirmBody(lastCostUsd), {
          title: T.app.reAnalyzeConfirmTitle,
          kind: "warning",
        });
        if (!proceed) return;
      }

      setFolderPath(result.folder);
      setFileCount(result.fileCount);
      setAnalysisStatus("loading");
      // ※旧 aiResult はクリアせず保持する。分析中は前回のマップを見せ続けたほうが、
      // ユーザーがコンテキストを失わない(空白で sampleScreens に戻ると認知負荷↑)。
      // 完了時に setAiResult(outcome.screens) で置き換える。

      console.log(
        `Analyzing folder: ${result.folder} (${result.fileCount} files)`,
      );
      const outcome = await analyzeFolderToScreenMap(result.folder, language);

      console.log("AI screen map outcome:", outcome);
      setAiResult(outcome.screens);
      setLastCostUsd(outcome.costUsd);
      setLastAnalyzedFolder(result.folder);
      setAnalysisStatus("done");
      setSelectedNodeId(null); // 新マップに切替時、サンプルでの選択を解除
      setDragOffsetsX({}); // v0.1.2: 新規 / 再分析でノード id が変わるのでオフセットをクリア

      // 永続化:再起動でも復元できるよう localStorage に保存し、履歴に積む
      saveAnalysis({
        folderPath: result.folder,
        fileCount: result.fileCount,
        screens: outcome.screens,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
        analyzedAt: Date.now(),
        language, // v0.1.6: 分析時の UI 言語を記録(後で言語別フィルタに使う)
      });
      refreshHistory();
      openTabFor(result.folder); // v0.1.4: 分析完了で自動でタブに追加
      // 分析が通った = 認証も通っている。SetupWizard の login ステップを完了扱いに。
      if (loginCompletedAt === null) {
        markLoginCompleted();
        setLoginCompletedAt(Date.now());
      }
    } catch (err) {
      console.error("Analysis failed:", err);
      setAnalysisStatus("error");
      setAnalysisError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetToSample = () => {
    setAiResult(null);
    setSelectedNodeId(null);
    setAnalysisStatus("idle");
    setFolderPath(null);
    setFileCount(null);
    setLastCostUsd(null);
    setLastAnalyzedFolder(null);
    setDragOffsetsX({}); // v0.1.2: サンプルに戻すときドラッグオフセットもリセット
    // 次回起動時もサンプルで起動するように current をクリア(履歴は残す)
    setCurrent(null);
  };

  /** 履歴から 1 件選んで、その分析結果を画面に復元する。 */
  const handleSelectFromHistory = (entry: StoredAnalysis) => {
    // 履歴データは古いスキーマの可能性があるので、復元時に再正規化(Med #3)
    // v0.1.6: entry.language を渡して、EN データに JA cleanup を当てない
    setAiResult(normalizeAndSanitizeScreenMap(entry.screens, entry.language));
    setFolderPath(entry.folderPath);
    setFileCount(entry.fileCount);
    setLastCostUsd(entry.costUsd);
    setLastAnalyzedFolder(entry.folderPath);
    setAnalysisStatus("done");
    setSelectedNodeId(null);
    setAnalysisError(null);
    setCurrent(entry.folderPath);
    setDragOffsetsX(entry.dragOffsetsX ?? {}); // v0.1.2: 切替先のドラッグオフセットを反映
    refreshHistory();
    openTabFor(entry.folderPath); // v0.1.4: 履歴から開いたものをタブに追加
  };

  /**
   * v0.1.2 ドラッグ確定:MapCanvas から呼ばれる。state を更新しつつ、
   * 現在の分析フォルダに紐づけて localStorage にも保存する。
   */
  const handleDragOffsetsChange = (offsets: Record<string, number>) => {
    setDragOffsetsX(offsets);
    if (lastAnalyzedFolder !== null) {
      saveDragOffsets(lastAnalyzedFolder, offsets);
    }
  };

  /** v0.1.4: タブをクリックでアクティブに切替 */
  const handleSelectTab = (folderPath: string) => {
    const entry = history.find((h) => h.folderPath === folderPath);
    if (entry) handleSelectFromHistory(entry);
  };

  /** 履歴から 1 件削除。現在表示中だったらサンプルに戻る。タブからも除外。 */
  const handleRemoveFromHistory = (path: string) => {
    removeAnalysis(path);
    if (lastAnalyzedFolder === path) {
      handleResetToSample();
    }
    setOpenTabPaths((prev) => {
      const next = prev.filter((p) => p !== path);
      saveOpenTabs(next);
      return next;
    });
    refreshHistory();
  };

  // 機能拡張 Option A: アプリ内ガイド付きセットアップウィザード。
  // 旧「Claude CLI が見つかりません」バナーを置き換え、Node / Claude Code / ログインを
  // 3 ステップで誘導する。全部済んでいれば自動で消える(SetupWizard が null を返す)。
  const claudeVersionString =
    claudeAvail.state === "ok" ? claudeAvail.version : null;
  const setupWizard = (
    <SetupWizard
      nodeVersion={nodeVersion}
      claudeVersion={claudeVersionString}
      loginCompletedAt={loginCompletedAt}
      onRefresh={refreshSetup}
      onLoginCompleted={() => {
        markLoginCompleted();
        setLoginCompletedAt(Date.now());
      }}
      language={language}
    />
  );

  // ステータステキスト
  const statusText = (() => {
    if (claudeAvail.state === "checking") return T.app.statusChecking;
    if (claudeAvail.state === "missing") {
      return T.app.statusSetupIncomplete;
    }
    if (loginCompletedAt === null) {
      return T.app.statusLoginIncomplete;
    }
    if (folderPath === null) {
      return T.app.statusClaudeReady(claudeAvail.version);
    }
    switch (analysisStatus) {
      case "loading":
        return T.app.statusAnalyzing(folderPath, fileCount, elapsedSec);
      case "done":
        if (aiResult) {
          const costPart =
            lastCostUsd !== null ? T.app.costPart(lastCostUsd) : "";
          // 構造系の数値は常に「画面 / リンク」で統一(Notion ネイティブ語)。
          // ノード/エッジ のグラフ用語、つながり の子供語、いずれも回避。
          return T.app.statusAiMap(
            aiResult.nodes.length,
            aiResult.edges.length,
            costPart,
            folderPath,
          );
        }
        return T.app.statusDone;
      case "error":
        return null; // エラーは別 UI で表示(選択可能なテキスト)
      default:
        return T.app.statusSelected(folderPath, fileCount);
    }
  })();

  // Codex review High 対応:Claude CLI が入っていても、login 完了前にフォルダ
  // 選択を許すと、後段で「認証されていません」エラーに着地して旧バナーに戻る
  // という残念な導線になる。loginCompletedAt が null のうちは disable して、
  // ユーザーを SetupWizard のログインステップへ誘導する。
  const buttonDisabled =
    claudeAvail.state !== "ok" ||
    loginCompletedAt === null ||
    analysisStatus === "loading";

  return (
    <div className="h-screen flex flex-col bg-charcoal overflow-hidden">
      <Header
        noCodeMode={noCodeMode}
        onNoCodeModeChange={setNoCodeMode}
        language={language}
        onLanguageChange={handleLanguageChange}
      />
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-auto px-6 py-12">
          <div className="mx-auto max-w-3xl">
            {setupWizard}

            {/* v0.1.4 タブバー(タブが 0 件の時は自動的に非表示) */}
            <TabBar
              tabs={tabEntries}
              activeFolderPath={lastAnalyzedFolder}
              onSelectTab={handleSelectTab}
              onCloseTab={closeTab}
              language={language}
            />

            {/* ツールバー */}
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <Button onClick={handlePickFolder} disabled={buttonDisabled}>
                {analysisStatus === "loading"
                  ? T.app.analyzing
                  : T.app.pickFolder}
              </Button>

              <HistoryDropdown
                history={visibleHistory}
                currentFolderPath={lastAnalyzedFolder}
                onSelect={handleSelectFromHistory}
                onRemove={handleRemoveFromHistory}
                language={language}
              />

              {aiResult !== null && analysisStatus !== "loading" ? (
                <Button variant="secondary" onClick={handleResetToSample}>
                  {T.app.resetToSample}
                </Button>
              ) : null}

              {analysisStatus === "loading" ? (
                <Spinner
                  className="w-4 h-4 text-electric-teal"
                  language={language}
                />
              ) : null}

              {statusText !== null ? (
                <span className="text-sm text-soft-grid">{statusText}</span>
              ) : null}
            </div>

            {/* エラー本文(select-text で選択コピー可) */}
            {analysisStatus === "error" && analysisError ? (
              <pre className="bg-slate border border-charcoal rounded-[14px] p-4 mb-6 text-xs text-off-white whitespace-pre-wrap select-text font-mono leading-relaxed overflow-x-auto">
                <span className="text-soft-grid">{T.app.errorPrefix}</span>{" "}
                {analysisError}
              </pre>
            ) : null}

            {/* ツールバーとマップの間の余白 */}
            <div className="mb-6" />

            {/*
              クイックウィン 1: アプリ一言サマリー(マップの上に置く)。
              「これは何のアプリか」を読む前提として最初に与える。AI が判断できなければ
              undefined なので何も出ない。
            */}
            {screens.appSummary && (
              <div className="bg-slate border border-charcoal rounded-[14px] px-4 py-3 mb-4 text-sm text-off-white leading-relaxed">
                <span className="text-xs text-electric-teal font-semibold mr-2 uppercase tracking-wide">
                  {T.app.summaryBadge}
                </span>
                {screens.appSummary}
              </div>
            )}

            {/*
              機能拡張:単一 SVG 内に N 階層のフロアを縦積みする方式に変更。
              CSS 3D 回転は廃止し、エッジは階層をまたいで直線で繋がる。
              フロア数は MapCanvas 内で maxDepth+1 から自動算出される。

              Codex review Low #4 対応:履歴切替や AI 結果切替で SVG の
              aspect ratio が変わって縦ジャンプするので、min-height で
              2 階層相当のベースラインを確保。CSS transition で SVG 自体の
              opacity を渡し、切替時の体感を滑らかに。
            */}
            <div
              className="mb-6 transition-opacity duration-200"
              style={{ minHeight: "320px" }}
            >
              <MapCanvas
                nodes={screens.nodes}
                edges={screens.edges}
                selectedNodeId={selectedNodeId}
                onNodeClick={(id) => setSelectedNodeId(id)}
                noCodeMode={noCodeMode}
                dragOffsetsX={dragOffsetsX}
                onDragOffsetsChange={handleDragOffsetsChange}
                language={language}
              />
            </div>
          </div>
        </main>
        <InspectorPanel
          node={selectedNode}
          allNodes={screens.nodes}
          allEdges={screens.edges}
          onClose={() => setSelectedNodeId(null)}
          noCodeMode={noCodeMode}
          language={language}
        />
      </div>
    </div>
  );
}

export default App;
