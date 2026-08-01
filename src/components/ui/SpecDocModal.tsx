import { useEffect, useMemo, useState } from "react";
import { buildSpecDoc, type SpecAudience } from "../../lib/specDoc";
import type { ScreenMapResult } from "../../lib/claudeCli";
import { t, type Language } from "../../lib/i18n";
import SpecDocMap from "../canvas/SpecDocMap";

/**
 * 仕様書プレビューモーダル(v0.1.7)。
 *
 * 役割:
 *   - v0.1.8:想定読者を 2 段トグルで切替(engineer / noCode)。旧 endUser は削除
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
  /** 詳細モード(DB スキーマ表示)を PDF マップにも反映 */
  showDataDetails?: boolean;
};

function SpecDocModal({
  open,
  onClose,
  screens,
  folderPath,
  language,
  nodeOffsets,
  showDataDetails = false,
}: SpecDocModalProps) {
  const T = t(language).specDoc;
  const [audience, setAudience] = useState<SpecAudience>("noCode");
  const [copyToastUntil, setCopyToastUntil] = useState<number>(0);
  // v0.1.7 編集可能:ユーザーが textarea で書き換えた内容を保持。null = 未編集(生成版そのまま)
  const [editedMarkdown, setEditedMarkdown] = useState<string | null>(null);
  // v0.1.7 追加:作成者名。空文字なら仕様書側で ＿＿＿＿ にフォールバック
  const [authorName, setAuthorName] = useState<string>("");
  const storageKey = folderPath
    ? `appmap:specdoc:v1:${folderPath}`
    : "appmap:specdoc:v1:sample";
  const authorStorageKey = folderPath
    ? `appmap:specdoc-author:v1:${folderPath}`
    : "appmap:specdoc-author:v1:sample";

  // 開閉に応じて Esc キーで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // audience / language / screens / authorName が変わるたび自動再生成(内部)
  const generatedMarkdown = useMemo(
    () =>
      buildSpecDoc({
        screens,
        audience,
        language,
        folderPath,
        authorName,
      }),
    [screens, audience, language, folderPath, authorName],
  );

  // モーダル open 時に localStorage から読込(編集内容 + 作成者名)
  useEffect(() => {
    if (!open) return;
    try {
      const saved = localStorage.getItem(storageKey);
      setEditedMarkdown(saved && saved.length > 0 ? saved : null);
    } catch {
      setEditedMarkdown(null);
    }
    try {
      const savedAuthor = localStorage.getItem(authorStorageKey);
      setAuthorName(savedAuthor ?? "");
    } catch {
      setAuthorName("");
    }
  }, [open, storageKey, authorStorageKey]);

  // 作成者名の永続化(入力ごとに保存、量は少ないので debounce 不要)
  const handleAuthorChange = (v: string) => {
    setAuthorName(v);
    try {
      if (v.length === 0) localStorage.removeItem(authorStorageKey);
      else localStorage.setItem(authorStorageKey, v);
    } catch {
      // storage full 時は諦める
    }
  };

  // 実際に表示する markdown:編集版があればそれ、無ければ生成版
  const markdown = editedMarkdown ?? generatedMarkdown;

  // 編集内容を localStorage に保存(debounce 無し、量少ないので都度書きで OK)
  const handleEdit = (v: string) => {
    setEditedMarkdown(v);
    try {
      localStorage.setItem(storageKey, v);
    } catch {
      // storage full 時は諦める(UI 上は状態保持)
    }
  };

  // 自動再生成(編集を破棄)
  const handleRegenerate = () => {
    setEditedMarkdown(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  };

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

  // v0.1.8:「エンドユーザー」は実質未実装だったため削除。2 択に絞ってそれぞれ実際に切り替える
  const audienceOptions: { key: SpecAudience; label: string }[] = [
    { key: "noCode", label: T.audienceNoCode },
    { key: "engineer", label: T.audienceEngineer },
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
        className="w-[min(1240px,96vw)] h-[min(820px,94vh)] bg-paper rounded-[16px] border border-border-soft shadow-2xl flex flex-col overflow-hidden spec-doc-panel"
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
              ? "用途で詳しさを切り替え(やさしい=共有・理解 / 正式=納品・要件定義との突き合わせ)。"
              : "Switch depth by purpose (Simple = share & understand · Formal = delivery & comparison)."}
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

          {/* v0.1.7 追加:作成者名入力(独立ブロックで目立たせる)*/}
          <div className="mt-4 flex items-start gap-3 bg-canvas border border-border-soft rounded-[10px] p-3">
            <span
              className="flex-shrink-0 w-8 h-8 rounded-md bg-feature-teal-soft flex items-center justify-center"
              aria-hidden="true"
            >
              <PenIcon />
            </span>
            <div className="flex-1 min-w-0">
              <label
                htmlFor="specdoc-author-input"
                className="block text-xs font-bold text-ink-strong mb-1"
              >
                {language === "ja"
                  ? "この仕様書の作成者名"
                  : "Author of this spec"}
              </label>
              <input
                id="specdoc-author-input"
                type="text"
                value={authorName}
                onChange={(e) => handleAuthorChange(e.target.value)}
                placeholder={
                  language === "ja"
                    ? "例:山田 太郎(空欄なら ＿＿＿＿ になります)"
                    : "e.g. Jane Doe (blank keeps ＿＿＿＿)"
                }
                spellCheck={false}
                className="w-full bg-paper border border-border-soft rounded-[8px] px-3 py-2 text-sm text-ink-strong outline-none focus:border-feature-teal focus:ring-2 focus:ring-feature-teal/30 transition-colors"
              />
              <p className="text-[11px] text-ink-soft mt-1.5">
                {language === "ja"
                  ? "入力した名前が仕様書冒頭の「作成者」欄と変更履歴に反映されます。"
                  : "This name appears in the spec's header and change log."}
                {editedMarkdown !== null && authorName.length > 0 && (
                  <span className="text-feature-teal font-semibold ml-1">
                    {language === "ja"
                      ? "※ 編集中は再生成で反映"
                      : "※ regenerate to apply while edits are active"}
                  </span>
                )}
              </p>
            </div>
          </div>
        </header>

        {/* プレビュー本体 */}
        <div className="flex-1 overflow-y-auto bg-canvas spec-doc-printable">
          {/* アプリ全体像のマインドマップ(PDF 先頭ページに来る)*/}
          {screens.nodes.length > 0 && (
            <div className="bg-paper mx-4 mt-4 mb-2 rounded-[12px] border border-border-soft px-4 py-3 shadow-sm spec-doc-map-block">
              <div className="text-[11px] font-bold text-ink-soft uppercase tracking-wide mb-2">
                {language === "ja" ? "アプリの全体像" : "App overview"}
              </div>
              {/* 見切れない程度に大きく見せる。SVG は width:100% / height:auto で
                  親幅を必ず使い切る。以前 height:100% + flex にしていたら横長 viewBox が
                  高さ側で先にフィットしてしまい、左右に大きな余白ができていた */}
              <div className="spec-doc-map-wrap w-full">
                <SpecDocMap
                  nodes={screens.nodes}
                  edges={screens.edges}
                  language={language}
                  nodeOffsets={nodeOffsets}
                  showDataDetails={showDataDetails}
                />
              </div>
            </div>
          )}
          <div className="bg-paper m-5 rounded-[12px] border border-border-soft p-6 shadow-sm spec-doc-text-block">
            {/* v0.1.7:編集可能な textarea。空白の ＿＿＿＿ を直接埋められる。localStorage に自動保存 */}
            <textarea
              value={markdown}
              onChange={(e) => handleEdit(e.target.value)}
              spellCheck={false}
              className="w-full bg-transparent border-0 outline-none resize-none text-[12.5px] text-ink-strong font-mono leading-relaxed select-text"
              style={{ minHeight: 600 }}
            />
            {/* PDF 印刷用:textarea は @media print で不可視になりがちなので、
                同じ内容の pre を透明で敷いておく(印刷レイアウトが崩れない)*/}
            <pre
              aria-hidden="true"
              className="hidden print:block text-[12.5px] text-ink-strong font-mono leading-relaxed whitespace-pre-wrap"
            >
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
            {editedMarkdown !== null
              ? language === "ja"
                ? "編集内容を自動保存中(このフォルダに紐付き)"
                : "Edits auto-saved to this folder"
              : language === "ja"
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
            {editedMarkdown !== null && (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      language === "ja"
                        ? "編集内容を破棄して自動生成に戻しますか?"
                        : "Discard edits and regenerate?",
                    )
                  ) {
                    handleRegenerate();
                  }
                }}
                className="flex items-center gap-1.5 rounded-[12px] px-3 py-2 text-xs border border-border-soft text-ink-soft hover:bg-canvas cursor-pointer transition-colors bg-paper"
                title={language === "ja" ? "編集破棄で再生成" : "Discard and regenerate"}
              >
                <RegenIcon /> {language === "ja" ? "再生成" : "Regenerate"}
              </button>
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
  // v0.1.8:LogoMark と揃えた Tilted Needle 羅針盤(単色版、印刷時のみ表示)。
  //         印刷 CSS 側で color: #14b8a6 を強制するため currentColor で受ける。
  //         2 色針は cost が高いので、単色でも針の方向感が伝わるよう傾いた菱形 1 つ + 中央ドットに簡略化。
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      {/* 羅針盤の外周円 */}
      <circle cx="12" cy="12" r="9" opacity="0.6" />
      {/* 傾いた針(35deg、菱形)*/}
      <g transform="rotate(35 12 12)">
        <path
          d="M12 3.5 L14 12 L12 10 L10 12 Z"
          fill="currentColor"
          stroke="none"
        />
        <path
          d="M12 20.5 L14 12 L12 14 L10 12 Z"
          fill="currentColor"
          stroke="none"
          opacity="0.55"
        />
      </g>
      {/* 中央ピボット */}
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RegenIcon() {
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
      <path d="M4 12 A8 8 0 0 1 20 8" />
      <path d="M16 8 H20 V4" />
      <path d="M20 12 A8 8 0 0 1 4 16" />
      <path d="M8 16 H4 V20" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-feature-teal)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M4 20 L8 19 L20 7 L17 4 L5 16 Z" />
      <path d="M14 7 L17 10" />
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
