import { useEffect, useMemo, useState } from "react";
import { buildSpecDoc, type SpecAudience } from "../../lib/specDoc";
import type { ScreenMapResult } from "../../lib/claudeCli";
import { t, type Language } from "../../lib/i18n";
import SpecDocMap from "../canvas/SpecDocMap";

/**
 * 仕様書プレビューモーダル(v0.1.7)。
 *
 * 役割:
 *   - 「想定読者」を 3 段トグルで切替(engineer / noCode / endUser)
 *   - その都度 specDoc.buildSpecDoc() で Markdown を再生成してプレビュー
 *   - 「Markdown をコピー」→ navigator.clipboard.writeText
 *   - 「PDF で保存」→ window.print()(@media print で本文だけ印刷)
 *   - 背景クリック / × / Esc で閉じる
 *
 * 設計判断:
 *   - 追加 AI コール無し:既存マップから決定的に生成 → 追加コスト $0、瞬時
 *   - Markdown を生で表示(リアルタイム描画ライブラリは追加しない、KISS §7)
 *     プレビューは pre + 等幅で十分。受信側で Markdown viewer に貼り直せる
 *   - 印刷時の見た目は index.css の @media print でコントロール
 */
type SpecDocModalProps = {
  open: boolean;
  onClose: () => void;
  screens: ScreenMapResult;
  folderPath: string | null;
  language: Language;
  /** ユーザーが MapCanvas でドラッグ移動した位置を PDF に反映 */
  nodeOffsets?: Map<number, { x: number; y: number }>;
};

