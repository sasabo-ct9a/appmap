import type {
  ScreenNode,
  ScreenEdge,
  LocalizedText,
} from "../../types/screen";
import type { StoredAnalysis, Engine, DetailLevel } from "../../lib/storage";
import { pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7「プロジェクト情報」配下の 3 ビュー。
 *   - ProjectOverview:アプリ概要 + メタデータ
 *   - ProjectData:画面横断のデータ一覧(dataUsed 集約)
 *   - ProjectSettings:言語 / エンジン / モード / 履歴管理
 */

// ───────── 概要(Overview)─────────
type ProjectOverviewProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  appSummary?: LocalizedText;
  folderPath: string | null;
  engine: Engine;
  costUsd: number | null;
  analyzedAt: number | null;
  language: Language;
};

export function ProjectOverview({
  nodes,
  edges,
  appSummary,
  folderPath,
  engine,
  costUsd,
  analyzedAt,
  language,
}: ProjectOverviewProps) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);
  const summaryStr = appSummary ? pickLocalized(appSummary, language) : "";
  const shortFolder = folderPath
    ? folderPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
    : tx("未選択", "Not picked");
  const entryNode = nodes.find((n) => n.isEntryPoint);
  const analyzedDate = analyzedAt
    ? new Date(analyzedAt).toLocaleString(language === "ja" ? "ja-JP" : "en-US")
    : "—";
  const engineLabel =
    engine === "claude"
      ? tx("Claude(クラウド)", "Claude (cloud)")
      : tx("ローカル LLM(オフライン)", "Local LLM (offline)");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
          {tx("プロジェクト概要", "Project overview")}
          <span className="text-feature-teal">✨</span>
        </h1>
        <p className="text-sm text-ink-soft mt-1">
          {tx(
            "このプロジェクトの全体像と分析メタデータをまとめます。",
            "A summary of this project and its analysis metadata.",
          )}
        </p>
      </div>

      {/* アプリのサマリー */}
      {summaryStr && (
        <div className="bg-paper rounded-[14px] border border-feature-teal/30 p-5">
          <div className="text-[11px] font-bold text-feature-teal uppercase tracking-wide mb-2">
            {tx("このアプリは…", "This app is…")}
          </div>
          <p className="text-base text-ink-strong leading-relaxed">
            {summaryStr}
          </p>
        </div>
      )}

      {/* メタデータグリッド */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <MetaCard
          label={tx("フォルダ", "Folder")}
          value={shortFolder}
          full={folderPath ?? undefined}
        />
        <MetaCard
          label={tx("AI エンジン", "AI engine")}
          value={engineLabel}
        />
        <MetaCard
          label={tx("分析日時", "Analyzed at")}
          value={analyzedDate}
        />
        <MetaCard
          label={tx("コスト", "Cost")}
          value={
            costUsd !== null
              ? `$${costUsd.toFixed(4)}`
              : tx("(無料 / ローカル)", "(free / local)")
          }
        />
        <MetaCard
          label={tx("要素数", "Pieces")}
          value={String(nodes.length)}
        />
        <MetaCard
          label={tx("つながり", "Links")}
          value={String(edges.length)}
        />
        {entryNode && (
          <MetaCard
            label={tx("最初の要素", "Entry piece")}
            value={pickLocalized(
              entryNode.userIntent ?? entryNode.label,
              language,
            )}
          />
        )}
        <MetaCard
          label={tx("言語", "Language")}
          value={language === "ja" ? "日本語" : "English"}
        />
      </div>
    </div>
  );
}

function MetaCard({
  label,
  value,
  full,
}: {
  label: string;
  value: string;
  full?: string;
}) {
  return (
    <div className="bg-paper rounded-[12px] border border-border-soft p-3">
      <div className="text-[11px] font-bold text-ink-soft uppercase tracking-wide mb-1">
        {label}
      </div>
      <div
        className="text-sm text-ink-strong font-mono truncate"
        title={full ?? value}
      >
        {value}
      </div>
    </div>
  );
}

// ───────── データ(Data)─────────
type DataUsage = {
  key: string;
  name: LocalizedText;
  screens: ScreenNode[];
};

