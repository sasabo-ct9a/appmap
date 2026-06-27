import { useState } from "react";
import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7「変更の影響を確認」ページ本体。
 *
 * データソース:
 *   - 各 ScreenNode.detail.changeHint(safety + note)
 *   - ScreenEdge(画面同士のつながり)
 *
 * 3 セクションを縦に積む:
 *   A. リスク別カード(easy / neutral / risky 3 列)
 *   B. 画面を選んで影響範囲(左:画面一覧、右:選択画面の繋がり)
 *   C. 全画面の変更影響テーブル(risky → easy 順)
 */
type ImpactViewProps = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  language: Language;
  /** Inspector を開くためのハンドラ(カードやテーブル行クリック)*/
  onSelectNode: (id: number) => void;
};

type Safety = "easy" | "neutral" | "risky" | "unknown";

type SafetyMeta = {
  label: { ja: string; en: string };
  desc: { ja: string; en: string };
  color: string;
  bg: string;
  border: string;
  emoji: string;
};

const SAFETY_META: Record<Safety, SafetyMeta> = {
  easy: {
    label: { ja: "安全に変えられる", en: "Safe to change" },
    desc: {
      ja: "文言や表示順だけなら、他の画面に影響しません。",
      en: "Wording or order changes don't ripple.",
    },
    color: "#0d9488",
    bg: "#CCFBF1",
    border: "#5EEAD4",
    emoji: "🟢",
  },
  neutral: {
    label: { ja: "少し注意", en: "A bit careful" },
    desc: {
      ja: "つながっている要素も合わせて確認しましょう。",
      en: "Check the connected pieces too.",
    },
    color: "#B45309",
    bg: "#FEF3C7",
    border: "#FCD34D",
    emoji: "🟡",
  },
  risky: {
    label: { ja: "慎重に", en: "Be careful" },
    desc: {
      ja: "他の画面まで壊れる可能性があります。",
      en: "May break other screens too.",
    },
    color: "#BE185D",
    bg: "#FCE7F3",
    border: "#F9A8D4",
    emoji: "🔴",
  },
  unknown: {
    label: { ja: "未判定", en: "Not assessed" },
    desc: { ja: "AI が判断しなかった画面", en: "AI didn't assess" },
    color: "#64748b",
    bg: "#f1f5f9",
    border: "#cbd5e1",
    emoji: "⚪",
  },
};

function getSafety(node: ScreenNode): Safety {
  return (node.detail.changeHint?.safety as Safety | undefined) ?? "unknown";
}

function getEdgeCount(nodeId: number, edges: ScreenEdge[]): number {
  return edges.filter((e) => e.from === nodeId || e.to === nodeId).length;
}

type Direction = "out" | "in" | "both";
function getConnectedNodes(
  node: ScreenNode,
  edges: ScreenEdge[],
  nodes: ScreenNode[],
): { node: ScreenNode; direction: Direction }[] {
  const map = new Map<number, Direction>();
  for (const e of edges) {
    if (e.bidirectional) {
      if (e.from === node.id) map.set(e.to, "both");
      else if (e.to === node.id) map.set(e.from, "both");
      continue;
    }
    if (e.from === node.id) {
      const cur = map.get(e.to);
      map.set(e.to, cur === "in" ? "both" : cur ?? "out");
    } else if (e.to === node.id) {
      const cur = map.get(e.from);
      map.set(e.from, cur === "out" ? "both" : cur ?? "in");
    }
  }
  return Array.from(map.entries())
    .map(([id, dir]) => {
      const n = nodes.find((nn) => nn.id === id);
      return n ? { node: n, direction: dir } : null;
    })
    .filter((x): x is { node: ScreenNode; direction: Direction } => x !== null);
}

