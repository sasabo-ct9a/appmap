import { type ReactNode } from "react";
import {
  GLOSSARY_KEYS_SORTED,
  TECH_TERM_GLOSSARY,
  type GlossaryEntry,
} from "../../lib/glossary";

/**
 * 専門用語の hover ツールチップ(機能拡張 G、CLAUDE.md §10.5.7)。
 *
 * 用語に点線下線 + cursor-help、ホバーで吹き出しを表示し、Bubble/Notion での
 * 対応概念を併記する(§3.3「ノーコード経験者の言葉で話す」)。
 *
 * CSS は Tailwind の group / group-hover で開閉。JS state を持たないので軽い。
 * 吹き出しは pointer-events-none で重ね、用語のクリック・選択を邪魔しない。
 *
 * 表示位置:
 *   - 用語の **下**(`top-full mt-1`)、**右揃え**(`right-0`)— Inspector パネルが
 *     画面右側にあるため、用語の右端を起点に左へ展開する方が画面外にはみ出しにくい。
 *   - 幅は w-max(中身に合わせる)、max-w-[240px] で頭打ち。
 *   - `hidden`/`group-hover:block` で完全に display を切り替え、非表示時に
 *     レイアウトを占有しないようにする(visibility:hidden だと overflow-x スクロール
 *     が発生する Codex review 2026-05-11 round 3 報告問題)。
 */
type TooltipProps = {
  term: string;
  definition: GlossaryEntry;
};

function Tooltip({ term, definition }: TooltipProps) {
  return (
    <span className="relative inline-block group align-baseline">
      <span className="border-b border-dotted border-electric-teal/70 cursor-help">
        {term}
      </span>
      <span
        className="absolute top-full right-0 mt-1 w-max max-w-[240px] hidden group-hover:block z-50 bg-charcoal border border-soft-grid/30 rounded-[8px] p-3 text-xs text-off-white shadow-md pointer-events-none"
        role="tooltip"
      >
        <span className="block font-semibold text-electric-teal mb-1">
          {term}
        </span>
        <span className="block text-off-white leading-relaxed mb-1.5">
          {definition.brief}
        </span>
        <span className="block text-soft-grid italic leading-relaxed">
          {definition.analogy}
        </span>
      </span>
    </span>
  );
}

/**
 * 本文文字列から GLOSSARY のキーを検出し、見つかった箇所だけ Tooltip で包む。
 *
 * アルゴリズム:
 *   - 結果配列(string | ReactNode)を保持
 *   - 辞書キーを長い順に走査し、各 string 要素を term で split
 *   - split 結果の隙間に Tooltip ノードを挿入
 *   - 既に Tooltip 化された ReactNode はそのまま通す(二重ラップ防止)
 *
 * 副作用: AI が同じ用語を 10 回出すと、10 個の Tooltip ができる(性能 OK)。
 */
export function annotateText(body: string): ReactNode[] {
  let parts: (string | ReactNode)[] = [body];

  for (const term of GLOSSARY_KEYS_SORTED) {
    const next: (string | ReactNode)[] = [];
    for (const part of parts) {
      if (typeof part !== "string") {
        next.push(part);
        continue;
      }
      const segments = part.split(term);
      segments.forEach((seg, i) => {
        if (seg) next.push(seg);
        if (i < segments.length - 1) {
          next.push(
            <Tooltip
              key={`${term}-${next.length}`}
              term={term}
              definition={TECH_TERM_GLOSSARY[term]}
            />,
          );
        }
      });
    }
    parts = next;
  }

  return parts;
}

export default Tooltip;
