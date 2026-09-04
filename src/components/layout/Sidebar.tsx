import { useMemo, useState } from "react";
import LogoMark from "../ui/LogoMark";
import type { StoredAnalysis } from "../../lib/storage";
import { t, type Language } from "../../lib/i18n";

/**
 * v0.1.7 大刷新 v2:Deep navy サイドバー(spec 準拠)。
 * Linear / Raycast / Arc 系の落ち着いたエンタープライズ感を狙う。
 */
type NavKey =
  | "intro"
  | "impact"
  | "checklist"
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
  language: Language;
  /** v0.1.10:ガイド付きツアーを開始するコールバック */
  onStartTour?: () => void;
  /** 「クリエイトモード」= CreateMode を開くコールバック(旧ヒント位置に移設)。 */
  onOpenCreate?: () => void;
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
  language,
  onStartTour,
  onOpenCreate,
}: SidebarProps) {
  const T = t(language).sidebar;
  const navItems: NavItem[] = [
    {
      key: "intro",
      title: T.navHomeTitle,
      subtitle: T.navHomeSubtitle,
      icon: <HomeIcon />,
    },
    {
      key: "impact",
      title: T.navImpactTitle,
      subtitle: T.navImpactSubtitle,
      icon: <PulseIcon />,
    },
    {
      key: "checklist",
      title: T.navChecklistTitle,
      subtitle: T.navChecklistSubtitle,
      icon: <ShieldIcon />,
    },
  ];

  const projectItems: { key: NavKey; label: string }[] = [
    { key: "project-overview", label: T.projectOverview },
    { key: "project-data", label: T.projectData },
    { key: "project-settings", label: T.projectSettings },
  ];

  // v0.1.8:タブ検索(5 件以上ある時だけ入力欄を出す)
  const [tabQuery, setTabQuery] = useState<string>("");
  const filteredTabs = useMemo(() => {
    const q = tabQuery.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((t) => t.folderPath.toLowerCase().includes(q));
  }, [tabs, tabQuery]);

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
                  data-tour={`nav-${item.key}`}
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

          {/* プロジェクト情報セクション(常時展開、折り畳み撤去) */}
          <li className="pt-4">
            <div className="w-full flex items-center gap-2 px-3 py-2">
              <FolderIcon />
              <span
                className="text-sm font-semibold flex-1 text-left"
                style={{ color: "var(--color-nav-text)" }}
              >
                {T.sectionProjectInfo}
              </span>
            </div>
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
          </li>

          {/* 開いているプロジェクト(旧 TabBar をサイドバーに移管)*/}
          {tabs.length > 0 && (
            <li className="pt-5">
              <div
                className="px-3 pb-1.5 text-[10px] font-bold tracking-wider uppercase flex items-baseline justify-between"
                style={{ color: "var(--color-nav-text-soft)" }}
              >
                <span>{T.sectionOpenProjects}</span>
                {tabs.length > 5 && (
                  <span
                    className="text-[9px] font-normal normal-case tracking-normal"
                    style={{ color: "var(--color-nav-text-soft)" }}
                  >
                    {filteredTabs.length}/{tabs.length}
                  </span>
                )}
              </div>
              {/* v0.1.8:プロジェクトが 5 件を超えたら検索欄を出す */}
              {tabs.length > 5 && (
                <div className="px-3 pb-2">
                  <input
                    type="text"
                    value={tabQuery}
                    onChange={(e) => setTabQuery(e.target.value)}
                    placeholder={T.tabSearchPlaceholder}
                    aria-label={T.tabSearchPlaceholder}
                    className="w-full rounded-[6px] px-2 py-1 text-xs outline-none border transition-colors"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      borderColor: "rgba(255,255,255,0.08)",
                      color: "var(--color-nav-text-strong)",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor =
                        "var(--color-nav-accent)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor =
                        "rgba(255,255,255,0.08)";
                    }}
                  />
                </div>
              )}
              <ul className="space-y-0.5">
                {filteredTabs.length === 0 && (
                  <li
                    className="px-3 py-2 text-[11px] italic"
                    style={{ color: "var(--color-nav-text-soft)" }}
                  >
                    {T.tabSearchNoMatch}
                  </li>
                )}
                {filteredTabs.map((tab) => {
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
                          aria-label={T.closeTabAria(short)}
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

      {/* クリエイトモード:CreateMode を開く。旧「3 分で理解するコツ」ヒントの位置に移設。*/}
      {onOpenCreate && (
        <div className="mx-3 mb-2">
          <button
            type="button"
            onClick={onOpenCreate}
            className="w-full flex items-center justify-center gap-1.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold transition-opacity cursor-pointer"
            style={{ background: "var(--color-nav-accent)", color: "#fff" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "0.9";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="w-3.5 h-3.5"
              aria-hidden="true"
            >
              <path d="M12 5 V19 M5 12 H19" />
            </svg>
            クリエイトモード
          </button>
        </div>
      )}

      {/* v0.1.10:ガイド付きツアー起動ボタン */}
      {onStartTour && (
        <div className="mx-3 mb-3">
          <button
            type="button"
            onClick={onStartTour}
            className="w-full flex items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-[12px] font-medium transition-colors cursor-pointer"
            style={{
              background: "rgba(20,184,166,0.15)",
              color: "var(--color-nav-accent)",
              border: "1px solid rgba(20,184,166,0.3)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(20,184,166,0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(20,184,166,0.15)";
            }}
            title={T.tourButtonTitle}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-3.5 h-3.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9 A3 3 0 1 1 12 13 V14" />
              <circle cx="12" cy="17" r="0.5" fill="currentColor" />
            </svg>
            {T.tourButtonLabel}
          </button>
        </div>
      )}

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


function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12 H7 L10 5 L14 19 L17 12 H21" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 L20 6 V13 A9 9 0 0 1 12 21 A9 9 0 0 1 4 13 V6 Z" />
      <path d="M9 12 L11 14 L15 10" />
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

export default Sidebar;
export type { NavKey };