function SpecDocModal({
  open,
  onClose,
  screens,
  folderPath,
  language,
  nodeOffsets,
}: SpecDocModalProps) {
  const T = t(language).specDoc;
  const [audience, setAudience] = useState<SpecAudience>("noCode");
  const [copyToastUntil, setCopyToastUntil] = useState<number>(0);

  // 開閉に応じて Esc キーで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // audience / language / screens が変わるたび再生成。生成は決定的 + 軽量なので毎回回す。
  const markdown = useMemo(
    () =>
      buildSpecDoc({
        screens,
        audience,
        language,
        folderPath,
      }),
    [screens, audience, language, folderPath],
  );

  // コピー後 2 秒間「コピーしました」表示。Date.now() は許可済み(runtime コード)。
  const showCopied = copyToastUntil > Date.now();
  useEffect(() => {
    if (!showCopied) return;
    const remain = copyToastUntil - Date.now();
    const tid = setTimeout(() => setCopyToastUntil(0), remain);
    return () => clearTimeout(tid);
  }, [showCopied, copyToastUntil]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyToastUntil(Date.now() + 2000);
    } catch (err) {
      // クリップボード API が落ちた場合は手動コピーへ。落ちることはほぼ無いが保険。
      console.warn("[AppMap] clipboard.writeText failed:", err);
    }
  };

  const handlePrint = () => {
    // @media print で .spec-doc-printable だけが残るように index.css 側で制御。
    // Tauri webview は window.print() で OS の印刷ダイアログを開く → 「PDF として保存」を選ぶ。
    window.print();
  };

  if (!open) return null;

  const audienceOptions: { key: SpecAudience; label: string }[] = [
    { key: "engineer", label: T.audienceEngineer },
    { key: "noCode", label: T.audienceNoCode },
    { key: "endUser", label: T.audienceEndUser },
  ];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-strong/40 backdrop-blur-sm spec-doc-modal-overlay px-4"
      role="dialog"
      aria-modal="true"
      aria-label={T.modalTitle}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(960px,96vw)] h-[min(760px,92vh)] bg-paper rounded-[16px] border border-border-soft shadow-2xl flex flex-col overflow-hidden"
      >
        {/* ヘッダー */}
        <header className="relative px-6 pt-5 pb-4 border-b border-border-soft flex-shrink-0">
          {/* 左端の teal アクセントバー */}
          <div
            className="absolute left-0 top-5 bottom-4 w-1 rounded-r"
            style={{ background: "var(--color-feature-teal)" }}
            aria-hidden="true"
          />

          {/* 閉じる × */}
          <button
            type="button"
            onClick={onClose}
            aria-label={T.closeButton}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-md text-ink-soft hover:bg-canvas transition-colors cursor-pointer text-lg leading-none"
          >
            ×
          </button>

          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full text-white"
              style={{ background: "var(--color-feature-teal)" }}
            >
              <DocIcon /> {T.audienceLabel ?? "EXPORT"}
            </span>
          </div>
          <h2 className="text-xl font-bold text-ink-strong">{T.modalTitle}</h2>
          <p className="text-xs text-ink-soft mt-1">
            {language === "ja"
              ? "想定読者に合わせて表記を切り替えられます。"
              : "Switch wording to suit your audience."}
          </p>

          {/* audience セグメントピル */}
          <div
            role="group"
            aria-label={T.audienceLabel}
            className="mt-4 inline-flex items-center bg-canvas rounded-[10px] p-1 border border-border-soft"
          >
            {audienceOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setAudience(opt.key)}
                aria-pressed={audience === opt.key}
                className={`px-3 py-1.5 rounded-[8px] text-xs font-semibold transition-colors cursor-pointer ${
                  audience === opt.key
                    ? "bg-feature-teal text-white shadow-sm"
                    : "text-ink hover:bg-paper"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </header>

        {/* プレビュー本体 */}
        <div className="flex-1 overflow-y-auto bg-canvas spec-doc-printable">
          {/* アプリ全体像のマインドマップ(PDF 先頭ページに来る)*/}
          {screens.nodes.length > 0 && (
            <div className="bg-paper m-5 mb-3 rounded-[12px] border border-border-soft p-5 shadow-sm spec-doc-map-block">
              <div className="text-[11px] font-bold text-ink-soft uppercase tracking-wide mb-2">
                {language === "ja" ? "アプリの全体像" : "App overview"}
              </div>
              <SpecDocMap
                nodes={screens.nodes}
                edges={screens.edges}
                language={language}
                nodeOffsets={nodeOffsets}
              />
            </div>
          )}
          <div className="bg-paper m-5 rounded-[12px] border border-border-soft p-6 shadow-sm spec-doc-text-block">
            <pre className="text-[12.5px] text-ink-strong font-mono leading-relaxed whitespace-pre-wrap select-text">
              {markdown}
            </pre>
          </div>
        </div>

        {/* PDF 用ウォーターマーク(screen では非表示、print 時のみ右下に固定)*/}
        <div className="spec-doc-watermark" aria-hidden="true">
          <WatermarkLogo />
          <span>AppMap</span>
        </div>

        {/* フッター */}
        <footer className="flex items-center justify-between gap-2 px-6 py-3 border-t border-border-soft flex-shrink-0 bg-paper">
          <span className="text-[11px] text-ink-soft">
            {language === "ja"
              ? "AI 追加コストなし・即時生成"
              : "No extra AI cost · generated instantly"}
          </span>
          <div className="flex items-center gap-2">
            {showCopied && (
              <span
                className="inline-flex items-center gap-1 text-xs font-semibold text-feature-teal mr-1"
                role="status"
                aria-live="polite"
              >
                <CheckIcon /> {T.copied}
              </span>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-[12px] px-4 py-2 text-sm border border-border-soft text-ink hover:bg-canvas cursor-pointer transition-colors bg-paper"
            >
              <CopyIcon /> {T.copyButton}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-[12px] px-4 py-2 text-sm bg-feature-teal hover:bg-feature-teal/90 text-white cursor-pointer transition-colors font-semibold shadow-sm"
            >
              <DownloadIcon /> {T.printButton}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DocIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-3 h-3"
    >
      <path d="M6 3 H14 L18 7 V21 H6 Z" />
      <path d="M14 3 V7 H18" />
    </svg>
  );
}

function CopyIcon() {
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

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="w-4 h-4"
    >
      <path d="M12 4 V15" />
      <path d="M7 10 L12 15 L17 10" />
      <path d="M4 20 H20" />
    </svg>
  );
}

function WatermarkLogo() {
  // 4-quad のシンプルな AppMap ブランドマーク(印刷時のみ表示)
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
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
      className="w-3.5 h-3.5"
    >
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

export default SpecDocModal;
