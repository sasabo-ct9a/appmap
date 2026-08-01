import { useEffect, useMemo, useState } from "react";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import Header from "./components/layout/Header";
import Sidebar, { type NavKey } from "./components/layout/Sidebar";
import GuidedTour, { type TourStep } from "./components/tour/GuidedTour";
import TopBar from "./components/layout/TopBar";
import MapCanvas from "./components/canvas/MapCanvas";
import FeatureCardGrid from "./components/canvas/FeatureCardGrid";
import BottomSection from "./components/canvas/BottomSection";
import InspectorPanel from "./components/inspector/InspectorPanel";
import ImpactView from "./components/impact/ImpactView";
import PreReleaseChecklist from "./components/checklist/PreReleaseChecklist";
import { SparkleIcon } from "./components/ui/Icons";
import {
  ProjectOverview,
  ProjectData,
  ProjectSettings,
} from "./components/project/ProjectViews";
import Button from "./components/ui/Button";
import Spinner from "./components/ui/Spinner";
import HistoryDropdown from "./components/ui/HistoryDropdown";
import SetupWizard from "./components/ui/SetupWizard";
// v0.1.8:上部 TabBar は撤去(サイドバーに一本化)
import SpecDocModal from "./components/ui/SpecDocModal";
import SettingsModal from "./components/ui/SettingsModal";
import LocalLLMSetupWizard from "./components/ui/LocalLLMSetupWizard";
import { getSampleScreens } from "./data/sampleScreens";
import { pickFolderAndListFiles, relistFilesForPath } from "./lib/folderPicker";
import {
  checkClaudeAvailable,
  checkNodeAvailable,
  normalizeAndSanitizeScreenMap,
  runClaudeLogin,
  type ScreenMapResult,
} from "./lib/claudeCli";
import {
  checkLlamaBinary,
  checkLlamaModel,
} from "./lib/llamaClient";
import { analyzeFolder } from "./lib/engineSelector";
import { computeMapDiff } from "./lib/mapDiff";
import { buildShareHTML } from "./lib/shareHTML";
import {
  loadStore,
  saveAnalysis,
  setCurrent,
  removeAnalysis,
  markLoginCompleted,
  saveDragOffsets,
  saveOpenTabs,
  saveLanguage,
  saveEngine,
  saveDetailLevel,
  savePreferredEditor,
  loadPreferredEditor,
  asEngine,
  asDetailLevel,
  type StoredAnalysis,
  type Engine,
  type DetailLevel,
  type EditorChoice,
} from "./lib/storage";
import { t, asLanguage, pickLocalized, type Language } from "./lib/i18n";

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
  // v0.1.8:ノートの変更を検知して MapCanvas のバッジを再描画するための単純カウンタ
  const [notesTick, setNotesTick] = useState<number>(0);
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
  // v0.1.7 大刷新で MapCanvas が独自レイアウト計算するため未使用化(localStorage 復元用に state は残す)
  const [, setDragOffsetsX] = useState<Record<string, number>>({});
  // v0.1.4 タブ機能:今開いているタブの folderPath 一覧
  const [openTabPaths, setOpenTabPaths] = useState<string[]>([]);
  // v0.1.6 UI 言語(英日切替)。デフォルトは "ja"、localStorage で復元。
  const [language, setLanguageState] = useState<Language>("ja");
  // v0.1.7 仕様書モーダルの開閉(マップから仕様書を生成 → コピー / PDF 化)
  const [specDocOpen, setSpecDocOpen] = useState<boolean>(false);
  // v0.1.10 ガイド付きツアーの開閉(サイドバーのボタンから起動)
  const [tourOpen, setTourOpen] = useState<boolean>(false);
  // v0.1.10 Claude ログイン切れ復旧の状態
  //   idle:未実行、progress:ブラウザ待ち、done:成功メッセージ表示、failed:エラー表示
  const [authRecoveryState, setAuthRecoveryState] = useState<
    "idle" | "progress" | "done" | "failed"
  >("idle");
  const [authRecoveryError, setAuthRecoveryError] = useState<string | null>(
    null,
  );
  // v0.1.7 AI エンジン(Claude / Local LLM)+ 設定モーダル開閉
  const [engine, setEngineState] = useState<Engine>("claude");
  // v0.1.8 外部エディタ(関連ファイルクリックで使う)
  const [preferredEditor, setPreferredEditor] = useState<EditorChoice>("cursor");
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // v0.1.8 差分マップ表示 ON/OFF(前回分析との比較)
  const [showDiff, setShowDiff] = useState<boolean>(false);
  // v0.1.7 ローカル LLM のセットアップ状態(バイナリ配置 + モデル DL)
  const [llamaBinaryOk, setLlamaBinaryOk] = useState<boolean>(false);
  const [llamaModelOk, setLlamaModelOk] = useState<boolean>(false);
  // v0.1.7 詳細レベル(簡素 / 詳細)。1 回の分析データを 2 段でフィルタ表示する。
  // デフォルトは "detailed"(全表示)。Simple は重要ノードのみ抽出。
  const [detailLevel, setDetailLevelState] = useState<DetailLevel>("detailed");
  // v0.1.7 大刷新:左サイドバーのナビ
  const [activeNav, setActiveNav] = useState<NavKey>("intro");

  // v0.1.7:ホームの表示モード。かんたん=マインドマップ、詳細=データベース配置
  const [viewMode, setViewMode] = useState<"map" | "database">("map");

  // v0.1.7 lift up:マインドマップのノード移動オフセット(MapCanvas / SpecDocMap で共有)。
  //   別解析(folder)に切り替わったらリセット。
  const [nodeOffsets, setNodeOffsets] = useState<
    Map<number, { x: number; y: number }>
  >(new Map());
  useEffect(() => {
    setNodeOffsets(new Map());
  }, [lastAnalyzedFolder]);

  /** v0.1.7: 詳細レベルを変更しつつ localStorage に永続化。 */
  const handleDetailLevelChange = (next: DetailLevel) => {
    if (next === detailLevel) return;
    setDetailLevelState(next);
    saveDetailLevel(next);
  };
  const T = t(language);

  /** v0.1.7: AI エンジンを変更 + 永続化。Setup 状態の再チェックも走らせる。 */
  const handleEngineChange = (next: Engine) => {
    if (next === engine) return;
    setEngineState(next);
    saveEngine(next);
    if (next === "local") {
      void refreshLlamaSetup();
    }
  };

  /** v0.1.8:外部エディタ選択を保存 + state 反映。 */
  const handlePreferredEditorChange = (next: EditorChoice) => {
    if (next === preferredEditor) return;
    setPreferredEditor(next);
    savePreferredEditor(next);
  };

  /**
   * v0.1.8:共有 HTML エクスポート。
   * 現在の分析結果を単一 HTML ファイル(外部依存ゼロ)として保存。
   * 受け手は AppMap 不要でブラウザで開くだけでマップと詳細を閲覧できる。
   */
  const handleExportShareHTML = async () => {
    try {
      const html = buildShareHTML({
        screens,
        language,
        appName,
        generatedAt: Date.now(),
      });
      // ファイル名はプロジェクト名 or "AppMap" + .html
      const safeName = (appName || "AppMap").replace(/[\\/:*?"<>|]/g, "_");
      const defaultPath = `${safeName}-share.html`;
      const path = await save({
        title: t(language).topBar.exportShareHTMLDialogTitle,
        defaultPath,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return; // キャンセル
      await writeTextFile(path, html);
      // 完了通知(alert は簡易だが確実)
      window.alert(t(language).topBar.exportShareHTMLSuccess);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(
        `${t(language).topBar.exportShareHTMLFailure}: ${msg}`,
      );
    }
  };

  /** v0.1.7: ローカル LLM のセットアップ状態を再チェック。 */
  const refreshLlamaSetup = async () => {
    const [ver, hasModel] = await Promise.all([
      checkLlamaBinary(),
      checkLlamaModel(),
    ]);
    setLlamaBinaryOk(ver !== null);
    setLlamaModelOk(hasModel);
  };

  /**
   * v0.1.6: 言語を変更しつつ localStorage に永続化。
   * v0.1.7 多言語化:表示中マップは Bilingual なので **切替で再分析不要**、
   * pickLocalized が render 時に該当言語を選ぶだけで OK。
   */
  const handleLanguageChange = (next: Language) => {
    if (next === language) return;
    setLanguageState(next);
    saveLanguage(next);
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
  /**
   * タブの × を押したら、履歴・開いてるタブ・サイドバーを全て同期して削除する。
   * v0.1.7:旧実装はタブ閉じだけで履歴は残していたが、ユーザー要望でフル削除に統一。
   * 削除前にアクティブだった場合は残りタブの先頭、または無ければサンプルに切替。
   */
  const closeTab = (folderPath: string) => {
    // アクティブだったタブを閉じる場合は、残りタブ先頭に切替してから削除
    if (lastAnalyzedFolder === folderPath) {
      const remaining = openTabPaths.filter((p) => p !== folderPath);
      if (remaining.length > 0) {
        const next = history.find((h) => h.folderPath === remaining[0]);
        if (next) {
          handleSelectFromHistory(next);
        } else {
          handleResetToSample();
        }
      } else {
        handleResetToSample();
      }
    }
    // 履歴・タブ両方から削除
    removeAnalysis(folderPath);
    setOpenTabPaths((prev) => {
      const next = prev.filter((p) => p !== folderPath);
      saveOpenTabs(next);
      return next;
    });
    refreshHistory();
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
    // v0.1.7: エンジン設定を復元(未保存は "claude")。"local" ならセットアップ状態も初期チェック。
    const restoredEngine = asEngine(store.engine);
    setEngineState(restoredEngine);
    if (restoredEngine === "local") {
      void refreshLlamaSetup();
    }
    // v0.1.7: 詳細レベル設定を復元(未保存は "standard")。
    setDetailLevelState(asDetailLevel(store.detailLevel));
    // v0.1.8: 外部エディタ設定を復元(未保存は "cursor")。
    setPreferredEditor(loadPreferredEditor());
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
      // v0.1.7 多言語化:bilingual エントリは UI 言語に関係なく表示可能。
      // 旧 v0.1.6 までの単言語エントリも pickLocalized が string をそのまま返すので動く。
      if (entry) {
        // 古い localStorage 形式(depth 欠落・複数 isEntryPoint 等)を、
        // 最新のルールに通してから state に流す(Codex review Med #3)。
        setAiResult(
          normalizeAndSanitizeScreenMap(entry.screens, entry.language),
        );
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

  // v0.1.6 で入れていた「言語ミスマッチで自動的にサンプルへ」useEffect は
  // v0.1.7 多言語化で **撤廃**:全エントリ Bilingual なので切替で再分析不要、
  // 表示時に pickLocalized で言語選択するだけで済む。

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
  const rawScreens = aiResult ?? getSampleScreens(language);

  /**
   * v0.1.7 詳細レベルフィルタ(2 段):
   *   - simple:   重要ノード(40-50% 程度、最低 2 ノード)
   *   - detailed: 全ノード(デフォルト)
   *
   *   フィルタ方針:
   *     1. AI が detailLevel タグを付けていれば(0/1/2)→ Simple は **0 のみ**、Detailed は全部
   *        (AI 出力の 1, 2 は両方とも Detailed に集約)
   *     2. タグ無し → 重要度ソート(entry → edge degree → depth)で上位 40% を Simple
   *
   *   エッジは可視ノード間のみ残す。
   */
  const screens = useMemo(() => {
    const hasDetailLevelTags = rawScreens.nodes.some(
      (n) => typeof n.detailLevel === "number",
    );

    let visibleNodes: typeof rawScreens.nodes;

    if (detailLevel === "detailed") {
      // 詳細モードは無条件で全表示
      visibleNodes = rawScreens.nodes;
    } else if (hasDetailLevelTags) {
      // 簡素 + AI タグ → detailLevel===0 のみ(AI 判断のコアフロー)
      visibleNodes = rawScreens.nodes.filter(
        (n) => (typeof n.detailLevel === "number" ? n.detailLevel : 0) === 0,
      );
    } else {
      // 簡素 + タグ無し → 重要度ソートして上位 40%(最低 2、上限 total-1)
      const degreeOf = (id: number) =>
        rawScreens.edges.reduce(
          (acc, e) => acc + (e.from === id ? 1 : 0) + (e.to === id ? 1 : 0),
          0,
        );
      const sorted = [...rawScreens.nodes].sort((a, b) => {
        if (a.isEntryPoint && !b.isEntryPoint) return -1;
        if (!a.isEntryPoint && b.isEntryPoint) return 1;
        const da = degreeOf(a.id);
        const db = degreeOf(b.id);
        if (da !== db) return db - da;
        const dpa = a.depth ?? 0;
        const dpb = b.depth ?? 0;
        if (dpa !== dpb) return dpa - dpb;
        return a.id - b.id;
      });
      const total = sorted.length;
      // Simple は ceil(total * 0.4)、最低 2、Detailed と差を保つため上限 total-1
      const take = Math.min(
        Math.max(1, total - 1),
        Math.max(2, Math.ceil(total * 0.4)),
      );
      visibleNodes = sorted.slice(0, take);
    }

    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = rawScreens.edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );
    return {
      ...rawScreens,
      nodes: visibleNodes,
      edges: visibleEdges,
    };
  }, [rawScreens, detailLevel]);

  // v0.1.8 差分マップ:現在の分析エントリの previousScreens を取り出す
  const activeAnalysis = useMemo(
    () =>
      lastAnalyzedFolder
        ? history.find((h) => h.folderPath === lastAnalyzedFolder) ?? null
        : null,
    [history, lastAnalyzedFolder],
  );
  const previousScreens = activeAnalysis?.previousScreens ?? null;
  const mapDiff = useMemo(
    () => computeMapDiff(screens, previousScreens, language),
    [screens, previousScreens, language],
  );

  const selectedNode =
    selectedNodeId !== null
      ? screens.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  // v0.1.4: タブとして開いている StoredAnalysis 配列(順序保持、無いものは除外)
  // v0.1.7 多言語化:全エントリが Bilingual で保存されるようになったので、
  // 言語別フィルタは撤廃(切替で再分析不要、表示時に pickLocalized が言語選ぶ)。
  const tabEntries = useMemo(() => {
    return openTabPaths
      .map((p) => history.find((h) => h.folderPath === p))
      .filter((e): e is StoredAnalysis => e !== undefined);
  }, [openTabPaths, history]);

  // v0.1.7: 履歴 dropdown も同様にフィルタ無し。全エントリを言語に関係なく表示。
  const visibleHistory = history;

  const handlePickFolder = async () => {
    setAnalysisError(null);
    setAuthRecoveryState("idle");
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

      // v0.1.8:デバッグ用 console.log は撤去(進捗はステータスバー、結果はマップ描画で可視化済)
      const outcome = await analyzeFolder(result.folder, language, engine);
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

  /**
   * v0.1.10:現在開いているフォルダを再分析する。
   * folder ピッカーを開かず、既存の lastAnalyzedFolder パスを直接使う。
   * 分析後は saveAnalysis 側で previous を退避 → 差分マップに自動反映される。
   */
  const handleReloadFolder = async () => {
    if (!lastAnalyzedFolder) return;
    setAnalysisError(null);
    setAuthRecoveryState("idle");
    try {
      // コスト確認(再分析なので必ず出す。ユーザーが誤クリックした時の防波堤)
      if (aiResult !== null && lastCostUsd !== null) {
        const proceed = await ask(T.app.reAnalyzeConfirmBody(lastCostUsd), {
          title: T.app.reAnalyzeConfirmTitle,
          kind: "warning",
        });
        if (!proceed) return;
      }
      const relisted = await relistFilesForPath(lastAnalyzedFolder);
      setFolderPath(relisted.folder);
      setFileCount(relisted.fileCount);
      setAnalysisStatus("loading");
      const outcome = await analyzeFolder(relisted.folder, language, engine);
      setAiResult(outcome.screens);
      setLastCostUsd(outcome.costUsd);
      setLastAnalyzedFolder(relisted.folder);
      setAnalysisStatus("done");
      setSelectedNodeId(null);
      setDragOffsetsX({}); // ノード id が変わる可能性があるのでドラッグオフセットリセット
      saveAnalysis({
        folderPath: relisted.folder,
        fileCount: relisted.fileCount,
        screens: outcome.screens,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
        analyzedAt: Date.now(),
        language,
      });
      refreshHistory();
      openTabFor(relisted.folder);
    } catch (err) {
      console.error("Reload failed:", err);
      setAnalysisStatus("error");
      setAnalysisError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * v0.1.10:analysisError が Claude 認証切れかを判定。
   * JA/EN の代表的なメッセージ、Rust 側で埋め込まれる典型フレーズを含む。
   */
  const isAuthError = (msg: string | null): boolean => {
    if (!msg) return false;
    const lower = msg.toLowerCase();
    return (
      lower.includes("認証されていません") ||
      lower.includes("claude auth login") ||
      lower.includes("not authenticated") ||
      lower.includes("please log in") ||
      lower.includes("unauthorized") ||
      lower.includes("token has expired") ||
      lower.includes("invalid session")
    );
  };

  /** v0.1.10:Claude ログイン復旧。runClaudeLogin を呼んでブラウザ OAuth を起動 */
  const handleAuthRecovery = async () => {
    setAuthRecoveryState("progress");
    setAuthRecoveryError(null);
    try {
      await runClaudeLogin();
      setAuthRecoveryState("done");
      // 分析エラー表示は消す(ユーザーが次に押すのは「フォルダを選ぶ」or「再読込」)
      setAnalysisError(null);
      setAnalysisStatus("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthRecoveryState("failed");
      setAuthRecoveryError(msg);
    }
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

  // v0.1.7 大刷新で drag offsets は MapCanvas の独自配置に置き換えられ未使用化。
  // saveDragOffsets / handleDragOffsetsChange は今後のドラッグ対応再開時用に残置(現在は呼び出し無し)。
  void saveDragOffsets;

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
  // v0.1.7: エンジン別の SetupWizard 出し分け
  const setupWizard =
    engine === "claude" ? (
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
    ) : (
      <LocalLLMSetupWizard language={language} onChange={refreshLlamaSetup} />
    );

  // ステータステキスト
  // v0.1.7: エンジン別の status を出す。Local LLM 時は Claude のチェック結果は無関係。
  const statusText = (() => {
    if (engine === "local") {
      // Local LLM:バイナリ + モデルがどちらかでも未完なら setupwizard を案内
      if (!llamaBinaryOk || !llamaModelOk) {
        return T.app.statusSetupIncomplete;
      }
      if (folderPath === null) {
        return T.localLLM.statusUsingLocal("Qwen 2.5-Coder 14B");
      }
      // fall through to per-state branches below
    } else {
      // Claude エンジン:既存ロジック
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
    }
    switch (analysisStatus) {
      case "loading":
        return T.app.statusAnalyzing(folderPath, fileCount, elapsedSec);
      case "done":
        if (aiResult) {
          // v0.1.7: Local エンジン時は常に $0 なのでコスト表示を省く(意味なし表示の除去)
          const costPart =
            engine !== "local" && lastCostUsd !== null
              ? T.app.costPart(lastCostUsd)
              : "";
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
  //
  // v0.1.7:エンジン別の disable 条件。
  //   - claude:CLI + login 完了が前提
  //   - local:llama-server バイナリ配置 + モデル DL 完了が前提
  const buttonDisabled =
    analysisStatus === "loading" ||
    (engine === "claude" &&
      (claudeAvail.state !== "ok" || loginCompletedAt === null)) ||
    (engine === "local" && (!llamaBinaryOk || !llamaModelOk));

  // v0.1.7 大刷新:LIGHT モード 3 カラム shell へ移行。
  // 旧 Header は残置(将来削除予定)、新 Sidebar + TopBar を配置。
  const appName = lastAnalyzedFolder
    ? lastAnalyzedFolder.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "AppMap"
    : "AppMap";
  const appSubtitle = screens.appSummary
    ? (typeof screens.appSummary === "string"
        ? screens.appSummary
        : (screens.appSummary.ja ?? screens.appSummary.en ?? "")
      ).slice(0, 80)
    : "AI で作ったアプリの全体像を可視化";

  return (
    <div className="h-screen flex bg-canvas overflow-hidden app-shell">
      {/* 左サイドバー */}
      <Sidebar
        activeNav={activeNav}
        onNavChange={setActiveNav}
        tabs={tabEntries}
        activeFolderPath={lastAnalyzedFolder}
        onSelectTab={handleSelectTab}
        onCloseTab={closeTab}
        language={language}
        onStartTour={() => {
          // ツアーはホーム画面(かんたんモード = マップ表示)基準で作ってあるので、
          // 他のタブ(コードチェック等)にいる時は一旦ホームに戻してから開始
          setActiveNav("intro");
          setTourOpen(true);
        }}
      />

      {/* 中央カラム */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          appName={appName}
          appSubtitle={appSubtitle}
          mode={viewMode === "map" ? "easy" : "detail"}
          onModeChange={(m) => setViewMode(m === "easy" ? "map" : "database")}
          onExport={() => setSpecDocOpen(true)}
          onExportShareHTML={handleExportShareHTML}
          engine={engine}
          onEngineChange={handleEngineChange}
          language={language}
        />

        {/* 旧 Header(設定モーダル / 言語切替 / ノーコード語 経由のため一時残置)*/}
        <div className="hidden">
          <Header
            noCodeMode={noCodeMode}
            onNoCodeModeChange={setNoCodeMode}
            language={language}
            onLanguageChange={handleLanguageChange}
            detailLevel={detailLevel}
            onDetailLevelChange={handleDetailLevelChange}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-auto px-8 py-6">
          {/* 広い画面(全画面表示)ではコンテンツ幅を広げてマップを大きく見せる。
              狭い窓では従来どおり max-w-6xl(1152px)で読みやすさを保つ。 */}
          <div className="mx-auto max-w-6xl xl:max-w-[88rem] 2xl:max-w-[104rem]">
            {setupWizard}

            {/* v0.1.8:上部の重複タブバーは撤去。サイドバー「開いているプロジェクト」に一本化 */}

            {/* ツールバー(v0.1.7 配置変更 + LIGHT 化) */}
            <div className="flex items-center gap-3 mb-5 flex-wrap">
              <Button
                onClick={handlePickFolder}
                disabled={buttonDisabled}
                dataTour="folder-picker"
              >
                {analysisStatus === "loading"
                  ? T.app.analyzing
                  : T.app.pickFolder}
              </Button>

              {/* v0.1.10:現フォルダ再読込。既に分析済みフォルダがある時だけ表示 */}
              {lastAnalyzedFolder !== null && (
                <Button
                  variant="secondary"
                  onClick={handleReloadFolder}
                  disabled={buttonDisabled}
                  dataTour="folder-reload"
                >
                  {analysisStatus === "loading"
                    ? T.app.analyzing
                    : T.app.reloadFolder}
                </Button>
              )}

              <HistoryDropdown
                history={visibleHistory}
                currentFolderPath={lastAnalyzedFolder}
                onSelect={handleSelectFromHistory}
                onRemove={handleRemoveFromHistory}
                language={language}
              />

              {/* v0.1.8: 「サンプルに戻す」ボタンは撤去。
                  タブ全閉じで自動的にサンプルに戻る fallback は残しているので
                  ボタンとしては不要(handleResetToSample は closeTab から呼ばれる)。*/}

              {/* v0.1.7: 仕様書を作成(サンプルでも生成可能、aiResult のあるなしに関係なく screens から作る)*/}
              <Button
                variant="secondary"
                onClick={() => setSpecDocOpen(true)}
                disabled={analysisStatus === "loading"}
              >
                {T.specDoc.buttonLabel}
              </Button>

              {analysisStatus === "loading" ? (
                <Spinner
                  className="w-4 h-4 text-feature-teal"
                  language={language}
                />
              ) : null}

              {statusText !== null ? (
                <span className="text-sm text-ink-soft">{statusText}</span>
              ) : null}
            </div>

            {/* エラー本文
                v0.1.10:認証エラー時は原文の代わりにワンクリック復旧バナーを表示 */}
            {analysisStatus === "error" && analysisError ? (
              isAuthError(analysisError) ? (
                <div
                  className="mb-6 rounded-[14px] border p-4"
                  style={{
                    background: "#fef2f2",
                    borderColor: "#fecaca",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-black text-sm text-white"
                      style={{ background: "#dc2626" }}
                      aria-hidden="true"
                    >
                      !
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-bold mb-1" style={{ color: "#7f1d1d" }}>
                        {T.app.authRecoveryTitle}
                      </h3>
                      <p className="text-[12.5px] leading-relaxed" style={{ color: "#7f1d1d" }}>
                        {T.app.authRecoveryBody}
                      </p>
                      <div className="mt-3">
                        {authRecoveryState === "idle" && (
                          <button
                            type="button"
                            onClick={handleAuthRecovery}
                            className="inline-flex items-center gap-2 rounded-[10px] px-4 py-2 text-sm font-semibold text-white cursor-pointer shadow-sm"
                            style={{ background: "#dc2626" }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "#b91c1c";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "#dc2626";
                            }}
                          >
                            {T.app.authRecoveryButton}
                          </button>
                        )}
                        {authRecoveryState === "progress" && (
                          <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "#7f1d1d" }}>
                            <span
                              className="w-3 h-3 rounded-full border-2 animate-spin"
                              style={{ borderColor: "#dc2626", borderTopColor: "transparent" }}
                              aria-hidden="true"
                            />
                            {T.app.authRecoveryInProgress}
                          </div>
                        )}
                        {authRecoveryState === "done" && (
                          <div className="text-[12.5px] font-semibold" style={{ color: "#166534" }}>
                            ✓ {T.app.authRecoveryDone}
                          </div>
                        )}
                        {authRecoveryState === "failed" && (
                          <div className="space-y-2">
                            <div className="text-[12.5px]" style={{ color: "#7f1d1d" }}>
                              {T.app.authRecoveryFailed(authRecoveryError ?? "")}
                            </div>
                            <button
                              type="button"
                              onClick={handleAuthRecovery}
                              className="inline-flex items-center gap-2 rounded-[10px] px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                              style={{ background: "#dc2626" }}
                            >
                              {T.app.authRecoveryButton}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <pre className="bg-paper border border-impact-high/30 rounded-[14px] p-4 mb-6 text-xs text-ink whitespace-pre-wrap select-text font-mono leading-relaxed overflow-x-auto">
                  <span className="text-impact-high font-semibold">
                    {T.app.errorPrefix}
                  </span>{" "}
                  {analysisError}
                </pre>
              )
            ) : null}

            {/* v0.1.7 サイドバーナビ:activeNav に応じてメイン白エリアを切替。
                上のバナー(タブ + ツールバー + status + エラー)は常時表示。 */}

            {activeNav === "intro" && (
              <>
                {/* タイトル + 画面数バッジ */}
                {screens.nodes.length > 0 && (
                  <div className="flex items-end justify-between mb-4">
                    <div>
                      <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
                        {t(language).intro.heading}
                        <SparkleIcon className="w-5 h-5 text-feature-teal" />
                      </h1>
                      <p className="text-sm text-ink-soft mt-1">
                        {t(language).intro.subheading}
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="flex items-center gap-2 rounded-[14px] px-3.5 py-2 border-2"
                        style={{
                          background: "var(--color-feature-teal-soft)",
                          borderColor: "var(--color-feature-teal)",
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          className="w-4 h-4 text-feature-teal"
                        >
                          <rect x="3" y="3" width="7" height="7" rx="1.5" />
                          <rect x="14" y="3" width="7" height="7" rx="1.5" />
                          <rect x="3" y="14" width="7" height="7" rx="1.5" />
                          <rect x="14" y="14" width="7" height="7" rx="1.5" />
                        </svg>
                        <span className="text-xl font-extrabold text-feature-teal leading-none tabular-nums">
                          {screens.nodes.length}
                        </span>
                        <span className="text-xs font-bold text-feature-teal">
                          {t(language).intro.countsScreens}
                        </span>
                      </span>
                      <span
                        className="flex items-center gap-2 rounded-[14px] px-3.5 py-2 border-2"
                        style={{
                          background: "var(--color-feature-purple-soft)",
                          borderColor: "var(--color-feature-purple)",
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          className="w-4 h-4 text-feature-purple"
                        >
                          <path d="M9 8 A4 4 0 0 0 9 16 H11" />
                          <path d="M15 16 A4 4 0 0 0 15 8 H13" />
                        </svg>
                        <span className="text-xl font-extrabold text-feature-purple leading-none tabular-nums">
                          {screens.edges.length}
                        </span>
                        <span className="text-xs font-bold text-feature-purple">
                          {t(language).intro.countsLinks}
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                {/* 機能カードグリッド(4 枚)— 両モード共通 + モード連動表記 */}
                {screens.nodes.length > 0 && (
                  <div className="mb-6">
                    <FeatureCardGrid
                      nodes={screens.nodes}
                      edges={screens.edges}
                      language={language}
                      onCardClick={(id) => setSelectedNodeId(id)}
                      showDataDetails={viewMode === "database"}
                    />
                  </div>
                )}

                {/* v0.1.8 差分マップ:前回分析がある時だけ表示するトグルバー + 削除画面リスト */}
                {previousScreens && (
                  <div className="mb-3">
                    <div className="flex items-center gap-3 bg-paper border border-border-soft rounded-[12px] px-4 py-2.5 shadow-sm">
                      <span className="text-xs text-ink-strong font-semibold flex items-center gap-1.5">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: "#10b981" }}
                        />
                        {t(language).diff.toggleLabel}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={showDiff}
                        onClick={() => setShowDiff((v) => !v)}
                        className="w-9 h-5 rounded-full relative transition-colors cursor-pointer"
                        style={{ background: showDiff ? "#10b981" : "#cbd5e1" }}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all shadow ${
                            showDiff ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                      {showDiff && (
                        <span className="text-[11px] text-ink-soft flex-1">
                          {mapDiff.hasChanges ? (
                            <>
                              <span className="text-emerald-600 font-semibold">
                                {t(language).diff.addedNodesLabel(
                                  mapDiff.addedNodeIds.size,
                                )}
                              </span>
                              {" · "}
                              <span className="text-slate-500 font-semibold">
                                {t(language).diff.removedNodesLabel(
                                  mapDiff.removedNodes.length,
                                )}
                              </span>
                              {" · "}
                              <span className="text-orange-500 font-semibold">
                                {t(language).diff.addedEdgesLabel(
                                  mapDiff.addedEdges.size,
                                )}
                              </span>
                            </>
                          ) : (
                            <span className="italic">
                              {t(language).diff.noChanges}
                            </span>
                          )}
                          {mapDiff.ambiguousLabels.length > 0 && (
                            <span className="ml-1 text-amber-600">
                              {" · "}
                              {t(language).diff.ambiguousNote(
                                mapDiff.ambiguousLabels.length,
                              )}
                            </span>
                          )}
                        </span>
                      )}
                      {!showDiff && (
                        <span className="text-[11px] text-ink-soft italic flex-1">
                          {t(language).diff.toggleAvailable}
                        </span>
                      )}
                    </div>

                    {/* 削除された画面リスト(トグル ON かつ削除ありのときだけ)*/}
                    {showDiff && mapDiff.removedNodes.length > 0 && (
                      <div className="mt-2 bg-paper border border-border-soft rounded-[12px] px-4 py-2.5 shadow-sm">
                        <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                          {t(language).diff.removedSectionTitle}
                        </div>
                        <ul className="flex flex-wrap gap-1.5">
                          {mapDiff.removedNodes.map((rn) => (
                            <li
                              key={rn.id}
                              className="inline-flex items-center gap-1.5 text-xs bg-slate-50 border border-slate-200 rounded-full px-2.5 py-1 text-slate-600"
                              style={{ textDecoration: "line-through" }}
                            >
                              <span
                                className="text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded bg-slate-200 text-slate-600"
                                style={{ textDecoration: "none" }}
                              >
                                {t(language).diff.removedBadge}
                              </span>
                              {pickLocalized(rn.userIntent ?? rn.label, language)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* マインドマップ + 下部セクション — 詳細モードでは各画面に「使うデータ」チップを追加。
                    v0.1.10:data-tour は MapCanvas 内部の「アプリの全体像」カード div に
                    移動(この外側 wrapper だと下部セクションまで含んで広すぎるため)。*/}
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
                    language={language}
                    appSummary={screens.appSummary}
                    appName={appName}
                    nodeOffsets={nodeOffsets}
                    onNodeOffsetsChange={setNodeOffsets}
                    showDataDetails={viewMode === "database"}
                    folderPath={lastAnalyzedFolder}
                    notesTick={notesTick}
                    diffAddedNodeIds={
                      showDiff ? mapDiff.addedNodeIds : undefined
                    }
                    diffAddedEdgeIds={
                      showDiff ? mapDiff.addedEdges : undefined
                    }
                    isSample={aiResult === null}
                  />

                  <div className="mt-4">
                    <BottomSection
                      nodes={screens.nodes}
                      edges={screens.edges}
                      appSummary={screens.appSummary}
                      language={language}
                      showDataDetails={viewMode === "database"}
                    />
                  </div>
                </div>
              </>
            )}

            {activeNav === "impact" && screens.nodes.length > 0 && (
              <ImpactView
                nodes={screens.nodes}
                edges={screens.edges}
                language={language}
                onSelectNode={(id) => setSelectedNodeId(id)}
              />
            )}

            {activeNav === "checklist" && (
              <PreReleaseChecklist
                screens={screens}
                folderPath={lastAnalyzedFolder}
                language={language}
              />
            )}

            {activeNav === "project-overview" && screens.nodes.length > 0 && (
              <ProjectOverview
                nodes={screens.nodes}
                edges={screens.edges}
                appSummary={screens.appSummary}
                folderPath={lastAnalyzedFolder}
                engine={engine}
                costUsd={lastCostUsd}
                analyzedAt={
                  history.find(
                    (h) => h.folderPath === lastAnalyzedFolder,
                  )?.analyzedAt ?? null
                }
                language={language}
                showDataDetails={viewMode === "database"}
              />
            )}

            {activeNav === "project-data" && screens.nodes.length > 0 && (
              <ProjectData
                nodes={screens.nodes}
                language={language}
                onSelectNode={(id) => setSelectedNodeId(id)}
                showDataDetails={viewMode === "database"}
              />
            )}

            {activeNav === "project-settings" && (
              <ProjectSettings
                language={language}
                onLanguageChange={handleLanguageChange}
                engine={engine}
                onEngineChange={handleEngineChange}
                detailLevel={detailLevel}
                onDetailLevelChange={handleDetailLevelChange}
                noCodeMode={noCodeMode}
                onNoCodeModeChange={setNoCodeMode}
                history={history}
                onRemoveFromHistory={handleRemoveFromHistory}
              />
            )}
          </div>
        </main>
          <InspectorPanel
            node={selectedNode}
            allNodes={screens.nodes}
            allEdges={screens.edges}
            onClose={() => setSelectedNodeId(null)}
            noCodeMode={noCodeMode}
            language={language}
            onSelectNode={(id) => setSelectedNodeId(id)}
            folderPath={lastAnalyzedFolder}
            onNoteChange={() => setNotesTick((t) => t + 1)}
            engine={engine}
            preferredEditor={preferredEditor}
          />
        </div>
      </div>

      {/* v0.1.7 仕様書モーダル(root 直下、全画面 overlay) */}
      <SpecDocModal
        open={specDocOpen}
        onClose={() => setSpecDocOpen(false)}
        screens={screens}
        folderPath={lastAnalyzedFolder}
        language={language}
        nodeOffsets={nodeOffsets}
        showDataDetails={viewMode === "database"}
      />

      {/* v0.1.7 設定モーダル(AI エンジン切替 + v0.1.8 エディタ選択) */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        engine={engine}
        onEngineChange={handleEngineChange}
        language={language}
        preferredEditor={preferredEditor}
        onPreferredEditorChange={handlePreferredEditorChange}
      />

      {/* v0.1.10:ガイド付きツアー(サイドバー「ガイド付きツアー」から起動)*/}
      <GuidedTour
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        language={language}
        steps={buildTourSteps(language)}
      />
    </div>
  );
}

/** v0.1.10:ツアーステップ定義。data-tour 属性で対象を指定 */
function buildTourSteps(language: Language): TourStep[] {
  const isJa = language === "ja";
  if (isJa) {
    return [
      {
        title: "AppMap へようこそ",
        body: "AI で作ったアプリの中身を 1 枚の地図で把握できます。主要 6 機能を順に紹介します(1〜2 分)。",
        placement: "center",
      },
      {
        target: "folder-picker",
        title: "① 自分のアプリを読み込む",
        body: "アプリのフォルダを選ぶと、AI がコードを読んで「どんな画面があって、どうつながっているか」をマップに描きます。今表示中のものはお試し用のサンプルです。",
      },
      {
        target: "map-canvas",
        title: "② マップで全体像を見る",
        body: "マップの 1 つ 1 つが、アプリの要素です。線が要素同士のつながりを表します。要素をクリックすると右に説明が開き、AI に質問もできます。マップを 1 回クリックすると拡大・移動が有効に(外側クリックで固定に戻る)。",
        placement: "center",
      },
      {
        target: "mode-toggle",
        title: "③ かんたん / 詳細モード切替",
        body: "「かんたん」は日常の言葉(例:ログイン画面)。「詳細」にすると技術名や、その要素が扱うデータも表示します。",
      },
      {
        target: "nav-checklist",
        title: "④ コードチェック",
        body: "公開前に確認したい「うっかり残し」を 5 つチェックします:\n・APIキー / パスワードの直書き(公開すると誰でも使えてしまう)\n・自動テストの仕組みの有無\n・テストコードの有無\n・console.log の消し忘れ\n・TODO の見落とし\nコードを直して保存すると、AppMap が自動でチェックし直します。",
      },
      {
        target: "export",
        title: "⑤ 仕様書 / 共有 HTML を出力",
        body: "アプリの構造を 2 形式で出力できます:\n・仕様書(PDF):クライアントや上司に渡せる正式ドキュメント\n・共有 HTML:相手はブラウザで開くだけ(AppMap のインストール不要)",
      },
      {
        target: "engine-switch",
        title: "⑥ AI エンジン切替",
        body: "解析に使う AI を切り替えられます:\n・Claude(クラウド):高精度。API 利用料(従量制)\n・ローカル AI:PC 上で動く。無料・オフライン、精度は劣る\n設定では表示言語やエディタも選べます。",
      },
      {
        title: "以上です",
        body: "この案内は左下の「ガイド付きツアー」からいつでも見られます。触って試してみてください。",
        placement: "center",
      },
    ];
  }
  return [
    {
      title: "Welcome to AppMap",
      body: "Understand AI-generated apps as a single map. A quick tour of 6 key features (1-2 min).",
      placement: "center",
    },
    {
      target: "folder-picker",
      title: "1. Load your app",
      body: "Pick your app's folder and the AI reads the code and draws a map of what screens exist and how they connect. What you see now is sample data for trying things out.",
    },
    {
      target: "map-canvas",
      title: "2. See the whole picture",
      body: "Each item on the map is an element of your app; lines show how they connect. Click an element for its details on the right, where you can also ask the AI questions. Click the map once to enable pan and zoom (click outside to lock).",
      placement: "center",
    },
    {
      target: "mode-toggle",
      title: "3. Easy / Detailed mode",
      body: "'Easy' uses everyday labels (e.g. 'Login screen'). 'Detailed' adds engineer names and the data each element reads or writes.",
    },
    {
      target: "nav-checklist",
      title: "4. Code check",
      body: "Scans for 5 common leftovers to clean up before shipping:\n・API keys / passwords hardcoded (anyone can use them once published)\n・Whether a test framework is set up\n・Whether any test code exists\n・Forgotten console.log prints\n・Missed TODO notes\nRe-checks automatically when you save your code.",
    },
    {
      target: "export",
      title: "5. Export spec doc / share HTML",
      body: "Export the app's structure in two formats:\n・Spec doc (PDF): a formal document for a client or manager\n・Share HTML: recipients just open it in a browser (no AppMap install needed)",
    },
    {
      target: "engine-switch",
      title: "6. Switch AI engine",
      body: "Switch the AI used for analysis:\n・Claude (cloud): high accuracy. Uses Anthropic's API (pay-per-use)\n・Local AI: runs on your PC — free and offline, but less accurate\nSettings also let you change language and editor.",
    },
    {
      title: "That's it",
      body: "Reopen this tour anytime from 'Guided tour' at the bottom of the sidebar. Now try clicking around.",
      placement: "center",
    },
  ];
}

export default App;