function ImpactView({
  nodes,
  edges,
  language,
  onSelectNode,
}: ImpactViewProps) {
  const tx = (ja: string, en: string) => (language === "ja" ? ja : en);
  const [focusedId, setFocusedId] = useState<number | null>(nodes[0]?.id ?? null);
  // フィルタチップ:すべて | easy | neutral | risky
  const [filter, setFilter] = useState<Safety | "all">("all");

  // Section A: safety グルーピング
  const groups: Record<Safety, ScreenNode[]> = {
    easy: [],
    neutral: [],
    risky: [],
    unknown: [],
  };
  for (const n of nodes) groups[getSafety(n)].push(n);

  // Section B: 選択中画面のつながり
  const focusedNode =
    focusedId !== null ? nodes.find((n) => n.id === focusedId) ?? null : null;
  const connected = focusedNode
    ? getConnectedNodes(focusedNode, edges, nodes)
    : [];

  // Section C: テーブル用ソート(risky → easy → unknown)
  const SAFETY_ORDER: Record<Safety, number> = {
    risky: 0,
    neutral: 1,
    easy: 2,
    unknown: 3,
  };
  const sortedNodes = [...nodes].sort(
    (a, b) => SAFETY_ORDER[getSafety(a)] - SAFETY_ORDER[getSafety(b)],
  );

  // フィルタ適用後のリスト(Section B 用)
  const filteredNodes =
    filter === "all"
      ? nodes
      : nodes.filter((n) => getSafety(n) === filter);

  return (
    <div className="space-y-6">
      {/* ページタイトル */}
      <div>
        <h1 className="text-2xl font-bold text-ink-strong flex items-center gap-2">
          {tx("変更の影響を確認", "Check change impact")}
          <span className="text-feature-teal">✨</span>
        </h1>
        <p className="text-sm text-ink-soft mt-1">
          {tx(
            "どこを変えると他の要素に影響するか、一目で分かるようにまとめました。",
            "An at-a-glance summary of how changes ripple to other pieces.",
          )}
        </p>
      </div>

      {/* ────── ヒーロー統計バー ────── */}
      <div className="grid grid-cols-3 gap-3">
        {(["easy", "neutral", "risky"] as Safety[]).map((safety) => {
          const meta = SAFETY_META[safety];
          const items = groups[safety];
          return (
            <button
              key={safety}
              type="button"
              onClick={() =>
                setFilter((cur) => (cur === safety ? "all" : safety))
              }
              className={`bg-paper rounded-[14px] border-2 p-4 text-left cursor-pointer hover:shadow-sm transition-all ${
                filter === safety ? "ring-2 ring-offset-1" : ""
              }`}
              style={{
                borderColor: meta.border,
                ...(filter === safety
                  ? { boxShadow: `0 0 0 2px ${meta.color}` }
                  : {}),
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-2xl" aria-hidden="true">
                  {meta.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className="text-3xl font-extrabold tabular-nums leading-none"
                      style={{ color: meta.color }}
                    >
                      {items.length}
                    </span>
                    <span
                      className="text-[11px] font-bold"
                      style={{ color: meta.color }}
                    >
                      {tx("要素", "pieces")}
                    </span>
                  </div>
                  <div
                    className="text-xs font-semibold mt-1"
                    style={{ color: meta.color }}
                  >
                    {tx(meta.label.ja, meta.label.en)}
                  </div>
                  <div className="text-[10px] text-ink-soft mt-0.5 leading-snug">
                    {tx(meta.desc.ja, meta.desc.en)}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-ink-soft -mt-2">
        {tx(
          "👆 カードをクリックすると下のリストもそのレベルだけに絞り込めます。",
          "👆 Click a card to filter the list below by that level.",
        )}
        {groups.unknown.length > 0 &&
          tx(
            ` ⚪ 未判定 ${groups.unknown.length} 件は AI が判断しなかった要素です。`,
            ` ⚪ ${groups.unknown.length} not assessed by AI.`,
          )}
      </p>

      {/* ────── メイン:画面を選んで影響範囲を見る ────── */}
      <section>
        <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold text-ink-strong">
              {tx("どこに影響する?", "Where does it ripple?")}
            </h2>
            <p className="text-xs text-ink-soft mt-0.5">
              {tx(
                "要素を選ぶと、つながっている他の要素が右に並びます。",
                "Pick a piece to see what it connects to.",
              )}
            </p>
          </div>
          {/* フィルタチップ */}
          <div className="flex items-center bg-canvas rounded-[10px] p-1 border border-border-soft">
            {(
              [
                { key: "all" as const, label: tx("すべて", "All") },
                {
                  key: "easy" as const,
                  label: tx("🟢 安全", "🟢 Safe"),
                  color: SAFETY_META.easy.color,
                },
                {
                  key: "neutral" as const,
                  label: tx("🟡 注意", "🟡 Care"),
                  color: SAFETY_META.neutral.color,
                },
                {
                  key: "risky" as const,
                  label: tx("🔴 慎重", "🔴 Risky"),
                  color: SAFETY_META.risky.color,
                },
              ] as { key: Safety | "all"; label: string; color?: string }[]
            ).map((opt) => {
              const active = filter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setFilter(opt.key)}
                  className={`px-2.5 py-1 rounded-[8px] text-[11px] font-semibold transition-colors cursor-pointer ${
                    active
                      ? "bg-paper text-ink-strong shadow-sm"
                      : "text-ink-soft hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="bg-paper rounded-[14px] border border-border-soft overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-3">
            {/* 左:要素一覧(フィルタ済み)*/}
            <div className="border-r border-border-soft max-h-[460px] overflow-y-auto">
              <div className="px-3 py-2 text-[11px] font-bold text-ink-soft border-b border-border-soft sticky top-0 bg-paper z-10 flex items-center justify-between">
                <span>{tx("要素を選ぶ", "Pick a piece")}</span>
                <span className="text-ink-soft/70 font-medium">
                  {filteredNodes.length}
                </span>
              </div>
              <ul>
                {filteredNodes.length === 0 ? (
                  <li className="px-3 py-4 text-xs text-ink-soft italic text-center">
                    {tx(
                      "このリスクレベルの要素はありません。",
                      "No pieces at this risk level.",
                    )}
                  </li>
                ) : (
                  filteredNodes.map((n) => {
                    const safety = getSafety(n);
                    const meta = SAFETY_META[safety];
                    const label = pickLocalized(
                      n.userIntent ?? n.label,
                      language,
                    );
                    const isActive = focusedId === n.id;
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          onClick={() => setFocusedId(n.id)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
                            isActive
                              ? "bg-feature-teal-soft"
                              : "hover:bg-canvas"
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: meta.color }}
                            aria-hidden="true"
                          />
                          <span className="text-sm text-ink-strong truncate">
                            {label}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>

            {/* 右:選択画面の詳細 + つながり */}
            <div className="md:col-span-2 p-5">
              {focusedNode ? (
                <>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="text-lg" aria-hidden="true">
                      {SAFETY_META[getSafety(focusedNode)].emoji}
                    </span>
                    <h3 className="text-base font-bold text-ink-strong">
                      {pickLocalized(
                        focusedNode.userIntent ?? focusedNode.label,
                        language,
                      )}
                    </h3>
                    <span
                      className="ml-auto text-xs font-semibold rounded-full px-2.5 py-0.5"
                      style={{
                        background: SAFETY_META[getSafety(focusedNode)].bg,
                        color: SAFETY_META[getSafety(focusedNode)].color,
                      }}
                    >
                      {tx(
                        SAFETY_META[getSafety(focusedNode)].label.ja,
                        SAFETY_META[getSafety(focusedNode)].label.en,
                      )}
                    </span>
                  </div>
                  {focusedNode.detail.changeHint && (
                    <div className="text-sm text-ink mb-4 bg-canvas rounded-[10px] p-3 border border-border-soft">
                      💡{" "}
                      {pickLocalized(
                        focusedNode.detail.changeHint.note,
                        language,
                      )}
                    </div>
                  )}
                  <div className="text-xs font-bold text-ink-soft mb-2">
                    {tx(
                      `つながっている要素 (${connected.length})`,
                      `Connected pieces (${connected.length})`,
                    )}
                  </div>
                  {connected.length === 0 ? (
                    <div className="text-sm text-ink-soft py-2 italic">
                      {tx(
                        "他とのつながりはありません(変えても他に影響しない独立した要素)。",
                        "No connections. Changes here stay local.",
                      )}
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {connected.map(({ node: c, direction }) => {
                        const safety = getSafety(c);
                        const meta = SAFETY_META[safety];
                        const label = pickLocalized(
                          c.userIntent ?? c.label,
                          language,
                        );
                        const arrow =
                          direction === "out"
                            ? "→"
                            : direction === "in"
                            ? "←"
                            : "⇄";
                        return (
                          <li
                            key={c.id}
                            className="flex items-center gap-3 bg-canvas rounded-[10px] p-2.5 cursor-pointer hover:bg-paper transition-colors border border-transparent hover:border-border-soft"
                            onClick={() => onSelectNode(c.id)}
                          >
                            <span className="text-ink-soft font-mono text-base w-4 text-center flex-shrink-0">
                              {arrow}
                            </span>
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ background: meta.color }}
                              aria-hidden="true"
                            />
                            <span className="text-sm text-ink-strong truncate flex-1">
                              {label}
                            </span>
                            <span
                              className="text-[10px] font-semibold rounded-full px-2 py-0.5 flex-shrink-0"
                              style={{
                                background: meta.bg,
                                color: meta.color,
                              }}
                            >
                              {tx(meta.label.ja, meta.label.en)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              ) : (
                <div className="text-sm text-ink-soft py-8 text-center">
                  {tx(
                    "左の一覧から画面を選んでください。",
                    "Pick a screen from the list on the left.",
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ────── Section C: 全要素テーブル(折りたたみ)────── */}
      <details className="bg-paper rounded-[14px] border border-border-soft group">
        <summary className="px-5 py-3 cursor-pointer flex items-center gap-2 select-none hover:bg-canvas/40 rounded-[14px] transition-colors">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="w-3.5 h-3.5 text-ink-soft group-open:rotate-90 transition-transform"
          >
            <path d="M9 6 L15 12 L9 18" />
          </svg>
          <span className="text-sm font-bold text-ink-strong">
            {tx("全要素を表で見る", "Show full table")}
          </span>
          <span className="text-[11px] text-ink-soft ml-1">
            {tx(
              `(${nodes.length} 要素を慎重順に並べたサマリー)`,
              `(${nodes.length} pieces, sorted by risk)`,
            )}
          </span>
        </summary>
        <div className="border-t border-border-soft overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-canvas border-b border-border-soft">
              <tr>
                <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-soft uppercase tracking-wide">
                  {tx("画面", "Screen")}
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-soft uppercase tracking-wide">
                  {tx("変えやすさ", "Ease")}
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-soft uppercase tracking-wide">
                  {tx("つながり", "Links")}
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-soft uppercase tracking-wide">
                  {tx("メモ", "Note")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map((n) => {
                const safety = getSafety(n);
                const meta = SAFETY_META[safety];
                const label = pickLocalized(
                  n.userIntent ?? n.label,
                  language,
                );
                const sub = pickLocalized(n.detail.title, language);
                const note = n.detail.changeHint
                  ? pickLocalized(n.detail.changeHint.note, language)
                  : "—";
                const count = getEdgeCount(n.id, edges);
                return (
                  <tr
                    key={n.id}
                    className="border-b border-border-soft last:border-b-0 hover:bg-canvas cursor-pointer transition-colors"
                    onClick={() => onSelectNode(n.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-ink-strong">
                        {label}
                      </div>
                      <div className="text-[11px] text-ink-soft truncate max-w-[200px]">
                        {sub}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="text-xs font-semibold rounded-full px-2.5 py-0.5 inline-flex items-center gap-1 whitespace-nowrap"
                        style={{ background: meta.bg, color: meta.color }}
                      >
                        <span aria-hidden="true">{meta.emoji}</span>
                        {tx(meta.label.ja, meta.label.en)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-soft text-sm">{count}</td>
                    <td className="px-4 py-3 text-ink text-xs max-w-[420px]">
                      {note}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default ImpactView;
