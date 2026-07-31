import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScreenMapResult } from "../../lib/claudeCli";
import type { Language } from "../../lib/i18n";
// v0.1.10:Engine import は AI 深掘り削除により不要に
import {
  buildAIFixPrompt,
  buildFindings,
  computeOverallAssessment,
  runCodeScan,
  type Finding,
  type OverallAssessment,
  type PreReleaseScanResult,
  type Severity,
  type Verdict,
} from "../../lib/preReleaseCheck";
// v0.1.10:AI 深掘り機能は全削除。リリース前チェックは実 grep ベースの
// 信頼度の高い検出結果のみを表示する構成に。

/**
 * v0.1.8 リリース前チェック UI。
 *
 * フロー:
 *   1. マウント時に folderPath があれば Rust の pre_release_scan を実行(重い)
 *   2. スクリーン情報 + scan 結果を buildFindings に流して Finding[] を得る
 *   3. severity 別のカード群で表示。各カードに「なぜ危険か / どう直すか」を添える
 *   4. examples があれば折り畳みで開く
 *
 * サンプル or 未分析フォルダでは scan は走らない(scan=null)。screen 起因の finding だけ出す。
 */
type PreReleaseChecklistProps = {
  screens: ScreenMapResult;
  folderPath: string | null;
  language: Language;
};

const SEVERITY_STYLE: Record<
  Severity,
  { label: string; badgeBg: string; badgeText: string; border: string; icon: string }
> = {
  high: {
    label: "HIGH",
    badgeBg: "#fee2e2",
    badgeText: "#b91c1c",
    border: "#fecaca",
    icon: "!",
  },
  medium: {
    label: "MED",
    badgeBg: "#fef3c7",
    badgeText: "#b45309",
    border: "#fde68a",
    icon: "!",
  },
  low: {
    label: "LOW",
    badgeBg: "#e0f2fe",
    badgeText: "#0369a1",
    border: "#bae6fd",
    icon: "i",
  },
};