function aggregateData(
  nodes: ScreenNode[],
  language: Language,
): DataUsage[] {
  const map = new Map<string, DataUsage>();
  for (const n of nodes) {
    if (!n.detail.dataUsed) continue;
    for (const data of n.detail.dataUsed) {
      const key = pickLocalized(data, language).trim();
      if (!key) continue;
      const existing = map.get(key);
      if (existing) {
        existing.screens.push(n);
      } else {
        map.set(key, { key, name: data, screens: [n] });
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.screens.length - a.screens.length,
  );
}

type ProjectDataProps = {
  nodes: ScreenNode[];
  language: Language;
  onSelectNode: (id: number) => void;
};

export function ProjectData({
  nodes,
  language,
  onSelectNode,
}: ProjectDataProps) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);
  const dataList = aggregateData(nodes, language);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
          {tx("使われているデータ", "Data used")}
          <span className="text-feature-purple">✨</span>
        </h1>
        <p className="text-sm text-ink-soft mt-1">
          {tx(
            "このアプリで扱っているデータの一覧と、どの要素で使われているかをまとめました。",
            "All data types this app handles, and which screens use them.",
          )}
        </p>
      </div>

      {dataList.length === 0 ? (
        <div className="bg-paper rounded-[14px] border border-border-soft p-10 text-center">
          <div className="text-3xl mb-2" aria-hidden="true">
            📦
          </div>
          <h2 className="text-base font-bold text-ink-strong mb-1">
            {tx(
              "データの情報がまだありません",
              "No data information yet",
            )}
          </h2>
          <p className="text-sm text-ink-soft">
            {tx(
              "再分析するか、AI が dataUsed を判定するのを待ってください。",
              "Re-run analysis or wait for the AI to fill dataUsed.",
            )}
          </p>
        </div>
      ) : (
        <div className="bg-paper rounded-[14px] border border-border-soft overflow-hidden">
          {dataList.map((d, i) => (
            <div
              key={d.key}
              className={`p-4 ${
                i < dataList.length - 1 ? "border-b border-border-soft" : ""
              }`}
            >
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span
                  className="w-2 h-2 rounded-full bg-feature-purple flex-shrink-0"
                  aria-hidden="true"
                />
                <h3 className="text-base font-bold text-ink-strong">
                  {pickLocalized(d.name, language)}
                </h3>
                <span className="ml-auto text-xs font-semibold rounded-full px-2.5 py-0.5 bg-feature-purple-soft text-feature-purple">
                  {tx(
                    `${d.screens.length} 要素で使用`,
                    `Used in ${d.screens.length}`,
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {d.screens.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelectNode(s.id)}
                    className="text-xs bg-canvas hover:bg-paper rounded-full px-3 py-1 border border-border-soft text-ink-strong transition-colors cursor-pointer"
                  >
                    {pickLocalized(s.userIntent ?? s.label, language)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────── 設定(Settings)─────────
type ProjectSettingsProps = {
  language: Language;
  onLanguageChange: (next: Language) => void;
  engine: Engine;
  onEngineChange: (next: Engine) => void;
  detailLevel: DetailLevel;
  onDetailLevelChange: (next: DetailLevel) => void;
  noCodeMode: boolean;
  onNoCodeModeChange: (next: boolean) => void;
  history: StoredAnalysis[];
  onRemoveFromHistory: (folderPath: string) => void;
};

export function ProjectSettings({
  language,
  onLanguageChange,
  engine,
  onEngineChange,
  detailLevel,
  onDetailLevelChange,
  noCodeMode,
  onNoCodeModeChange,
  history,
  onRemoveFromHistory,
}: ProjectSettingsProps) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
          {tx("設定", "Settings")}
          <span className="text-feature-blue">✨</span>
        </h1>
        <p className="text-sm text-ink-soft mt-1">
          {tx(
            "AppMap の表示や AI エンジン、分析履歴を切り替えます。",
            "Adjust display, AI engine, and analysis history.",
          )}
        </p>
      </div>

      {/* 言語 */}
      <SettingRow
        title={tx("表示言語", "Display language")}
        desc={tx(
          "UI とマップの表示言語。1 度の分析で JA / EN 両方持つので、切替で再分析は不要。",
          "UI and map language. Each analysis stores both JA and EN.",
        )}
      >
        <SegmentedPill
          options={[
            { value: "ja", label: "日本語" },
            { value: "en", label: "English" },
          ]}
          value={language}
          onChange={(v) => onLanguageChange(v as Language)}
        />
      </SettingRow>

      {/* AI エンジン */}
      <SettingRow
        title={tx("AI エンジン", "AI engine")}
        desc={tx(
          "クラウド(Claude)は高精度。ローカル(Qwen 14B)はオフライン + 無料。",
          "Cloud (Claude) = high quality. Local (Qwen 14B) = offline + free.",
        )}
      >
        <SegmentedPill
          options={[
            { value: "claude", label: tx("Claude", "Claude") },
            {
              value: "local",
              label: tx("ローカル LLM", "Local LLM"),
            },
          ]}
          value={engine}
          onChange={(v) => onEngineChange(v as Engine)}
        />
      </SettingRow>

      {/* 詳細レベル */}
      <SettingRow
        title={tx("表示の詳しさ", "Detail level")}
        desc={tx(
          "かんたん = 主要な要素のみ。詳細 = サブ画面・エラー画面も含めて全部。",
          "Simple = main screens only. Detailed = sub-screens and edge cases too.",
        )}
      >
        <SegmentedPill
          options={[
            { value: "simple", label: tx("かんたん", "Simple") },
            { value: "detailed", label: tx("詳細", "Detailed") },
          ]}
          value={detailLevel}
          onChange={(v) => onDetailLevelChange(v as DetailLevel)}
        />
      </SettingRow>

      {/* ノーコード語切替 */}
      <SettingRow
        title={tx("ノーコード語モード", "Plain-words mode")}
        desc={tx(
          "ON にすると、技術用語を Bubble / Notion / Glide で使う言葉に翻訳して表示します。",
          "When on, technical terms are rewritten in Bubble/Notion/Glide vocabulary.",
        )}
      >
        <Toggle value={noCodeMode} onChange={onNoCodeModeChange} />
      </SettingRow>

      {/* 履歴 */}
      <div>
        <h2 className="text-lg font-bold text-ink-strong mb-2">
          {tx("分析履歴", "Analysis history")}
        </h2>
        <p className="text-sm text-ink-soft mb-3">
          {tx(
            "これまでに分析したプロジェクトの一覧。不要なものは × で削除できます。",
            "All previously analyzed projects. Remove with the × icon.",
          )}
        </p>
        {history.length === 0 ? (
          <div className="bg-paper rounded-[14px] border border-border-soft p-6 text-center text-sm text-ink-soft">
            {tx(
              "履歴はまだありません。",
              "No history yet.",
            )}
          </div>
        ) : (
          <div className="bg-paper rounded-[14px] border border-border-soft overflow-hidden">
            {history.map((entry, i) => {
              const short =
                entry.folderPath
                  .split(/[\\/]/)
                  .filter(Boolean)
                  .slice(-2)
                  .join("/") || entry.folderPath;
              const date = new Date(entry.analyzedAt).toLocaleString(
                language === "ja" ? "ja-JP" : "en-US",
              );
              return (
                <div
                  key={entry.folderPath}
                  className={`px-4 py-3 flex items-center gap-3 ${
                    i < history.length - 1
                      ? "border-b border-border-soft"
                      : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-sm text-ink-strong font-mono truncate"
                      title={entry.folderPath}
                    >
                      {short}
                    </div>
                    <div className="text-[11px] text-ink-soft mt-0.5">
                      {date}
                      {entry.costUsd !== null && (
                        <> · ${entry.costUsd.toFixed(4)}</>
                      )}
                      {" · "}
                      {tx(
                        `${entry.screens.nodes.length} 要素`,
                        `${entry.screens.nodes.length} pieces`,
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveFromHistory(entry.folderPath)}
                    className="w-7 h-7 flex items-center justify-center rounded-[8px] text-ink-soft hover:bg-impact-high/20 hover:text-impact-high transition-colors text-lg leading-none cursor-pointer"
                    aria-label={tx("履歴から削除", "Remove from history")}
                    title={tx("履歴から削除", "Remove from history")}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────── 共通サブコンポーネント ─────────
function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-paper rounded-[14px] border border-border-soft p-4 flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-ink-strong">{title}</div>
        <div className="text-[11px] text-ink-soft mt-0.5">{desc}</div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SegmentedPill<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (next: V) => void;
}) {
  return (
    <div className="flex items-center border border-border-soft rounded-[10px] overflow-hidden bg-paper">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              active
                ? "bg-feature-teal text-white"
                : "text-ink hover:bg-canvas"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="w-11 h-6 rounded-full relative transition-colors cursor-pointer"
      style={{ background: value ? "#14B8A6" : "#cbd5e1" }}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-paper transition-all shadow ${
          value ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
