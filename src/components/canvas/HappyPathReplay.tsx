import { pickLocalized, type Language } from "../../lib/i18n";
import type { ScreenNode } from "../../types/screen";

type Props = {
  /** computeReplaySteps の stages(1 ステージ = 入口から同じ距離の要素 id 集合)*/
  stages: number[][];
  /** 入口からたどり着けない要素 id(本流の外)。あれば最後に補足ステップとして出す。 */
  detached: number[];
  /** いま何ステップ目か(0-based)。stages.length の位置が detached 補足ステップ。 */
  index: number;
  nodes: ScreenNode[];
  language: Language;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
};

/**
 * 流れの再生バー。マップ下部に出て、入口からの流れを 1 ステージずつ送る。
 * 現在ステージの要素は MapCanvas 側で強調される(App から集合を渡して連動)。
 *
 * ステージ = 入口から同じ距離の要素の集合。枝分かれ(データ取得 → 動画取得 A / B)は
 * 1 ステージに複数要素が入るので、ここで「N つに分かれる」と明示し、マップでも同時に光る。
 * 片方の枝を黙って捨てないことで、構造を正直に見せる(CLAUDE.md §3.2 + as-built の正直さ)。
 *
 * 最後に detached(入口からたどり着けない要素)があれば「流れに入らない要素」ステップとして
 * 補足する。捨てて薄いまま放置せず「なぜ流れに入らないか」を言うのが正直(準備系・独立フロー等)。
 *
 * 送りは手動(戻る / 次へ):自動再生より、ユーザーが自分のペースで 1 コマずつ
 * 「これが分かった」を積める方が段階的開示に合う。
 *
 * 文言はこのバー限定なので i18n の大きな型を触らず、言語分岐をここに閉じ込める。
 */
function HappyPathReplay({
  stages,
  detached,
  index,
  nodes,
  language,
  onPrev,
  onNext,
  onClose,
}: Props) {
  const isJa = language === "ja";
  const L = isJa
    ? {
        title: "流れの再生",
        prev: "戻る",
        next: "次へ",
        close: "終了",
        step: (n: number, t: number) => `ステップ ${n} / ${t}`,
        split: (n: number) => `ここで ${n} つに分かれます`,
        detached: (n: number) => `入口からたどり着けない要素(${n} 件)`,
        join: " ・ ",
      }
    : {
        title: "Flow replay",
        prev: "Back",
        next: "Next",
        close: "Close",
        step: (n: number, t: number) => `Step ${n} / ${t}`,
        split: (n: number) => `Splits into ${n} here`,
        detached: (n: number) => `Not reachable from the start (${n})`,
        join: " / ",
      };

  const hasDetached = detached.length > 0;
  const total = stages.length + (hasDetached ? 1 : 0);
  const isDetachedStep = hasDetached && index === stages.length;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const titleOf = (n: ScreenNode) =>
    pickLocalized(n.userIntent ?? n.label, language);
  const nodesOf = (ids: number[]) =>
    ids.map((id) => nodeById.get(id)).filter(Boolean) as ScreenNode[];

  const current = isDetachedStep ? detached : stages[index] ?? [];
  const curNodes = nodesOf(current);
  if (curNodes.length === 0) return null;

  const isFork = !isDetachedStep && curNodes.length > 1;
  // 補足ステップ:流れ外。分岐:「N つに分かれる」+ 要素名。単一:そのタイトル + 詳細。
  const headline = isDetachedStep
    ? L.detached(curNodes.length)
    : isFork
      ? L.split(curNodes.length)
      : titleOf(curNodes[0]);
  const sub =
    isDetachedStep || isFork
      ? curNodes.map(titleOf).join(L.join)
      : pickLocalized(curNodes[0].detail.title, language);

  // 補足ステップは灰トーンで「本流の外」を示す。本流は teal。
  const accent = isDetachedStep ? "#94a3b8" : "#14b8a6";

  const isFirst = index <= 0;
  const isLast = index >= total - 1;

  return (
    <div className="flex items-center gap-3 bg-paper border border-border-soft rounded-[12px] px-4 py-2.5 shadow-sm">
      <span
        className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full"
        style={{
          background: isDetachedStep
            ? "rgba(148,163,184,0.16)"
            : "var(--color-feature-teal-soft)",
        }}
        aria-hidden="true"
      >
        {isDetachedStep ? (
          // 流れ外アイコン:つながっていない点(破線の円)
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#64748b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="3 3"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : isFork ? (
          // 分岐アイコン:1 本が 2 本に分かれる
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#0f766e"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3v6" />
            <path d="M6 9c0 4 4 4 6 6" />
            <path d="M6 9c0 4-4 4-6 6" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#0f766e">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </span>
      <div className="flex-shrink-0 leading-tight">
        <div className="text-[11px] text-ink-soft">{L.title}</div>
        <div className="text-xs font-semibold text-ink">
          {L.step(index + 1, total)}
        </div>
      </div>

      <div className="flex-1 min-w-0 border-l border-border-soft pl-3">
        <div className="text-sm font-semibold text-ink-strong truncate">
          {headline}
        </div>
        {sub && <div className="text-xs text-ink-soft truncate">{sub}</div>}
      </div>

      <div className="hidden md:flex items-center gap-1.5 flex-shrink-0">
        {Array.from({ length: total }).map((_, i) => {
          const detachedDot = hasDetached && i === stages.length;
          return (
            <span
              key={i}
              className="rounded-full"
              style={{
                width: 7,
                height: 7,
                background:
                  i <= index
                    ? detachedDot
                      ? "#94a3b8"
                      : "#14b8a6"
                    : "var(--color-border)",
              }}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onPrev}
          disabled={isFirst}
          className="rounded-[10px] px-3 py-1.5 text-xs border border-border-soft text-ink bg-paper hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {L.prev}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={isLast}
          className="rounded-[10px] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          style={{ background: accent }}
        >
          {L.next}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={L.close}
          title={L.close}
          className="flex items-center justify-center w-8 h-8 rounded-md text-ink-soft hover:bg-canvas transition-colors"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default HappyPathReplay;
