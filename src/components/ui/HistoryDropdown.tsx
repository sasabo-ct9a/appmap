import { useEffect, useRef, useState } from "react";
import type { StoredAnalysis } from "../../lib/storage";
import { t, type Language } from "../../lib/i18n";

/**
 * 過去の分析結果を切り替える dropdown(機能拡張 A、Phase 3)。
 *
 * - ボタンクリックで開閉、外側クリックで閉じる
 * - 各エントリ:フォルダ末尾 2 階層 + 経過時間(相対表記)+ コスト + 削除 ×
 * - 現在表示中のものを Teal ドットで強調
 * - 履歴が空のときはボタン自体を disable
 *
 * v0.1.6: language を受けて表示文言と相対時刻表記を JA / EN 切替。
 */
type HistoryDropdownProps = {
  history: StoredAnalysis[];
  currentFolderPath: string | null;
  onSelect: (entry: StoredAnalysis) => void;
  onRemove: (folderPath: string) => void;
  language: Language;
};

function shortFolder(path: string): string {
  // Windows: C:\Users\foo\projects\myapp → "projects\myapp"
  // Unix:    /home/foo/projects/myapp   → "projects/myapp"
  // 末尾 2 階層だけ残す。長過ぎる場合は ... で切る。
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 40 ? "…" + tail.slice(-39) : tail;
}

function relativeTime(timestamp: number, language: Language): string {
  const T = t(language);
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return T.history.justNow;
  if (diffSec < 3600) return T.history.minutesAgo(Math.floor(diffSec / 60));
  if (diffSec < 86400) return T.history.hoursAgo(Math.floor(diffSec / 3600));
  if (diffSec < 86400 * 7) return T.history.daysAgo(Math.floor(diffSec / 86400));
  // 1 週間以上前は yyyy/MM/dd(両言語で同じフォーマット)
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function HistoryDropdown({
  history,
  currentFolderPath,
  onSelect,
  onRemove,
  language,
}: HistoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const T = t(language);

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
            ? "border-border-soft text-ink-soft/50 cursor-not-allowed bg-paper"
            : "border-border-soft text-ink hover:bg-canvas cursor-pointer bg-paper"
        }`}
        aria-label={T.history.buttonAriaLabel}
        aria-expanded={open}
      >
        {T.history.button(history.length)}
      </button>

      {open && history.length > 0 && (
        <div
          className="absolute top-full left-0 mt-1 w-[360px] bg-paper border border-border-soft rounded-[14px] shadow-lg z-20"
          role="menu"
        >
          <ul className="max-h-80 overflow-y-auto py-1">
            {history.map((entry) => {
              const isCurrent = entry.folderPath === currentFolderPath;
              const short = shortFolder(entry.folderPath);
              return (
                <li key={entry.folderPath} role="menuitem">
                  <div
                    className={`px-3 py-2 flex items-center gap-3 cursor-pointer transition-colors ${
                      isCurrent
                        ? "bg-feature-teal-soft"
                        : "hover:bg-canvas"
                    }`}
                    onClick={() => {
                      onSelect(entry);
                      setOpen(false);
                    }}
                  >
                    {/* 現在表示中マーク */}
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        isCurrent ? "bg-feature-teal" : "bg-transparent"
                      }`}
                      aria-hidden="true"
                    />

                    <div className="min-w-0 flex-1">
                      <div
                        className="text-sm text-ink-strong truncate font-mono"
                        title={entry.folderPath}
                      >
                        {short}
                      </div>
                      <div className="text-xs text-ink-soft mt-0.5">
                        {relativeTime(entry.analyzedAt, language)}
                        {entry.costUsd !== null && (
                          <> · ${entry.costUsd.toFixed(4)}</>
                        )}
                        {" · "}
                        {T.history.screens(entry.screens.nodes.length)}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(entry.folderPath);
                      }}
                      className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-[8px] text-ink-soft hover:bg-impact-high/20 hover:text-impact-high transition-colors text-base leading-none"
                      aria-label={T.history.removeAriaLabel(short)}
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
