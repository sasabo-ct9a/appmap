import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import Header from "./components/layout/Header";
import MapCanvas from "./components/canvas/MapCanvas";
import InspectorPanel from "./components/inspector/InspectorPanel";
import Button from "./components/ui/Button";
import Spinner from "./components/ui/Spinner";
import HistoryDropdown from "./components/ui/HistoryDropdown";
import SetupWizard from "./components/ui/SetupWizard";
import { sampleScreens } from "./data/sampleScreens";
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
  type StoredAnalysis,
} from "./lib/storage";

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

  // localStorage から最新の履歴を読み直す(削除や保存の後に呼ぶ)
  const refreshHistory = () => {
    const store = loadStore();
    setHistory(store.history);
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
    // 過去に成功分析が 1 件でもあれば、login も済んでいるはず。Backfill して
    // SetupWizard が「2/3 完了」と訴え続けないようにする。
    if (store.history.length > 0 && store.loginCompletedAt === undefined) {
      markLoginCompleted();
      setLoginCompletedAt(Date.now());
    } else {
      setLoginCompletedAt(store.loginCompletedAt ?? null);
    }
    if (store.currentFolderPath) {
      const entry = store.history.find(
        (e) => e.folderPath === store.currentFolderPath,
      );
      if (entry) {
        // 古い localStorage 形式(depth 欠落・複数 isEntryPoint 等)を、
        // 最新のルールに通してから state に流す(Codex review Med #3)。
        setAiResult(normalizeAndSanitizeScreenMap(entry.screens));
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

  // 表示するマップデータ: AI 結果があればそれを、なければサンプルにフォールバック
  //
  // ノードの y 座標は MapCanvas 側で depth から自動計算するため、ここで上書きしない。
  // x と depth だけが効く。
  const screens = aiResult ?? sampleScreens;

  const selectedNode =
    selectedNodeId !== null
      ? screens.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  const handlePickFolder = async () => {
    setAnalysisError(null);
    try {
      const result = await pickFolderAndListFiles();
      if (result === null) return;

      // 直前と同じフォルダ + AI 結果あり → 再分析確認(コスト防止)
      if (
        result.folder === lastAnalyzedFolder &&
        aiResult !== null &&
        lastCostUsd !== null
      ) {
        const proceed = await ask(
          `同じフォルダの再分析になります。前回 $${lastCostUsd.toFixed(4)} 消費しました。再実行しますか?`,
          { title: "再分析の確認", kind: "warning" },
        );
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
      const outcome = await analyzeFolderToScreenMap(result.folder);

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
      });
      refreshHistory();
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
    setAiResult(normalizeAndSanitizeScreenMap(entry.screens));
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

  /** 履歴から 1 件削除。現在表示中だったらサンプルに戻る。 */
  const handleRemoveFromHistory = (path: string) => {
    removeAnalysis(path);
    if (lastAnalyzedFolder === path) {
      handleResetToSample();
    }
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
    />
  );

  // ステータステキスト
  const statusText = (() => {
    if (claudeAvail.state === "checking") return "Claude CLI を確認中…";
    if (claudeAvail.state === "missing") {
      return "セットアップを完了してください(上の案内を参照)";
    }
    if (loginCompletedAt === null) {
      return "Claude にログインしてください(上の案内を参照)";
    }
    if (folderPath === null) {
      return `Claude CLI 検出 (${claudeAvail.version}) — サンプルマップ表示中、フォルダを選んで実分析`;
    }
    switch (analysisStatus) {
      case "loading":
        return `分析中: ${folderPath} (${fileCount} ファイル) — 経過 ${elapsedSec} 秒`;
      case "done":
        if (aiResult) {
          const costPart =
            lastCostUsd !== null ? ` / コスト $${lastCostUsd.toFixed(4)}` : "";
          // 構造系の数値は常に「画面 / リンク」で統一(Notion ネイティブ語)。
          // ノード/エッジ のグラフ用語、つながり の子供語、いずれも回避。
          return `AI 生成マップ表示中: ${aiResult.nodes.length} 画面 / ${aiResult.edges.length} リンク${costPart}(${folderPath})`;
        }
        return "完了";
      case "error":
        return null; // エラーは別 UI で表示(選択可能なテキスト)
      default:
        return `選択中: ${folderPath} (${fileCount} ファイル)`;
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
      />
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-auto px-6 py-12">
          <div className="mx-auto max-w-3xl">
            {setupWizard}

            {/* ツールバー */}
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <Button onClick={handlePickFolder} disabled={buttonDisabled}>
                {analysisStatus === "loading"
                  ? "分析中…"
                  : "フォルダを選ぶ"}
              </Button>

              <HistoryDropdown
                history={history}
                currentFolderPath={lastAnalyzedFolder}
                onSelect={handleSelectFromHistory}
                onRemove={handleRemoveFromHistory}
              />

              {aiResult !== null && analysisStatus !== "loading" ? (
                <Button variant="secondary" onClick={handleResetToSample}>
                  サンプルに戻す
                </Button>
              ) : null}

              {analysisStatus === "loading" ? (
                <Spinner className="w-4 h-4 text-electric-teal" />
              ) : null}

              {statusText !== null ? (
                <span className="text-sm text-soft-grid">{statusText}</span>
              ) : null}
            </div>

            {/* エラー本文(select-text で選択コピー可) */}
            {analysisStatus === "error" && analysisError ? (
              <pre className="bg-slate border border-charcoal rounded-[14px] p-4 mb-6 text-xs text-off-white whitespace-pre-wrap select-text font-mono leading-relaxed overflow-x-auto">
                <span className="text-soft-grid">エラー:</span> {analysisError}
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
                  サマリー
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
        />
      </div>
    </div>
  );
}

export default App;
