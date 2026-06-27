import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { t, pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7 リファイン:LIGHT モード Inspector パネル(360px、右側固定)。
 *
 * 改善点:
 *   - ヘッダー:カラーグラデーションのヒーロー帯 + タイトル + サブ(userIntent)
 *   - 絵文字アイコン廃止、左端の縦アクセントバーで色分け
 *   - subActions(マインドマップの葉と同じ)を「この画面でできること」として活用
 *   - 影響カラウト:changeHint.note を強調枠で
 *   - 「つながっている要素」:方向矢印 + 色ドット
 *   - データはチップ形式
 *   - フェイクの「プレビュー」ボタン撤廃
 */

type InspectorPanelProps = {
  node: ScreenNode | null;
  allNodes: ScreenNode[];
  allEdges: ScreenEdge[];
  onClose: () => void;
  noCodeMode: boolean;
  language: Language;
  /** つながっている要素クリックで別ノードに飛ぶ */
  onSelectNode?: (id: number) => void;
};

const FEATURE_PALETTE = [
  { fill: "#14B8A6", soft: "#CCFBF1", border: "#5EEAD4", text: "#0D9488" },
  { fill: "#F59E0B", soft: "#FEF3C7", border: "#FCD34D", text: "#B45309" },
  { fill: "#8B5CF6", soft: "#EDE9FE", border: "#C4B5FD", text: "#6D28D9" },
  { fill: "#3B82F6", soft: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8" },
  { fill: "#EC4899", soft: "#FCE7F3", border: "#F9A8D4", text: "#BE185D" },
  { fill: "#10B981", soft: "#D1FAE5", border: "#6EE7B7", text: "#047857" },
  { fill: "#06B6D4", soft: "#CFFAFE", border: "#67E8F9", text: "#0E7490" },
  { fill: "#F97316", soft: "#FFEDD5", border: "#FDBA74", text: "#C2410C" },
];
function paletteFor(id: number) {
  return FEATURE_PALETTE[(id - 1) % FEATURE_PALETTE.length];
}

type Direction = "out" | "in" | "both";
function classifyEdges(
  nodeId: number,
  edges: ScreenEdge[],
): Map<number, Direction> {
  const map = new Map<number, Direction>();
  for (const e of edges) {
    if (e.bidirectional) {
      if (e.from === nodeId) map.set(e.to, "both");
      else if (e.to === nodeId) map.set(e.from, "both");
      continue;
    }
    if (e.from === nodeId) {
      const cur = map.get(e.to);
      map.set(e.to, cur === "in" ? "both" : cur ?? "out");
    } else if (e.to === nodeId) {
      const cur = map.get(e.from);
      map.set(e.from, cur === "out" ? "both" : cur ?? "in");
    }
  }
  return map;
}

function InspectorPanel({
  node,
  allNodes,
  allEdges,
  onClose,
  noCodeMode,
  language,
  onSelectNode,
}: InspectorPanelProps) {
  const T = t(language);
  if (node === null) return null;

  const palette = paletteFor(node.id);
  const title = pickLocalized(node.detail.title, language);
  const userIntent = node.userIntent
    ? pickLocalized(node.userIntent, language)
    : "";
  const bodyText = pickLocalized(
    noCodeMode ? node.detail.bodyNoCode : node.detail.body,
    language,
  );
  const files = node.detail.files ?? [];
  const dataUsed = node.detail.dataUsed ?? [];
  const subActions = node.subActions ?? [];
  const changeHint = node.detail.changeHint;

  // 影響メタ
  const impactMeta = {
    easy: {
      label: language === "ja" ? "影響:低" : "Impact: low",
      shortLabel: language === "ja" ? "低" : "Low",
      color: "var(--color-impact-low)",
      pos: 18,
      desc:
        language === "ja"
          ? "ここを変えても、ほぼ単独で完結します。"
          : "Changes here stay mostly local.",
    },
    neutral: {
      label: language === "ja" ? "影響:中" : "Impact: medium",
      shortLabel: language === "ja" ? "中" : "Mid",
      color: "var(--color-impact-mid)",
      pos: 50,
      desc:
        language === "ja"
          ? "つながっている要素も合わせて確認しましょう。"
          : "Worth checking the connected pieces too.",
    },
    risky: {
      label: language === "ja" ? "影響:高" : "Impact: high",
      shortLabel: language === "ja" ? "高" : "High",
      color: "var(--color-impact-high)",
      pos: 84,
      desc:
        language === "ja"
          ? "他の要素まで波及する可能性があります。慎重に。"
          : "Changes may ripple to many pieces.",
    },
  } as const;
  const impact = changeHint
    ? impactMeta[changeHint.safety]
    : impactMeta.neutral;

  // つながっている要素
  const edgeMap = classifyEdges(node.id, allEdges);
  const relatedNodes = allNodes
    .filter((n) => edgeMap.has(n.id))
    .map((n) => ({ node: n, direction: edgeMap.get(n.id)! }));

  // この画面でできること:subActions 優先、無ければ body から bullet 抽出
  const bullets =
    subActions.length > 0
      ? subActions.map((s) => pickLocalized(s, language))
      : bodyText
          .split(/[。.\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 4)
          .slice(0, 3);

  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);

  return (
    <aside
      className="w-[360px] bg-paper border-l border-border-soft flex flex-col flex-shrink-0 relative"
      aria-label={T.inspector.panelAriaLabel}
    >
      {/* ───── ヒーローヘッダー ───── */}
      <header
        className="relative px-6 pt-6 pb-5 border-b border-border-soft"
        style={{
          background: `linear-gradient(180deg, ${palette.soft} 0%, var(--color-paper) 100%)`,
        }}
      >
        {/* 左端の色アクセントバー */}
        <div
          className="absolute left-0 top-6 bottom-6 w-1 rounded-r"
          style={{ background: palette.fill }}
          aria-hidden="true"
        />

        {/* 閉じる × */}
        <button
          type="button"
          onClick={onClose}
          aria-label={T.inspector.closeAriaLabel}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-md text-ink-soft hover:bg-paper/80 transition-colors cursor-pointer text-lg leading-none"
        >
          ×
        </button>

        {/* バッジ行 */}
        <div className="flex items-center gap-1.5 mb-2.5 pr-10 flex-wrap">
          {node.isEntryPoint && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: palette.fill, color: "#fff" }}
            >
              <span aria-hidden="true">▶</span>
              {tx("はじまりの画面", "Starting point")}
            </span>
          )}
          {changeHint && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-paper"
              style={{
                color: impact.color,
                boxShadow: `inset 0 0 0 1px ${palette.border}`,
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: impact.color }}
                aria-hidden="true"
              />
              {impact.label}
            </span>
          )}
        </div>

        {/* タイトル */}
        <h2 className="text-lg font-bold text-ink-strong leading-tight pr-6">
          {title}
        </h2>
        {/* userIntent サブ */}
        {userIntent && (
          <p
            className="text-sm font-semibold mt-1"
            style={{ color: palette.text }}
          >
            {userIntent}
          </p>
        )}
      </header>

      {/* ───── 本文 ───── */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* 概要本文 */}
        <p className="text-sm text-ink leading-relaxed">{bodyText}</p>

        {/* この画面でできること */}
        {bullets.length > 0 && (
          <Section title={tx("この画面でできること", "What you can do here")}>
            <ul className="flex flex-wrap gap-1.5">
              {bullets.map((b, i) => (
                <li
                  key={i}
                  className="text-xs font-medium px-2.5 py-1.5 rounded-full"
                  style={{
                    background: palette.soft,
                    color: palette.text,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  {b}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* つながっている要素 */}
        {relatedNodes.length > 0 && (
          <Section
            title={tx("つながっている要素", "Connected pieces")}
            count={relatedNodes.length}
          >
            <ul className="space-y-1.5">
              {relatedNodes.map(({ node: n, direction }) => {
                const rp = paletteFor(n.id);
                const label = pickLocalized(n.userIntent ?? n.label, language);
                const arrow =
                  direction === "out"
                    ? "→"
                    : direction === "in"
                    ? "←"
                    : "⇄";
                const clickable = !!onSelectNode;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={
                        clickable ? () => onSelectNode!(n.id) : undefined
                      }
                      disabled={!clickable}
                      className={`w-full text-left flex items-center gap-2.5 rounded-[10px] border border-border-soft px-3 py-2 transition-colors ${
                        clickable
                          ? "hover:bg-canvas cursor-pointer"
                          : "cursor-default"
                      }`}
                    >
                      <span
                        className="text-ink-soft font-mono text-sm w-4 text-center flex-shrink-0"
                        aria-hidden="true"
                      >
                        {arrow}
                      </span>
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: rp.fill }}
                        aria-hidden="true"
                      />
                      <span className="text-sm text-ink-strong truncate flex-1">
                        {label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {/* 変更の影響 */}
        {changeHint && (
          <Section
            title={tx("変更したらどうなる?", "What if you change this?")}
            rightLabel={impact.shortLabel}
            rightColor={impact.color}
          >
            <div
              className="rounded-[10px] p-3 mb-3 border"
              style={{
                background: palette.soft,
                borderColor: palette.border,
              }}
            >
              <div className="flex items-start gap-2">
                <span className="text-base mt-0.5" aria-hidden="true">
                  💡
                </span>
                <p className="text-xs text-ink leading-relaxed">
                  {pickLocalized(changeHint.note, language)}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-ink-soft mb-2 leading-relaxed">
              {impact.desc}
            </p>
            <div className="relative h-2 rounded-full bg-canvas border border-border-soft">
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, var(--color-impact-low) 0%, var(--color-impact-mid) 50%, var(--color-impact-high) 100%)",
                  opacity: 0.32,
                }}
              />
              <div
                className="absolute w-3.5 h-3.5 rounded-full top-1/2 -translate-y-1/2 -translate-x-1/2 border-2 border-paper shadow"
                style={{
                  left: `${impact.pos}%`,
                  background: impact.color,
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-ink-soft mt-1.5 px-0.5">
              <span>{tx("低", "Low")}</span>
              <span>{tx("中", "Mid")}</span>
              <span>{tx("高", "High")}</span>
            </div>
          </Section>
        )}

        {/* 使うデータ */}
        {dataUsed.length > 0 && (
          <Section title={tx("使うデータ", "Data used")}>
            <ul className="flex flex-wrap gap-1.5">
              {dataUsed.map((d, i) => {
                const text = pickLocalized(d, language);
                return (
                  <li
                    key={i}
                    className="inline-flex items-center gap-1.5 text-xs text-ink-strong px-2.5 py-1.5 rounded-full bg-canvas border border-border-soft"
                  >
                    <DataIcon color={palette.fill} />
                    {text}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {/* 関連ファイル(エンジニア向け、折り畳み)*/}
        {files.length > 0 && (
          <details className="group">
            <summary className="text-[11px] font-bold text-ink-soft uppercase tracking-wide cursor-pointer flex items-center gap-1.5 select-none hover:text-ink transition-colors">
              <ChevronRight className="group-open:rotate-90 transition-transform" />
              {tx("関連ファイル", "Related files")} ({files.length})
            </summary>
            <ul className="mt-2 space-y-1 pl-4">
              {files.map((f) => (
                <li
                  key={f}
                  className="text-[11px] text-ink-soft font-mono break-all leading-relaxed select-text"
                >
                  {f}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </aside>
  );
}

// ───── 内部サブコンポーネント ─────
function Section({
  title,
  count,
  rightLabel,
  rightColor,
  children,
}: {
  title: string;
  count?: number;
  rightLabel?: string;
  rightColor?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <h3 className="text-[11px] font-bold text-ink-strong uppercase tracking-wide">
          {title}
        </h3>
        {count !== undefined && (
          <span className="text-[10px] font-bold text-ink-soft bg-canvas rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
            {count}
          </span>
        )}
        {rightLabel && (
          <span
            className="ml-auto text-[11px] font-bold"
            style={{ color: rightColor ?? "var(--color-ink-soft)" }}
          >
            {rightLabel}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function DataIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      className="w-3.5 h-3.5 flex-shrink-0"
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6 V18 A8 3 0 0 0 20 18 V6" />
      <path d="M4 12 A8 3 0 0 0 20 12" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={`w-3 h-3 ${className ?? ""}`}
    >
      <path d="M9 6 L15 12 L9 18" />
    </svg>
  );
}

export default InspectorPanel;
