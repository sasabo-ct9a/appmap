import type { StoredAnalysis } from "../../lib/storage";

/**
 * 複数の分析結果をタブで切替できるバー(v0.1.4 で導入、v0.1.5 で比較機能を撤去)。
 *
 * - 履歴 dropdown はアーカイブ、こちらは「いま開いてるワークスペース」
 * - アクティブタブだけマップが表示される
 * - × でタブ閉じる(履歴データ自体は残るので、いつでも履歴から再 open 可)
 */
type TabBarProps = {
  tabs: StoredAnalysis[]; // 表示順そのまま
  activeFolderPath: string | null;
  onSelectTab: (folderPath: string) => void;
  onCloseTab: (folderPath: string) => void;
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
}: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1 mb-3 overflow-x-auto"
      role="tablist"
      aria-label="開いている分析タブ"
    >
      {tabs.map((tab) => {
        const isActive = tab.folderPath === activeFolderPath;
        return (
          <div
            key={tab.folderPath}
            role="tab"
            aria-selected={isActive}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-t-[8px] text-sm cursor-pointer transition-colors flex-shrink-0 border-b-2 ${
              isActive
                ? "bg-slate border-electric-teal text-off-white"
                : "bg-charcoal/40 border-transparent text-soft-grid hover:bg-charcoal/70 hover:text-off-white"
            }`}
            onClick={() => onSelectTab(tab.folderPath)}
            title={tab.folderPath}
          >
            <span className="font-mono whitespace-nowrap">
              {shortFolder(tab.folderPath)}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.folderPath);
              }}
              className="w-4 h-4 flex items-center justify-center rounded-full text-soft-grid hover:bg-alert-red/30 hover:text-alert-red transition-colors text-xs leading-none opacity-0 group-hover:opacity-100"
              aria-label={`${shortFolder(tab.folderPath)} のタブを閉じる`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default TabBar;
