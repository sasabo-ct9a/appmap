import { useState } from "react";
import LogoMark from "../ui/LogoMark";
import type { StoredAnalysis } from "../../lib/storage";

/**
 * v0.1.7 大刷新 v2:Deep navy サイドバー(spec 準拠)。
 * Linear / Raycast / Arc 系の落ち着いたエンタープライズ感を狙う。
 */
type NavKey =
  | "intro"
  | "structure"
  | "impact"
  | "project-overview"
  | "project-data"
  | "project-settings";

type SidebarProps = {
  activeNav: NavKey;
  onNavChange: (key: NavKey) => void;
  // 開いているプロジェクトタブ(v0.1.7:TabBar をサイドバーに移管)
  tabs: StoredAnalysis[];
  activeFolderPath: string | null;
  onSelectTab: (folderPath: string) => void;
  onCloseTab: (folderPath: string) => void;
};

function shortFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 22 ? "…" + tail.slice(-21) : tail;
}

type NavItem = {
  key: NavKey;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
};

function Sidebar({
  activeNav,
  onNavChange,
  tabs,
  activeFolderPath,
  onSelectTab,
  onCloseTab,
}: SidebarProps) {
  const [projectOpen, setProjectOpen] = useState(true);

  const navItems: NavItem[] = [
    {
      key: "intro",
      title: "はじめに",
      subtitle: "このアプリでできること",
      icon: <HomeIcon />,
    },
    {
      key: "structure",
      title: "構造を見る",
      subtitle: "画面のつながりを見る",
      icon: <NetworkIcon />,
    },
    {
      key: "impact",
      title: "変更の影響を確認",
      subtitle: "どこを変えると影響する?",
      icon: <PulseIcon />,
    },
  ];

  const projectItems: { key: NavKey; label: string }[] = [
    { key: "project-overview", label: "概要" },
    { key: "project-data", label: "データ" },
    { key: "project-settings", label: "設定" },
  ];

  return (
    <aside
      className="w-60 h-full flex flex-col flex-shrink-0"
      style={{ background: "var(--color-nav-bg)" }}
    >
      {/* ロゴ */}
      <div className="px-5 py-5 flex items-center gap-2.5">
        <LogoMark className="w-7 h-7" />
        <span
          className="text-base font-bold tracking-tight"
          style={{ color: "var(--color-nav-text-strong)" }}
        >
          AppMap
        </span>
      </div>

      {/* ナビ本体 */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const active = activeNav === item.key;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onNavChange(item.key)}
                  className="w-full text-left rounded-[10px] px-3 py-2.5 flex items-start gap-3 transition-all cursor-pointer"
                  style={
                    active
                      ? {
                          background: "var(--color-nav-bg-card)",
                          boxShadow:
                            "inset 2px 0 0 var(--color-nav-accent)",
                        }
                      : undefined
                  }
                  onMouseEnter={(e) => {
                    if (!active)
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "";
                  }}
                >
                  <span
                    className="w-4 h-4 mt-0.5 flex-shrink-0"
                    style={{
                      color: active
                        ? "var(--color-nav-accent)"
                        : "var(--color-nav-text-soft)",
                    }}
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0">
                    <div
                      className="text-sm font-semibold"
                      style={{
                        color: active
                          ? "var(--color-nav-text-strong)"
                          : "var(--color-nav-text)",
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      className="text-xs mt-0.5 leading-snug"
                      style={{ color: "var(--color-nav-text-soft)" }}
                    >
                      {item.subtitle}
                    </div>
                  </span>
                </button>
              </li>
            );
          })}

          {/* プロジェクト情報セクション(折り畳み) */}
          <li className="pt-4">
            <button
              type="button"
              onClick={() => setProjectOpen(!projectOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-[8px] hover:bg-white/5 transition-colors cursor-pointer"
            >
              <FolderIcon />
              <span
                className="text-sm font-semibold flex-1 text-left"
                style={{ color: "var(--color-nav-text)" }}
              >
                プロジェクト情報
              </span>
              <ChevronDown
                style={{
                  transform: projectOpen ? "rotate(0)" : "rotate(-90deg)",
                  transition: "transform 0.15s",
                }}
              />
            </button>
            {projectOpen && (
              <ul className="ml-9 mt-1 space-y-0.5">
                {projectItems.map((p) => {
                  const active = activeNav === p.key;
                  return (
                    <li key={p.key}>
                      <button
                        type="button"
                        onClick={() => onNavChange(p.key)}
                        className="w-full text-left rounded px-2 py-1.5 text-sm transition-colors cursor-pointer flex items-center gap-2"
                        style={{
                          color: active
                            ? "var(--color-nav-accent)"
                            : "var(--color-nav-text-soft)",
                          fontWeight: active ? 600 : 400,
                        }}
                        onMouseEnter={(e) => {
                          if (!active)
                            e.currentTarget.style.color =
                              "var(--color-nav-text)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active)
                            e.currentTarget.style.color =
                              "var(--color-nav-text-soft)";
                        }}
                      >
                        <span
                          className="w-1 h-1 rounded-full"
                          style={{
                            background: active
                              ? "var(--color-nav-accent)"
                              : "var(--color-nav-text-soft)",
                          }}
                        />
                        {p.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>

          {/* 開いているプロジェクト(旧 TabBar をサイドバーに移管)*/}
          {tabs.length > 0 && (
            <li className="pt-5">
              <div
                className="px-3 pb-1.5 text-[10px] font-bold tracking-wider uppercase"
                style={{ color: "var(--color-nav-text-soft)" }}
              >
                開いているプロジェクト
              </div>
              <ul className="space-y-0.5">
                {tabs.map((tab) => {
                  const active = tab.folderPath === activeFolderPath;
                  const short = shortFolder(tab.folderPath);
                  return (
                    <li key={tab.folderPath}>
                      <div
                        role="tab"
                        aria-selected={active}
                        onClick={() => onSelectTab(tab.folderPath)}
                        className="group w-full rounded-[8px] px-2.5 py-1.5 flex items-center gap-2 cursor-pointer transition-colors"
                        style={
                          active
                            ? {
                                background: "var(--color-nav-bg-card)",
                                boxShadow:
                                  "inset 2px 0 0 var(--color-nav-accent)",
                              }
                            : undefined
                        }
                        onMouseEnter={(e) => {
                          if (!active)
                            e.currentTarget.style.background =
                              "rgba(255,255,255,0.04)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active)
                            e.currentTarget.style.background = "";
                        }}
                        title={tab.folderPath}
                      >
                        <FolderIconSmall
                          color={
                            active
                              ? "var(--color-nav-accent)"
                              : "var(--color-nav-text-soft)"
                          }
                        />
                        <span
                          className="font-mono text-xs truncate flex-1"
                          style={{
                            color: active
                              ? "var(--color-nav-text-strong)"
                              : "var(--color-nav-text)",
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {short}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseTab(tab.folderPath);
                          }}
                          aria-label={`${short} を閉じる`}
                          className={`w-4 h-4 flex items-center justify-center rounded text-[13px] leading-none transition-all flex-shrink-0 ${
                            active
                              ? "opacity-70"
                              : "opacity-0 group-hover:opacity-100"
                          }`}
                          style={{ color: "var(--color-nav-text-soft)" }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color =
                              "var(--color-impact-high)";
                            e.currentTarget.style.background =
                              "rgba(239,68,68,0.15)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color =
                              "var(--color-nav-text-soft)";
                            e.currentTarget.style.background = "";
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          )}
        </ul>
      </nav>

      {/* tips カード(deep navy 上で teal アクセント)*/}
      <div
        className="mx-3 mb-3 rounded-[12px] p-3"
        style={{ background: "var(--color-nav-bg-card)" }}
      >
        <div className="flex items-start gap-2">
          <span
            className="text-base flex-shrink-0"
            style={{ color: "var(--color-nav-accent)" }}
          >
            💡
          </span>
          <div className="min-w-0">
            <div
              className="text-xs font-semibold"
              style={{ color: "var(--color-nav-text-strong)" }}
            >
              3 分で理解するコツ
            </div>
            <div
              className="text-[11px] mt-1 leading-relaxed"
              style={{ color: "var(--color-nav-text)" }}
            >
              まずは「できること」から
              <br />
              全体像をつかみましょう
            </div>
          </div>
        </div>
      </div>

    </aside>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12 L12 4 L21 12" />
      <path d="M5 10 V20 H19 V10" />
    </svg>
  );
}

function NetworkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M12 7.5 L7 15.5 M12 7.5 L17 15.5" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12 H7 L10 5 L14 19 L17 12 H21" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-4 h-4"
      style={{ color: "var(--color-nav-text-soft)" }}
    >
      <path d="M3 7 H9 L11 5 H21 V19 H3 Z" />
    </svg>
  );
}

function FolderIconSmall({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-3.5 h-3.5 flex-shrink-0"
      style={{ color }}
    >
      <path d="M3 7 H9 L11 5 H21 V19 H3 Z" />
    </svg>
  );
}

function ChevronDown({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-3.5 h-3.5"
      style={{ color: "var(--color-nav-text-soft)", ...style }}
    >
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  );
}

export default Sidebar;
export type { NavKey };