function PreReleaseChecklist({
  screens,
  folderPath,
  language,
}: PreReleaseChecklistProps) {
  const [scan, setScan] = useState<PreReleaseScanResult | null>(null);
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // v0.1.8:AI 修正プロンプトのモーダル
  const [promptOpen, setPromptOpen] = useState<boolean>(false);
  // v0.1.9:「このチェックで確認していること」の折り畳み開閉
  const [scopeOpen, setScopeOpen] = useState<boolean>(false);

  // scan の状態管理:
  //   - scanningRef:進行中フラグ。イベントハンドラから「今 scan 中?」を判定するのに
  //     state だと stale closure になるため ref も持つ。
  //   - pendingRescanRef:scan 中に来たイベントを 1 件だけ保存(coalescing)。
  //     scan 完了直後に flush → 短時間に複数の folder-changed が来ても scan は
  //     多くて 1 段しか重ならない。
  //   - folderPathRef / scanNowRef:latest-ref パターン。scan 完了時に「まだ同じ
  //     フォルダを見ているか」の確認と、pending flush 時に最新の scanNow を使う。
  //     どちらも render body で同期する(useEffect の passive 実行を待つと commit
  //     直後に古い ref を参照する race がある)。
  const scanningRef = useRef(false);
  const pendingRescanRef = useRef(false);
  const scanNowRef = useRef<() => void>(() => {});
  const folderPathRef = useRef(folderPath);
  folderPathRef.current = folderPath;

  // v0.1.10:スキャン実行を関数化(初回 + フォーカス時 + 手動更新ボタンで共通に使う)
  const scanNow = useCallback(() => {
    const targetFolder = folderPath; // この scan が走っている間の「対象」を固定
    if (!targetFolder) {
      setScan(null);
      setScanError(null);
      return;
    }
    // 既に走ってる時はキューに 1 件だけ立てて終わる(coalescing)
    if (scanningRef.current) {
      pendingRescanRef.current = true;
      return;
    }
    scanningRef.current = true;
    setScanError(null);
    setScanning(true);
    runCodeScan(targetFolder, language)
      .then((result) => {
        // 完了時点で folder が変わっていたら結果を捨てる(stale scan 破棄)
        if (folderPathRef.current === targetFolder) {
          setScan(result);
        }
      })
      .catch((err) => {
        if (folderPathRef.current === targetFolder) {
          setScan(null);
          setScanError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        scanningRef.current = false;
        setScanning(false);
        if (pendingRescanRef.current) {
          pendingRescanRef.current = false;
          // 最新の scanNow(= 最新の folderPath に bind)で再実行。
          // 微タスク遅延で state 反映後、かつ folder 切替が反映された後に flush。
          Promise.resolve().then(() => scanNowRef.current());
        }
      });
  }, [folderPath, language]);

  // 常に最新の scanNow を指す(microtask flush から使うため render body で同期)
  scanNowRef.current = scanNow;

  // folderPath が変わったら、古いフォルダに対する pending は捨てる
  useEffect(() => {
    pendingRescanRef.current = false;
  }, [folderPath]);

  // 初回 + folderPath 変更時
  useEffect(() => {
    scanNow();
  }, [scanNow]);

  // ファイル監視で自動再スキャン。Rust の notify-debouncer-mini(500ms デバウンス済み)が
  // フォルダを常時監視し、Cursor / VS Code / CLI どれで保存しても検知する。
  //
  // watcher race を避けるため:
  //   - start は id (u64) を返す。stop は id 一致時のみクリア。
  //   - deps に scanning を入れない(scanningRef 経由)。入れると scan 開始/終了
  //     ごとに watcher が張り直され、古い stop が新 watcher を殺す。
  useEffect(() => {
    if (!folderPath) return;
    let cancelled = false;
    let myWatcherId: number | null = null;
    invoke<number>("start_folder_watch", { folder: folderPath })
      .then((id) => {
        if (cancelled) {
          // マウント中に unmount された場合。自分の watcher を即停止。
          invoke("stop_folder_watch", { id }).catch(() => {});
          return;
        }
        myWatcherId = id;
      })
      .catch((err) => {
        console.warn("start_folder_watch failed:", err);
      });
    const unlistenPromise = listen<void>("folder-changed", () => {
      if (cancelled) return;
      // scan 中は pending フラグを立てるだけ(scanNow 内で判定)
      scanNow();
    });
    return () => {
      cancelled = true;
      unlistenPromise.then((un) => un()).catch(() => {});
      if (myWatcherId !== null) {
        invoke("stop_folder_watch", { id: myWatcherId }).catch(() => {});
      }
    };
  }, [folderPath, scanNow]);

  const findings = buildFindings({ screens, scan, language });
  const highs = findings.filter((f) => f.severity === "high");
  const mids = findings.filter((f) => f.severity === "medium");
  const lows = findings.filter((f) => f.severity === "low");

  const isJa = language === "ja";
  const isSample = folderPath === null;
  // スキャン状態:失敗 or 未実行なら "Ready" と結論しない(誤った安心を与えないため)。
  //   ok:      scan 完了(finding から verdict 算出)
  //   sample:  サンプルモード(実データではない)
  //   failed:  scanError あり(Rust 側で例外)
  //   unavailable: 実フォルダ選択済みだが scan がまだ null(初回 or 再取得中)
  const scanState: "ok" | "sample" | "failed" | "unavailable" = isSample
    ? "sample"
    : scanError
      ? "failed"
      : scan
        ? "ok"
        : "unavailable";
  const isPartialCoverage = scanState === "ok" && !!scan?.files_truncated;
  const assessment = computeOverallAssessment(
    findings,
    language,
    scanState,
    isPartialCoverage,
  );
  // AI 修正プロンプトは「unknown ではない」+ finding あり の時だけ許可する。
  //   partial coverage(200 打ち切り)は verdict が unknown に落ちるため、ここで自動的に
  //   ボタンも無効化される。前回の scanState==='ok' 単体条件では unknown を含んでしまっていた。
  const promptButtonEnabled =
    assessment.verdict !== "unknown" && findings.length > 0;

  const heading = isJa ? "コードチェック" : "Code check";
  const intro = isJa
    ? "スキャンしたコードを、危険度の高い順に並べています。"
    : "Scanned code items, sorted by risk.";
  const emptyState = isJa
    ? "重大な問題は見つかりませんでした。出荷準備が整っています!"
    : "No serious issues found. You're ready to ship!";
  const unknownState = isJa
    ? "コード検査が完了していないため、判定を出せません。フォルダのアクセス権を確認するか、再度スキャンを実行してください。"
    : "The code check has not completed, so no verdict can be given. Check folder access or run the scan again.";
  const scanningText = isJa
    ? "コード全体をスキャン中…"
    : "Scanning the codebase…";
  const scanErrorPrefix = isJa
    ? "スキャン失敗(画面情報だけで判定します):"
    : "Scan failed (using screen data only):";
  const sampleNote = isJa
    ? "これはサンプルデータの参考表示です。実際のリスクではありません。フォルダを選んで分析すると本番診断が走ります。"
    : "This is a preview using sample data — not real findings. Analyze a folder to run the actual diagnosis.";
  const scannedNote = (n: number, truncated: boolean) =>
    isJa
      ? `対象ファイル ${n} 件を検査済み${truncated ? "(プロジェクトが大きく一部は未走査)" : ""}`
      : `${n} files scanned${truncated ? " (large project — some files not scanned)" : ""}`;
  // v0.1.9:このチェックが実際に何を見ているかの一覧(折り畳み)
  const scopeTitle = isJa
    ? "このチェックで確認していること"
    : "What this check looks at";
  type CheckItem = { name: string; desc: string };
  // v0.1.10 スリム化:9 項目 → 5 項目。AI 主観判定や誤検知率高の項目を除外し、
  //   実 grep / 実ファイル読みベースの高信頼度チェックに絞った。
  const scopeItems: CheckItem[] = isJa
    ? [
        {
          name: "秘密情報の直書き",
          desc: "API キー・パスワード・トークンがコードに直接書かれていないか(正規表現でパターン検出)",
        },
        {
          name: "テストフレームワーク",
          desc: "Vitest / Jest / Pytest 等のテスト環境が導入されているか(package.json 等を実読)",
        },
        {
          name: "テストファイル",
          desc: "*.test.* / *.spec.* / __tests__/ 配下のファイルが存在するか",
        },
        {
          name: "console.log の残り",
          desc: "本番に出す前に消すべき console.log がコード中にどれくらい残っているか",
        },
        {
          name: "TODO / FIXME コメント",
          desc: "未対応の作業メモが放置されていないか",
        },
      ]
    : [
        {
          name: "Hardcoded secrets",
          desc: "API keys / passwords / tokens written directly in code (regex-based pattern detection)",
        },
        {
          name: "Test framework",
          desc: "Whether Vitest / Jest / Pytest etc. is installed (reads package.json etc. directly)",
        },
        {
          name: "Test files",
          desc: "Whether *.test.* / *.spec.* / __tests__/ files exist",
        },
        {
          name: "Leftover console.log",
          desc: "How many console.log statements remain that should be removed before shipping",
        },
        {
          name: "TODO / FIXME comments",
          desc: "Whether unfinished-work markers have been left in the code",
        },
      ];

  return (
    <div className="mb-6">
      {/* ヘッダー */}
      <div className="mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2 flex-wrap">
            <ShieldIcon />
            {heading}
            {/* v0.1.8:サンプル表示中は amber バッジで明示(MapCanvas と統一) */}
            {isSample && (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border"
                style={{
                  background: "rgba(212, 163, 115, 0.14)",
                  color: "#8a5a2b",
                  borderColor: "rgba(212, 163, 115, 0.55)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#c98a3d",
                  }}
                />
                {isJa ? "サンプル" : "Sample"}
              </span>
            )}
          </h1>
          {/* v0.1.10:手動更新ボタン。フォルダ選択済み時のみ表示、スキャン中は disable */}
          {!isSample && (
            <button
              type="button"
              onClick={scanNow}
              disabled={scanning}
              className={`ml-auto inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-[10px] border transition-colors ${
                scanning
                  ? "text-ink-soft border-border-soft cursor-not-allowed opacity-60"
                  : "text-ink-strong border-border-soft hover:bg-canvas cursor-pointer bg-paper"
              }`}
              title={
                isJa
                  ? "スキャン結果を今すぐ更新(Cursor で編集後に押すと最新化)"
                  : "Re-run the scan now (press after editing in Cursor to refresh)"
              }
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`}
                aria-hidden="true"
              >
                <path d="M4 12 A8 8 0 0 1 20 8" />
                <path d="M16 8 H20 V4" />
                <path d="M20 12 A8 8 0 0 1 4 16" />
                <path d="M8 16 H4 V20" />
              </svg>
              {isJa
                ? scanning ? "更新中…" : "更新"
                : scanning ? "Updating…" : "Refresh"}
            </button>
          )}
        </div>
        <p className="text-sm text-ink-soft mt-1">{intro}</p>

        {/* v0.1.9:「このチェックで確認していること」の折り畳み。
            ユーザーがスコープを把握できるようにするための説明。 */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            aria-expanded={scopeOpen}
            className="text-[12px] text-ink-soft hover:text-ink transition-colors inline-flex items-center gap-1 cursor-pointer"
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                transform: scopeOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ▶
            </span>
            {scopeTitle}
            <span className="opacity-60">({scopeItems.length} {isJa ? "項目" : "items"})</span>
          </button>
          {scopeOpen && (
            <ul className="mt-2 rounded-[10px] border border-border-soft bg-paper px-4 py-3 space-y-1.5">
              {scopeItems.map((item, i) => (
                <li
                  key={i}
                  className="text-[12px] leading-relaxed flex gap-2"
                >
                  <span
                    className="flex-shrink-0 w-5 h-5 rounded-full bg-feature-teal-soft text-feature-teal text-[10px] font-bold flex items-center justify-center mt-0.5"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1">
                    <span className="font-semibold text-ink-strong">
                      {item.name}
                    </span>
                    <span className="text-ink-soft"> — {item.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* スキャン状態 */}
      {isSample && (
        <div
          className="mb-3 text-[12px] px-3 py-2.5 rounded-[8px] border flex items-start gap-2"
          style={{
            background: "rgba(212, 163, 115, 0.10)",
            borderColor: "rgba(212, 163, 115, 0.45)",
            color: "#7a4d24",
          }}
        >
          <span
            aria-hidden="true"
            className="flex-shrink-0 mt-0.5"
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#c98a3d",
            }}
          />
          <span className="leading-relaxed">{sampleNote}</span>
        </div>
      )}
      {scanning && (
        <div className="mb-3 flex items-center gap-2 text-[12px] text-ink-soft px-3 py-2">
          <span
            className="w-3 h-3 rounded-full border-2 border-feature-teal border-t-transparent animate-spin"
            aria-hidden="true"
          />
          {scanningText}
        </div>
      )}
      {scanError && (
        <div
          className="mb-3 text-[11px] rounded-[8px] px-3 py-2 border"
          style={{
            background: "#fef3c7",
            borderColor: "#fde68a",
            color: "#92400e",
          }}
        >
          {scanErrorPrefix} {scanError}
        </div>
      )}
      {scan && (
        <div className="mb-3 text-[11px] text-ink-soft">
          {scannedNote(scan.files_scanned, scan.files_truncated)}
        </div>
      )}

      {/* サマリー(件数バー)*/}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SummaryPill count={highs.length} severity="high" language={language} />
        <SummaryPill count={mids.length} severity="medium" language={language} />
        <SummaryPill count={lows.length} severity="low" language={language} />
      </div>

      {/* Findings */}
      {findings.length === 0 && !scanning ? (
        // 「重大なもの無し(緑バナー)」は scan 完了 かつ 全ファイル走査 かつ 実データ のときだけ。
        // sample / failed / unavailable / partial coverage はすべて「不明」表示に寄せる。
        scanState === "ok" && !isPartialCoverage ? (
          <div
            className="text-sm text-ink-strong px-4 py-6 rounded-[12px] border-2 border-dashed text-center"
            style={{ borderColor: "#a7f3d0", background: "#ecfdf5", color: "#065f46" }}
          >
            <div className="text-2xl mb-1">
              <CheckCircleIcon />
            </div>
            {emptyState}
          </div>
        ) : (
          <div
            className="text-sm px-4 py-6 rounded-[12px] border-2 border-dashed text-center"
            style={{
              borderColor: "#e5e7eb",
              background: "#f9fafb",
              color: "#374151",
            }}
          >
            {unknownState}
          </div>
        )
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} language={language} />
          ))}
        </ul>
      )}

      {/* 全体評価パネル。findings が無くても scan 未完了(unknown)状態は表示する。 */}
      {!scanning && (findings.length > 0 || scanState === "failed" || scanState === "unavailable") && (
        <AssessmentPanel
          assessment={assessment}
          language={language}
          onOpenAIPrompt={promptButtonEnabled ? () => setPromptOpen(true) : undefined}
          isSample={isSample}
        />
      )}

      {/* v0.1.8:Cursor 用一括修正プロンプト・モーダル */}
      {promptOpen && (
        <AIFixPromptModal
          promptText={buildAIFixPrompt({
            findings,
            screens,
            assessment,
            language,
          })}
          language={language}
          onClose={() => setPromptOpen(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 全体評価パネル
// ─────────────────────────────────────────────────────────
const VERDICT_STYLE: Record<
  Verdict,
  {
    bg: string;
    border: string;
    text: string;
    accent: string;
    scoreBg: string;
  }
> = {
  block: {
    bg: "#fef2f2",
    border: "#fecaca",
    text: "#7f1d1d",
    accent: "#dc2626",
    scoreBg: "#fee2e2",
  },
  caution: {
    bg: "#fffbeb",
    border: "#fde68a",
    text: "#78350f",
    accent: "#d97706",
    scoreBg: "#fef3c7",
  },
  ready: {
    bg: "#ecfdf5",
    border: "#a7f3d0",
    text: "#064e3b",
    accent: "#059669",
    scoreBg: "#d1fae5",
  },
  unknown: {
    // 中間色。緑(安心)と赤(危険)どちらとも紛らわしくないニュートラルグレー。
    bg: "#f9fafb",
    border: "#e5e7eb",
    text: "#374151",
    accent: "#6b7280",
    scoreBg: "#f3f4f6",
  },
};

function AssessmentPanel({
  assessment,
  language,
  onOpenAIPrompt,
  isSample = false,
}: {
  assessment: OverallAssessment;
  language: Language;
  onOpenAIPrompt?: () => void;
  isSample?: boolean;
}) {
  const isJa = language === "ja";
  const s = VERDICT_STYLE[assessment.verdict];
  const headingLabel = isJa ? "全体評価" : "Overall assessment";
  const priorityLabel = isJa ? "まず対応すべき項目" : "Fix these first";
  // v0.1.10 R4:「AI で深掘り」(per-finding 検証)と混同されないよう改名
  const aiButtonLabel = isJa
    ? "Cursor に貼る一括修正プロンプトを作成"
    : "Build a batch-fix prompt for Cursor";
  const aiButtonHint = isJa
    ? "Cursor / Claude Code などに貼るだけで一括修正を依頼できます"
    : "Paste into Cursor / Claude Code to request a batch fix";
  // v0.1.8:サンプル表示中は AI プロンプト生成を封じ、代わりに理由を表示
  const sampleAiHint = isJa
    ? "サンプル表示中は AI 修正プロンプトを生成できません。フォルダを選んで分析してください。"
    : "AI fix prompt is disabled while showing sample data. Analyze a folder first.";
  // v0.1.8:スコア表示を撤廃し、代わりにこのチェックが「網羅診断ではない」ことを常時明示
  const scopeNote = isJa
    ? "このチェックは「よくある抜け漏れ」だけを見ています。バグ・セキュリティ深堀・実際の動作確認は含みません。"
    : "This check only surfaces common gaps. It does NOT include bug detection, deep security audit, or runtime verification.";
  return (
    <div
      className="mt-5 rounded-[14px] border-2 shadow-sm overflow-hidden"
      style={{ background: s.bg, borderColor: s.border }}
    >
      {/* ヘッダー行:判定バッジ + タイトル + スコア円 */}
      <div className="flex items-start gap-4 px-5 py-4">
        <span
          className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center"
          style={{ background: s.accent }}
          aria-hidden="true"
        >
          <VerdictIcon verdict={assessment.verdict} />
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] font-bold uppercase tracking-wider mb-0.5 flex items-center gap-1.5 flex-wrap"
            style={{ color: s.accent }}
          >
            {headingLabel}
            {/* v0.1.8:サンプル表示中は評価もサンプル扱いだと明示 */}
            {isSample && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border normal-case tracking-normal"
                style={{
                  background: "rgba(212, 163, 115, 0.16)",
                  color: "#8a5a2b",
                  borderColor: "rgba(212, 163, 115, 0.6)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "#c98a3d",
                  }}
                />
                {isJa ? "サンプル" : "Sample"}
              </span>
            )}
          </div>
          <div
            className="text-xl font-bold leading-tight"
            style={{ color: s.text }}
          >
            {assessment.label}
          </div>
        </div>
        {/* v0.1.8:0-100 スコアは撤去。数字の権威性がユーザーに「品質保証」と誤読される害の方が大きかった */}
      </div>

      {/* サマリー文 + スコープ注釈(常時表示、verdict に関係なく)*/}
      <div className="px-5 pb-4">
        <p
          className="text-sm leading-relaxed"
          style={{ color: s.text }}
        >
          {assessment.summary}
        </p>
        <p
          className="mt-2 text-[11px] leading-relaxed"
          style={{ color: s.text, opacity: 0.72 }}
        >
          {scopeNote}
        </p>
      </div>

      {/* 優先アクション(ある時だけ)*/}
      {assessment.priorityTitles.length > 0 && (
        <div
          className="px-5 py-3 border-t"
          style={{ borderColor: s.border, background: s.scoreBg }}
        >
          <div
            className="text-[10px] font-bold uppercase tracking-wide mb-1.5"
            style={{ color: s.accent }}
          >
            {priorityLabel}
          </div>
          <ol className="space-y-1">
            {assessment.priorityTitles.map((title, i) => (
              <li
                key={i}
                className="text-xs flex items-start gap-2"
                style={{ color: s.text }}
              >
                <span
                  className="flex-shrink-0 w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center mt-0.5"
                  style={{ background: s.accent, color: "white" }}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span className="font-medium">{title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* v0.1.8:AI 修正プロンプト生成ボタン(サンプル表示中は無効化して理由を出す)*/}
      {onOpenAIPrompt && (
        <div
          className="px-5 py-3 border-t bg-paper flex items-center justify-between gap-3"
          style={{ borderColor: s.border }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink-strong">
              {aiButtonLabel}
            </div>
            <div className="text-[11px] text-ink-soft leading-snug">
              {isSample ? sampleAiHint : aiButtonHint}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenAIPrompt}
            disabled={isSample}
            title={isSample ? sampleAiHint : undefined}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-[10px] text-white text-xs font-bold transition-colors shadow-sm ${
              isSample
                ? "bg-ink-soft/60 cursor-not-allowed opacity-70"
                : "bg-feature-teal hover:bg-feature-teal/90 cursor-pointer"
            }`}
          >
            <SparkleIcon />
            {isJa ? "生成" : "Generate"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// AI 修正プロンプト・モーダル
// ─────────────────────────────────────────────────────────
function AIFixPromptModal({
  promptText,
  language,
  onClose,
}: {
  promptText: string;
  language: Language;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isJa = language === "ja";
  const title = isJa
    ? "Cursor に貼る一括修正プロンプト"
    : "Batch-fix prompt for Cursor";
  const description = isJa
    ? "このテキストをそのまま Cursor / Claude Code / ChatGPT などに貼り付けて、一括修正を依頼できます。編集も可能です。"
    : "Paste this into Cursor / Claude Code / ChatGPT to request a batch fix. You can also edit it before copying.";
  const copyLabel = isJa ? "コピー" : "Copy";
  const copiedLabel = isJa ? "コピーしました!" : "Copied!";
  const closeLabel = isJa ? "閉じる" : "Close";

  const [editedText, setEditedText] = useState(promptText);
  useEffect(() => setEditedText(promptText), [promptText]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("[AppMap] clipboard.writeText failed:", err);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-strong/40 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(880px,96vw)] h-[min(720px,90vh)] bg-paper rounded-[16px] border border-border-soft shadow-2xl flex flex-col overflow-hidden"
      >
        {/* ヘッダー */}
        <header className="relative px-6 pt-5 pb-4 border-b border-border-soft flex-shrink-0">
          <div
            className="absolute left-0 top-5 bottom-4 w-1 rounded-r"
            style={{ background: "var(--color-feature-teal)" }}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-md text-ink-soft hover:bg-canvas transition-colors cursor-pointer text-lg leading-none"
          >
            ×
          </button>
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full text-white"
              style={{ background: "var(--color-feature-teal)" }}
            >
              <SparkleIcon /> AI PROMPT
            </span>
          </div>
          <h2 className="text-xl font-bold text-ink-strong">{title}</h2>
          <p className="text-xs text-ink-soft mt-1">{description}</p>
        </header>

        {/* テキストエリア */}
        <div className="flex-1 overflow-y-auto bg-canvas p-5">
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            spellCheck={false}
            className="w-full h-full bg-paper border border-border-soft rounded-[10px] p-4 text-[12.5px] text-ink-strong font-mono leading-relaxed outline-none resize-none focus:border-feature-teal focus:ring-2 focus:ring-feature-teal/30 transition-colors"
            style={{ minHeight: 380 }}
          />
        </div>

        {/* フッター */}
        <footer className="flex items-center justify-between gap-2 px-6 py-3 border-t border-border-soft flex-shrink-0 bg-paper">
          <span className="text-[11px] text-ink-soft">
            {isJa
              ? "編集後にコピーできます。文字数:"
              : "You can edit before copying. Length: "}
            <span className="tabular-nums font-semibold">{editedText.length}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] px-4 py-2 text-sm border border-border-soft text-ink hover:bg-canvas cursor-pointer transition-colors bg-paper"
            >
              {closeLabel}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-[10px] px-4 py-2 text-sm bg-feature-teal hover:bg-feature-teal/90 text-white cursor-pointer transition-colors font-semibold shadow-sm flex items-center gap-1.5"
            >
              {copied ? <CheckIcon /> : <ClipboardIcon />}
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-3.5 h-3.5"
    >
      <path d="M12 4 L14 10 L20 12 L14 14 L12 20 L10 14 L4 12 L10 10 Z" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-4 h-4"
    >
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8 V6 A2 2 0 0 0 14 4 H6 A2 2 0 0 0 4 6 V14 A2 2 0 0 0 6 16 H8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="w-4 h-4"
    >
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  const stroke = "white";
  if (verdict === "block") {
    // Stop / X icon
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-6 h-6"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8 8 L16 16 M16 8 L8 16" />
      </svg>
    );
  }
  if (verdict === "caution") {
    // Warning triangle
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-6 h-6"
      >
        <path d="M12 3 L21 20 H3 Z" />
        <path d="M12 10 V14" />
        <circle cx="12" cy="17" r="0.6" fill={stroke} />
      </svg>
    );
  }
  // ready:shield check
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-6 h-6"
    >
      <path d="M12 3 L20 6 V13 A9 9 0 0 1 12 21 A9 9 0 0 1 4 13 V6 Z" />
      <path d="M9 12 L11 14 L15 10" />
    </svg>
  );
}

function SummaryPill({
  count,
  severity,
  language,
}: {
  count: number;
  severity: Severity;
  language: Language;
}) {
  const s = SEVERITY_STYLE[severity];
  const isJa = language === "ja";
  const label =
    severity === "high"
      ? isJa
        ? "重大"
        : "High"
      : severity === "medium"
        ? isJa
          ? "中"
          : "Medium"
        : isJa
          ? "軽微"
          : "Low";
  return (
    <span
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[10px] border text-xs font-semibold"
      style={{
        background: s.badgeBg,
        borderColor: s.border,
        color: s.badgeText,
      }}
    >
      <span className="text-base font-bold tabular-nums">{count}</span>
      {label}
    </span>
  );
}

function FindingCard({
  finding,
  language,
}: {
  finding: Finding;
  language: Language;
}) {
  const s = SEVERITY_STYLE[finding.severity];
  const [open, setOpen] = useState(false);
  const isJa = language === "ja";
  const hasExamples =
    Array.isArray(finding.examples) && finding.examples.length > 0;
  return (
    <li
      className="rounded-[12px] border bg-paper shadow-sm overflow-hidden"
      style={{ borderColor: s.border }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center font-black text-sm"
          style={{ background: s.badgeBg, color: s.badgeText }}
          aria-hidden="true"
        >
          {s.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span
              className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
              style={{ background: s.badgeBg, color: s.badgeText }}
            >
              {s.label}
            </span>
            <h3 className="text-sm font-bold text-ink-strong">
              {finding.title}
            </h3>
          </div>
          <p className="text-xs text-ink leading-relaxed">{finding.hint}</p>

          {/* 具体的な改善ステップ(常時表示、番号付き)*/}
          {finding.fixSteps && finding.fixSteps.length > 0 && (
            <div className="mt-2.5 rounded-[8px] bg-canvas border border-border-soft px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-feature-teal mb-1.5 flex items-center gap-1">
                <WrenchIcon />
                {isJa ? "改善のしかた" : "How to fix"}
              </div>
              <ol className="space-y-1.5">
                {finding.fixSteps.map((step, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[11.5px] text-ink-strong leading-relaxed"
                  >
                    <span
                      className="flex-shrink-0 w-4 h-4 rounded-full bg-feature-teal-soft text-feature-teal text-[10px] font-bold flex items-center justify-center mt-0.5"
                      aria-hidden="true"
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1"
                      dangerouslySetInnerHTML={{ __html: renderInlineCode(step) }}
                    />
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* v0.1.10:examples が「file 名だけ」の場合は、トグルを出さず直接インライン表示。
              line / snippet が実質的な内容として存在する時のみ従来通り折り畳みトグルにする。
              リスク高画面や multi-entry のように「該当は画面名だけ」の finding で
              『詳細を見る (1 件)』→ クリック → 画面名 1 個、という無駄なひと手間を省く。 */}
          {hasExamples && (() => {
            const anyDetailed = finding.examples!.some(
              (ex) => ex.line !== undefined || (ex.snippet && ex.snippet.trim() !== ""),
            );
            if (!anyDetailed) {
              const fileList = finding
                .examples!.map((ex) => ex.file)
                .filter(Boolean);
              const moreCount =
                finding.count !== undefined && finding.count > fileList.length
                  ? finding.count - fileList.length
                  : 0;
              return (
                <div className="mt-2 text-[11.5px] text-ink-soft leading-relaxed">
                  <span className="font-semibold text-ink">
                    {isJa ? "該当:" : "Affected:"}
                  </span>{" "}
                  {fileList.map((f, i) => (
                    <span key={i}>
                      <span className="font-mono text-ink-strong">{f}</span>
                      {i < fileList.length - 1 && ", "}
                    </span>
                  ))}
                  {moreCount > 0 && (
                    <span className="italic">
                      {isJa ? ` ... 他 ${moreCount} 件` : `... and ${moreCount} more`}
                    </span>
                  )}
                </div>
              );
            }
            return null;
          })()}

          {/* トグル版:line / snippet がある実質的な examples の時だけ */}
          {hasExamples &&
            finding.examples!.some(
              (ex) => ex.line !== undefined || (ex.snippet && ex.snippet.trim() !== ""),
            ) && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-[11px] text-ink-soft underline hover:text-ink transition-colors mt-1.5 cursor-pointer"
            >
              {open
                ? isJa
                  ? "詳細を閉じる"
                  : "Hide details"
                : isJa
                  ? `詳細を見る (${finding.count ?? finding.examples!.length} 件)`
                  : `Show details (${finding.count ?? finding.examples!.length})`}
            </button>
          )}
          {open && hasExamples && (
            <ul className="mt-2 space-y-1 bg-canvas rounded-[8px] p-2 border border-border-soft">
              {finding.examples!.map((ex, i) => (
                <li key={i} className="text-[11px] text-ink-strong font-mono">
                  <span className="text-ink-soft">{ex.file}</span>
                  {ex.line !== undefined && (
                    <span className="text-ink-soft">:{ex.line}</span>
                  )}
                  {ex.snippet && (
                    <span className="text-ink block ml-3 truncate">
                      {ex.snippet}
                    </span>
                  )}
                </li>
              ))}
              {finding.count !== undefined &&
                finding.examples &&
                finding.count > finding.examples.length && (
                  <li className="text-[10px] text-ink-soft italic pl-1">
                    {isJa
                      ? `... 他 ${finding.count - finding.examples.length} 件`
                      : `... and ${finding.count - finding.examples.length} more`}
                  </li>
                )}
            </ul>
          )}

        </div>
      </div>
    </li>
  );
}


function WrenchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-3 h-3"
    >
      <path d="M14 6 A4 4 0 0 0 20 12 L12 20 L4 14 L12 6 A4 4 0 0 0 18 4 L15 7 L17 9 L20 6" />
    </svg>
  );
}

/**
 * 改善ステップ内の `code` を <code> に整形。他は HTML エスケープ。
 * ノーコード経験者にも「これはコマンドや変数」だと視覚的に伝わるようにする。
 */
function renderInlineCode(text: string): string {
  // まず HTML 特殊文字を全部エスケープしてから、`...` を <code> に置換
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  // 対応:バッククォート囲み(バッククォート自体はエスケープ後でも `` のまま残る)
  return escaped.replace(
    /`([^`]+)`/g,
    '<code style="background:#f1f5f9;color:#0f172a;padding:1px 5px;border-radius:4px;font-family:\'JetBrains Mono\',ui-monospace,monospace;font-size:11px;">$1</code>',
  );
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-feature-teal)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-6 h-6"
    >
      <path d="M12 3 L20 6 V13 A9 9 0 0 1 12 21 A9 9 0 0 1 4 13 V6 Z" />
      <path d="M9 12 L11 14 L15 10" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#059669"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-8 h-8 inline"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12 L11 15 L16 9" />
    </svg>
  );
}

export default PreReleaseChecklist;
