/**
 * v0.1.7 大刷新:上部 TopBar(高さ 72px、固定)。
 * pixel-perfect ターゲット画像の上端再現。
 *
 * 左:現在開いているプロジェクト名 + 副題
 * 中央〜右:かんたん/詳細 モード切替(セグメントピル形)
 * 右:エクスポート + アバター
 */
import { useEffect, useRef, useState } from "react";
import { t, type Language } from "../../lib/i18n";

type TopBarProps = {
  appName: string;
  appSubtitle: string;
  mode: "easy" | "detail";
  onModeChange: (next: "easy" | "detail") => void;
  onExport: () => void;
  /** v0.1.8:共有 HTML エクスポート(受け手が AppMap 不要で閲覧可能な単一 HTML)*/
  onExportShareHTML: () => void;
  /** v0.1.7 大刷新:Y アバター撤廃、Claude / ローカル LLM 切替に置き換え */
  engine: "claude" | "local";
  onEngineChange: (next: "claude" | "local") => void;
  language: Language;
};

function TopBar({
  appName,
  appSubtitle,
  mode,
  onModeChange,
  onExport,
  onExportShareHTML,
  engine,
  onEngineChange,
  language,
}: TopBarProps) {
  const T = t(language).topBar;
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (
        exportRef.current &&
        !exportRef.current.contains(e.target as Node)
      ) {
        setExportOpen(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [exportOpen]);
  return (
    <header className="h-[72px] bg-paper border-b border-border-soft px-8 flex items-center gap-6 flex-shrink-0">
      {/* プロジェクト名 + 副題 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-ink-strong">
          <span className="text-lg font-bold">{appName}</span>
        </div>
        <div className="text-xs text-ink-soft mt-0.5 truncate">
          {appSubtitle}
        </div>
      </div>

      {/* モード切替セグメントピル(かんたん / 詳細) */}
      <div className="flex items-center gap-2">
        <ModePill
          active={mode === "easy"}
          onClick={() => onModeChange("easy")}
          icon={<EmojiSmile />}
          accent="teal"
          title={T.easyTitle}
          subtitle={T.easySubtitle}
        />
        <ModePill
          active={mode === "detail"}
          onClick={() => onModeChange("detail")}
          icon={<CodeAngle />}
          accent="purple"
          title={T.detailTitle}
          subtitle={T.detailSubtitle}
        />
      </div>

      {/* エクスポート(ドロップダウン)*/}
      <div className="relative" ref={exportRef}>
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] border border-border-soft text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
        >
          <UploadIcon />
          {T.exportButton}
          <ChevronDownIcon />
        </button>
        {exportOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1.5 min-w-[240px] bg-paper border border-border-soft rounded-[12px] shadow-lg z-30 overflow-hidden"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setExportOpen(false);
                onExport();
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
            >
              <FileTextIcon />
              <span>{T.exportMenuSpecDoc}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setExportOpen(false);
                onExportShareHTML();
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-ink hover:bg-canvas transition-colors cursor-pointer border-t border-border-soft"
            >
              <ShareIcon />
              <span>{T.exportMenuShareHTML}</span>
            </button>
          </div>
        )}
      </div>

      {/* v0.1.7 大刷新:AI エンジン切替(Claude / ローカル LLM)*/}
      <button
        type="button"
        onClick={() => onEngineChange(engine === "claude" ? "local" : "claude")}
        aria-label={T.engineToggleAria}
        title={
          engine === "claude" ? T.engineTooltipClaude : T.engineTooltipLocal
        }
        className="flex items-center gap-2 px-3 py-2 rounded-[10px] border transition-colors cursor-pointer"
        style={{
          background:
            engine === "claude" ? "var(--color-feature-blue-soft)" : "var(--color-feature-teal-soft)",
          borderColor:
            engine === "claude" ? "var(--color-feature-blue)" : "var(--color-feature-teal)",
        }}
      >
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center relative"
          style={{
            background:
              engine === "claude" ? "var(--color-feature-blue)" : "var(--color-feature-teal)",
          }}
        >
          {engine === "claude" ? <CloudIcon /> : <ChipIcon />}
          {/* 稼働中ドット(右上、緑) */}
          <span
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border-2 border-white"
            aria-hidden="true"
          />
        </span>
        <span className="text-left leading-tight">
          <div
            className="text-xs font-semibold"
            style={{
              color:
                engine === "claude" ? "#1d4ed8" : "#0d9488",
            }}
          >
            {engine === "claude" ? T.engineLabelClaude : T.engineLabelLocal}
          </div>
          <div className="text-[10px] text-ink-soft">
            {engine === "claude" ? T.engineNoteClaude : T.engineNoteLocal}
          </div>
        </span>
      </button>
    </header>
  );
}

function CloudIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M7 16 H17 A4 4 0 0 0 17 8 A6 6 0 0 0 5 9 A3 3 0 0 0 7 16 Z" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M5 9 H3 M5 15 H3 M19 9 H21 M19 15 H21 M9 5 V3 M15 5 V3 M9 19 V21 M15 19 V21" />
    </svg>
  );
}

type ModePillProps = {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  accent: "teal" | "purple";
  title: string;
  subtitle: string;
};

function ModePill({
  active,
  onClick,
  icon,
  accent,
  title,
  subtitle,
}: ModePillProps) {
  const activeBg =
    accent === "teal" ? "bg-feature-teal-soft" : "bg-feature-purple-soft";
  const activeText =
    accent === "teal" ? "text-feature-teal" : "text-feature-purple";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 px-3 py-2 rounded-[10px] border transition-all cursor-pointer ${
        active
          ? `${activeBg} border-transparent`
          : "border-border-soft bg-paper hover:bg-canvas"
      }`}
    >
      <span className={`w-4 h-4 ${active ? activeText : "text-ink-soft"}`}>
        {icon}
      </span>
      <span className="text-left">
        <div
          className={`text-xs font-semibold ${
            active ? activeText : "text-ink"
          }`}
        >
          {title}
        </div>
        <div className="text-[10px] text-ink-soft leading-none mt-0.5">
          {subtitle}
        </div>
      </span>
    </button>
  );
}


function EmojiSmile() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="0.8" fill="currentColor" />
      <circle cx="15" cy="10" r="0.8" fill="currentColor" />
      <path d="M8 14 Q12 17 16 14" />
    </svg>
  );
}

function CodeAngle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 7 L3 12 L8 17" />
      <path d="M16 7 L21 12 L16 17" />
      <path d="M14 5 L10 19" />
    </svg>
  );
}

function ChevronDownIcon() {
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
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  );
}

function FileTextIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4 text-feature-teal"
    >
      <path d="M14 3 H6 A2 2 0 0 0 4 5 V19 A2 2 0 0 0 6 21 H18 A2 2 0 0 0 20 19 V9 Z" />
      <path d="M14 3 V9 H20" />
      <path d="M8 13 H16 M8 17 H13" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4 text-feature-purple"
    >
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="5" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 10.6 L15.4 6.4" />
      <path d="M8.6 13.4 L15.4 17.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-4 h-4"
    >
      <path d="M5 12 V19 H19 V12" />
      <path d="M12 4 V15" />
      <path d="M7 9 L12 4 L17 9" />
    </svg>
  );
}

export default TopBar;
