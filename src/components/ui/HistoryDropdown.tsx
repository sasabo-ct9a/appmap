import { useEffect, useRef, useState } from "react";
import type { StoredAnalysis } from "../../lib/storage";

/**
 * 過去の分析結果を切り替える dropdown(機能拡張 A、Phase 3)。
 *
 * - ボタンクリックで開閉、外側クリックで閉じる
 * - 各エントリ:フォルダ末尾 2 階層 + 経過時間(相対表記)+ コスト + 削除 ×
 * - 現在表示中のものを Teal ドットで強調
 * - 履歴が空のときはボタン自体を disable
 */
type HistoryDropdownProps = {
  history: StoredAnalysis[];
  currentFolderPath: string | null;
  onSelect: (entry: StoredAnalysis) => void;
  onRemove: (folderPath: string) => void;
};

function shortFolder(path: string): string {
  // Windows: C:\Users\foo\projects\myapp → "projects\myapp"
  // Unix:    /home/foo/projects/myapp   → "projects/myapp"
  // 末尾 2 階層だけ残す。長過ぎる場合は ... で切る。
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 40 ? "…" + tail.slice(-39) : tail;
}

function relativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "たった今";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 時間前`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 日前`;
  // 1 週間以上前は yyyy/MM/dd
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function HistoryDropdown({
  history,
  currentFolderPath,
  onSelect,
  onRemove,
}: HistoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const disabled = history.length === 0;

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className={`rounded-[14px] px-4 py-2 text-sm transition-colors border ${
          disabled
            ? "border-charcoal text-soft-grid/50 cursor-not-allowed"
            : "border-soft-grid text-off-white hover:bg-charcoal cursor-pointer"
        }`}
        aria-label="分析履歴"
        aria-expanded={open}
      >
        履歴 ({history.length}) ▾
      </button>

      {open && history.length > 0 && (
        <div
          className="absolute top-full left-0 mt-1 w-[360px] bg-slate border border-charcoal rounded-[14px] shadow-md z-20"
          role="menu"
        >
          <ul className="max-h-80 overflow-y-auto py-1">
            {history.map((entry) => {
              const isCurrent = entry.folderPath === currentFolderPath;
              return (
                <li key={entry.folderPath} role="menuitem">
                  <div
                    className={`px-3 py-2 flex items-center gap-3 cursor-pointer transition-colors ${
                      isCurrent
                        ? "bg-charcoal/60"
                        : "hover:bg-charcoal/40"
                    }`}
                    onClick={() => {
                      onSelect(entry);
                      setOpen(false);
                    }}
                  >
                    {/* 現在表示中マーク */}
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        isCurrent ? "bg-electric-teal" : "bg-transparent"
                      }`}
                      aria-hidden="true"
                    />

                    <div className="min-w-0 flex-1">
                      <div
                        className="text-sm text-off-white truncate font-mono"
                        title={entry.folderPath}
                      >
                        {shortFolder(entry.folderPath)}
                      </div>
                      <div className="text-xs text-soft-grid mt-0.5">
                        {relativeTime(entry.analyzedAt)}
                        {entry.costUsd !== null && (
                          <> · ${entry.costUsd.toFixed(4)}</>
                        )}
                        {" · "}
                        {entry.screens.nodes.length} 画面
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(entry.folderPath);
                      }}
                      className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-[8px] text-soft-grid hover:bg-alert-red/20 hover:text-alert-red transition-colors text-base leading-none"
                      aria-label={`${shortFolder(entry.folderPath)} を履歴から削除`}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default HistoryDropdown;
