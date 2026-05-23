import type { StoredAnalysis } from "../../lib/storage";

/**
 * 複数の分析結果をタブで切替できるバー(v0.1.4)。
 *
 * - 履歴 dropdown はアーカイブ、こちらは「いま開いてるワークスペース」
 * - アクティブタブだけマップが表示される(並列表示はしない、A 案)
 * - 比較モード中はアクティブと比較対象が両方ハイライト
 *
 * UX:
 *   [ アクティブタブ ✓ ] [ 別タブ × ] [ 別タブ × ] [比較 ▼]
 *
 * タブが 1 個しかない / 0 個のときはコンパクト or 非表示(親側で制御)。
 */
type TabBarProps = {
  tabs: StoredAnalysis[]; // 表示順そのまま
  activeFolderPath: string | null;
  /** 比較モードのとき、比較対象になっているタブの folderPath(枠線で強調) */
  comparedFolderPath: string | null;
  /** 比較モードが有効か(true なら比較ボタンがアクティブ表示、タブ click で比較対象切替) */
  compareMode: boolean;
  onSelectTab: (folderPath: string) => void;
  onCloseTab: (folderPath: string) => void;
  onToggleCompareMode: () => void;
  /** 比較モード中のみ:タブクリックで「比較対象」をセットする */
  onSetCompareTarget: (folderPath: string) => void;
};

function shortFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 24 ? "…" + tail.slice(-23) : tail;
}

function TabBar({
  tabs,
  activeFolderPath,
  comparedFolderPath,
  compareMode,
  onSelectTab,
  onCloseTab,
  onToggleCompareMode,
  onSetCompareTarget,
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
        const isCompared = tab.folderPath === comparedFolderPath;
        return (
          <div
            key={tab.folderPath}
            role="tab"
            aria-selected={isActive}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-t-[8px] text-sm cursor-pointer transition-colors flex-shrink-0 border-b-2 ${
              isActive
                ? "bg-slate border-electric-teal text-off-white"
                : isCompared
                  ? "bg-charcoal/60 border-muted-amber text-off-white"
                  : "bg-charcoal/40 border-transparent text-soft-grid hover:bg-charcoal/70 hover:text-off-white"
            }`}
            onClick={() => {
              if (compareMode && !isActive) {
                onSetCompareTarget(tab.folderPath);
              } else {
                onSelectTab(tab.folderPath);
              }
            }}
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

      {/* 比較モードトグル(タブが 2 枚以上で出現) */}
      {tabs.length >= 2 && (
        <button
          type="button"
          onClick={onToggleCompareMode}
          className={`ml-1 px-3 py-1.5 rounded-[8px] text-xs font-semibold transition-colors flex-shrink-0 ${
            compareMode
              ? "bg-muted-amber/30 text-muted-amber border border-muted-amber/50"
              : "bg-charcoal/40 text-soft-grid hover:bg-charcoal/70 hover:text-off-white"
          }`}
          aria-pressed={compareMode}
          aria-label="比較モードを切替"
          title={
            compareMode
              ? "比較モード ON(他のタブをクリックで比較対象に)"
              : "比較モードを ON にする"
          }
        >
          {compareMode ? "✕ 比較を終了" : "🔀 比較"}
        </button>
      )}
    </div>
  );
}

export default TabBar;
