import type { ScreenNode } from "../../types/screen";
import { pickLocalized, type Language } from "../../lib/i18n";

/**
 * v0.1.7 大刷新 v2:絵文字撤廃、カラー + タイポでデザインする機能カード(spec 準拠)。
 * Linear / Raycast / Arc 感:落ち着いた色面、ボーダーソフト、タイトル大、装飾控えめ。
 */
type FeatureCardGridProps = {
  nodes: ScreenNode[];
  language: Language;
  onCardClick: (id: number) => void;
};

/** カードカラー(枠線 + 主色 + 背景ソフト + バッジソフト + 装飾線色)*/
const PALETTE = [
  {
    title: "#0d9488",
    bgTop: "#e6fffb",
    bgBot: "#ffffff",
    badge: "#ccfbf1",
    badgeText: "#0d9488",
    deco: "#5eead4",
  },
  {
    title: "#b45309",
    bgTop: "#fff7ed",
    bgBot: "#ffffff",
    badge: "#fef3c7",
    badgeText: "#b45309",
    deco: "#fcd34d",
  },
  {
    title: "#6d28d9",
    bgTop: "#f5f3ff",
    bgBot: "#ffffff",
    badge: "#ede9fe",
    badgeText: "#6d28d9",
    deco: "#c4b5fd",
  },
  {
    title: "#1d4ed8",
    bgTop: "#eff6ff",
    bgBot: "#ffffff",
    badge: "#dbeafe",
    badgeText: "#1d4ed8",
    deco: "#93c5fd",
  },
];

function FeatureCardGrid({
  nodes,
  language,
  onCardClick,
}: FeatureCardGridProps) {
  // depth=0 を先頭、isEntryPoint をその先頭に。全要素を横スクロールで出す。
  const sortedNodes = [...nodes].sort((a, b) => {
    const da = a.depth ?? 0;
    const db = b.depth ?? 0;
    if (da !== db) return da - db;
    return (b.isEntryPoint ? 1 : 0) - (a.isEntryPoint ? 1 : 0);
  });

  if (sortedNodes.length === 0) return null;

  return (
    <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
      {sortedNodes.map((node, idx) => {
        const p = PALETTE[idx % PALETTE.length];
        const isMain = (node.depth ?? 0) === 0;
        // 動詞ベース(userIntent)を優先。spec:画面名ではなくユーザー行動。
        const titleText = node.userIntent
          ? pickLocalized(node.userIntent, language)
          : pickLocalized(node.label, language);
        const subtitleText = pickLocalized(node.detail.title, language);

        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onCardClick(node.id)}
            className="relative bg-paper rounded-[16px] border border-border-soft p-5 text-left hover:border-feature-teal/40 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] transition-all cursor-pointer flex flex-col gap-3 overflow-hidden min-h-[170px] flex-shrink-0 w-[260px] snap-start"
            style={{
              background: `linear-gradient(180deg, ${p.bgTop} 0%, ${p.bgBot} 60%)`,
            }}
          >
            {/* 装飾:右下に流れる波線(SVG)*/}
            <svg
              className="absolute right-0 bottom-0 w-32 h-20 pointer-events-none"
              viewBox="0 0 200 100"
              fill="none"
            >
              <path
                d="M0 70 Q 50 40, 100 65 T 200 50"
                stroke={p.deco}
                strokeOpacity="0.35"
                strokeWidth="1.5"
                fill="none"
              />
              <path
                d="M0 90 Q 60 65, 120 80 T 220 60"
                stroke={p.deco}
                strokeOpacity="0.2"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>

            {/* タイトル(大、色付き)*/}
            <div className="relative">
              <div
                className="text-2xl font-bold tracking-tight leading-tight"
                style={{ color: p.title }}
              >
                {titleText}
              </div>
              <div className="text-xs text-ink-soft mt-2 leading-relaxed line-clamp-2">
                {subtitleText}
              </div>
            </div>

            {/* バッジ(下端、控えめ)*/}
            <span
              className="relative inline-flex self-start text-[10px] font-semibold px-2 py-1 rounded-md mt-auto"
              style={{
                background: isMain ? p.badge : "#f1f5f9",
                color: isMain ? p.badgeText : "#64748b",
              }}
            >
              {isMain ? "主要機能" : "サポート機能"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default FeatureCardGrid;
