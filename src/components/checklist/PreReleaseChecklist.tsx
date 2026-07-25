import { useEffect, useState } from "react";
import type { ScreenMapResult } from "../../lib/claudeCli";
import type { Language } from "../../lib/i18n";
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

  useEffect(() => {
    let cancelled = false;
    setScanError(null);
    if (!folderPath) {
      setScan(null);
      return;
    }
    setScanning(true);
    runCodeScan(folderPath)
      .then((result) => {
        if (!cancelled) setScan(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setScan(null);
          setScanError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  const findings = buildFindings({ screens, scan, language });
  const highs = findings.filter((f) => f.severity === "high");
  const mids = findings.filter((f) => f.severity === "medium");
  const lows = findings.filter((f) => f.severity === "low");
  const assessment = computeOverallAssessment(findings, language);

  const isJa = language === "ja";
  const isSample = folderPath === null;
  const heading = isJa ? "リリース前チェック" : "Pre-release check";
  const intro = isJa
    ? "本番に出す前に確認しておきたい項目を、危険度の高い順に並べています。"
    : "Things to verify before shipping to production, sorted by risk.";
  const emptyState = isJa
    ? "重大な問題は見つかりませんでした。出荷準備が整っています!"
    : "No serious issues found. You're ready to ship!";
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
      ? `対象ファイル ${n} 件${truncated ? "(200 件で打切り)" : ""}を検査済み`
      : `${n} files scanned${truncated ? " (capped at 200)" : ""}`;

  return (
    <div className="mb-6">
      {/* ヘッダー */}
      <div className="mb-4">
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
        <p className="text-sm text-ink-soft mt-1">{intro}</p>
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
      <div className="mb-4 flex flex-wrap gap-2">
        <SummaryPill count={highs.length} severity="high" language={language} />
        <SummaryPill count={mids.length} severity="medium" language={language} />
        <SummaryPill count={lows.length} severity="low" language={language} />
      </div>

      {/* Findings */}
      {findings.length === 0 && !scanning ? (
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
        <ul className="space-y-2">
          {findings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              language={language}
              isSample={isSample}
            />
          ))}
        </ul>
      )}

      {/* 全体評価パネル(サンプル表示中も表示するが、明確にサンプル扱いだと分かるようマーキング)*/}
      {!scanning && findings.length > 0 && (
        <AssessmentPanel
          assessment={assessment}
          language={language}
          onOpenAIPrompt={() => setPromptOpen(true)}
          isSample={isSample}
        />
      )}

      {/* v0.1.8:AI 修正プロンプト・モーダル */}
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
  const aiButtonLabel = isJa
    ? "AI に依頼するプロンプトを生成"
    : "Generate an AI fix prompt";
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
    ? "AI に依頼するプロンプト"
    : "AI fix prompt";
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
  isSample = false,
}: {
  finding: Finding;
  language: Language;
  isSample?: boolean;
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
            {/* v0.1.8:サンプル表示中は各 finding にも「サンプル」チップを出す */}
            {isSample && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border"
                style={{
                  background: "rgba(212, 163, 115, 0.14)",
                  color: "#8a5a2b",
                  borderColor: "rgba(212, 163, 115, 0.55)",
                }}
              >
                {isJa ? "サンプル" : "Sample"}
              </span>
            )}
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

          {hasExamples && (
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
