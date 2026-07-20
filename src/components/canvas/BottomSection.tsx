import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";
import { computeStableColorIndex, paletteAt } from "../../lib/nodeColors";

/**
 * v0.1.7 大刷新:マップ下のサマリー帯。
 * pixel-perfect ターゲット画像の下端再現:
 *   - 左:このアプリのポイント(1-2 文の意味要約)
 *   - 右:主なユーザーフロー(入口から終点までの pill チェーン)
 */
type BottomSectionProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  appSummary: ScreenNode["label"] | undefined;
  language: Language;
  /** 詳細モード:フローチップの表記を label(短い画面名)に切替 */
  showDataDetails?: boolean;
};

// v0.1.7 色統一:nodeColors の stable index + paletteAt を使用

/**
 * 入口から始まり、edges を辿って 4-5 個のチップを抽出する単純な主要フロー抽出。
 * AI が将来「mainFlow: [id, id, …]」を返してくれれば置換。
 */
function deriveMainFlow(
  nodes: ScreenNode[],
  edges: ScreenEdge[],
): ScreenNode[] {
  const entry = nodes.find((n) => n.isEntryPoint) ?? nodes[0];
  if (!entry) return [];
  const seen = new Set<number>([entry.id]);
  const flow: ScreenNode[] = [entry];
  let current = entry;
  for (let i = 0; i < 6; i++) {
    const next = edges
      .filter((e) => e.from === current.id && !seen.has(e.to))
      .map((e) => nodes.find((n) => n.id === e.to))
      .filter((n): n is ScreenNode => !!n)
      .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))[0];
    if (!next) break;
    flow.push(next);
    seen.add(next.id);
    current = next;
  }
  return flow;
}

function BottomSection({
  nodes,
  edges,
  appSummary,
  language,
  showDataDetails = false,
}: BottomSectionProps) {
  const flow = deriveMainFlow(nodes, edges);
  const stableColorIndex = computeStableColorIndex(nodes, edges, language);
  const paletteFor = (id: number) =>
    paletteAt(stableColorIndex.get(id) ?? 0);
  const summaryText = appSummary
    ? typeof appSummary === "string"
      ? appSummary
      : pickLocalized(appSummary, language)
    : "AI で作ったアプリの全体像です。";

  return (
    <div className="bg-paper rounded-[16px] border border-border-soft p-5 grid grid-cols-[1fr_2fr] gap-6">
      {/* 左:このアプリのポイント */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <span className="w-7 h-7 rounded-md bg-feature-teal-soft flex items-center justify-center">
            <LightBulb />
          </span>
          <h3 className="text-sm font-bold text-ink-strong">
            このアプリのポイント
          </h3>
        </div>
        <p className="text-xs text-ink leading-relaxed">{summaryText}</p>
      </section>

      {/* 右:主なユーザーフロー */}
      <section>
        <div className="flex items-baseline gap-2 mb-2">
          <h3 className="text-sm font-bold text-ink-strong">
            主なユーザーフロー
          </h3>
          <span className="text-xs text-ink-soft">(入口からの流れ)</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {flow.map((n, i) => {
            const p = paletteFor(n.id);
            // かんたん=userIntent、詳細=label(短い画面名)
            const labelSource = showDataDetails
              ? n.label
              : n.userIntent ?? n.label;
            const label = pickLocalized(labelSource, language);
            return (
              <span key={n.id} className="flex items-center gap-1.5">
                <span
                  className="text-xs font-semibold px-2.5 py-1.5 rounded-[8px]"
                  style={{
                    background: p.soft,
                    color: p.fill,
                    ...(showDataDetails
                      ? {
                          fontFamily:
                            "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
                        }
                      : {}),
                  }}
                >
                  {label.length > 10 ? label.slice(0, 9) + "…" : label}
                </span>
                {i < flow.length - 1 && (
                  <span className="text-ink-soft">→</span>
                )}
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function LightBulb() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#14B8A6"
      strokeWidth="2"
      className="w-4 h-4"
    >
      <path d="M9 18 H15 M10 21 H14 M12 3 A6 6 0 0 1 18 9 C18 11 17 13 15 14 V17 H9 V14 C7 13 6 11 6 9 A6 6 0 0 1 12 3 Z" />
    </svg>
  );
}

export default BottomSection;
