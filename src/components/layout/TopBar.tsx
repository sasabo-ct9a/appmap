/**
 * v0.1.7 大刷新:上部 TopBar(高さ 72px、固定)。
 * pixel-perfect ターゲット画像の上端再現。
 *
 * 左:現在開いているプロジェクト名 + 副題
 * 中央〜右:かんたん/詳細 モード切替(セグメントピル形)
 * 右:エクスポート + アバター
 */
type TopBarProps = {
  appName: string;
  appSubtitle: string;
  mode: "easy" | "detail";
  onModeChange: (next: "easy" | "detail") => void;
  onExport: () => void;
  /** v0.1.7 大刷新:Y アバター撤廃、Claude / ローカル LLM 切替に置き換え */
  engine: "claude" | "local";
  onEngineChange: (next: "claude" | "local") => void;
};

function TopBar({
  appName,
  appSubtitle,
  mode,
  onModeChange,
  onExport,
  engine,
  onEngineChange,
}: TopBarProps) {
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
          title="かんたんモード"
          subtitle="ノーコード向け"
        />
        <ModePill
          active={mode === "detail"}
          onClick={() => onModeChange("detail")}
          icon={<CodeAngle />}
          accent="purple"
          title="詳細モード"
          subtitle="技術者向け"
        />
      </div>

      {/* エクスポート */}
      <button
        type="button"
        onClick={onExport}
        className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] border border-border-soft text-sm text-ink hover:bg-canvas transition-colors cursor-pointer"
      >
        <UploadIcon />
        エクスポート
      </button>

      {/* v0.1.7 大刷新:AI エンジン切替(Claude / ローカル LLM)*/}
      <button
        type="button"
        onClick={() => onEngineChange(engine === "claude" ? "local" : "claude")}
        aria-label="AI エンジン切替"
        title={
          engine === "claude"
            ? "Claude を使用中 — クリックでローカル LLM に切替"
            : "ローカル LLM を使用中 — クリックで Claude に切替"
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
            {engine === "claude" ? "Claude" : "ローカル LLM"}
          </div>
          <div className="text-[10px] text-ink-soft">
            {engine === "claude" ? "クラウド利用中" : "ローカル動作"}
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
