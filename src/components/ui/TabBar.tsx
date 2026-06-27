import type { StoredAnalysis } from "../../lib/storage";
import { t, type Language } from "../../lib/i18n";

/**
 * 複数の分析結果をタブで切替できるバー(v0.1.4 で導入、v0.1.5 で比較機能を撤去)。
 *
 * - 履歴 dropdown はアーカイブ、こちらは「いま開いてるワークスペース」
 * - アクティブタブだけマップが表示される
 * - × でタブ閉じる(履歴データ自体は残るので、いつでも履歴から再 open 可)
 *
 * v0.1.6: language を受けて aria-label を JA/EN 切替。
 */
type TabBarProps = {
  tabs: StoredAnalysis[]; // 表示順そのまま
  activeFolderPath: string | null;
  onSelectTab: (folderPath: string) => void;
  onCloseTab: (folderPath: string) => void;
  language: Language;
};

function shortFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 24 ? "…" + tail.slice(-23) : tail;
}

function TabBar({
  tabs,
  activeFolderPath,
  onSelectTab,
  onCloseTab,
  language,
}: TabBarProps) {
  const T = t(language);
  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 mb-3 overflow-x-auto pb-1"
      role="tablist"
      aria-label={T.tabBar.tabsAriaLabel}
    >
      {tabs.map((tab) => {
        const isActive = tab.folderPath === activeFolderPath;
        const short = shortFolder(tab.folderPath);
        return (
          <div
            key={tab.folderPath}
            role="tab"
            aria-selected={isActive}
            className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-[10px] text-xs cursor-pointer transition-all flex-shrink-0 border ${
              isActive
                ? "bg-paper border-feature-teal text-ink-strong shadow-sm font-semibold"
                : "bg-canvas border-border-soft text-ink-soft hover:bg-paper hover:text-ink"
            }`}
            onClick={() => onSelectTab(tab.folderPath)}
            title={tab.folderPath}
          >
            <FolderIcon
              className={
                isActive ? "text-feature-teal" : "text-ink-soft"
              }
            />
            <span className="font-mono whitespace-nowrap">{short}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.folderPath);
              }}
              className={`w-4 h-4 flex items-center justify-center rounded text-ink-soft hover:bg-impact-high/20 hover:text-impact-high transition-all text-[13px] leading-none flex-shrink-0 ${
                isActive
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-100"
              }`}
              aria-label={T.tabBar.closeAriaLabel(short)}
            >
              ×
            </button>
            {/* active タブの下端アクセント */}
            {isActive && (
              <div
                className="absolute -bottom-1 left-3 right-3 h-0.5 rounded-full bg-feature-teal"
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`w-3.5 h-3.5 flex-shrink-0 ${className ?? ""}`}
    >
      <path d="M3 7 H9 L11 5 H21 V19 H3 Z" />
    </svg>
  );
}

export default TabBar;
