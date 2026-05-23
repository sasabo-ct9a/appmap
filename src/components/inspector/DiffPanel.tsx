import type { ScreenDiffResult } from "../../lib/screenDiff";
import { fieldLabel } from "../../lib/screenDiff";

/**
 * 比較モード時に Inspector の代わりに右側に表示される差分パネル(v0.1.4)。
 *
 * 三区分構成:
 *   1. 概要バー(2 つのタブ名 + マッチ戦略 + 件数バッジ)
 *   2. アクティブ(base)だけにあるノード - 緑
 *   3. 比較対象(compare)だけにあるノード - 赤
 *   4. 両方にあって内容が変わったノード - 黄
 *   5. (任意)両方にあって変化なし - グレー(折りたたみ)
 *
 * 同フォルダ比較なら「前回 → 今回」の意味、別フォルダ比較なら「左 vs 右」の意味。
 */
type DiffPanelProps = {
  diff: ScreenDiffResult;
  /** 表示用のラベル(タブのフォルダ末尾2階層など) */
  baseLabel: string;
  compareLabel: string;
  onClose: () => void;
};

function shortMatchHint(matchedBy: "id" | "label"): string {
  return matchedBy === "id"
    ? "同じフォルダの再分析を比較(画面 id で対応付け)"
    : "別フォルダ同士を比較(画面のラベル名で対応付け)";
}

function DiffPanel({ diff, baseLabel, compareLabel, onClose }: DiffPanelProps) {
  const { onlyInBase, onlyInCompare, modified, unchanged, summaryDiff, edgeCountDiff } =
    diff;

  return (
    <aside
      className="w-[360px] bg-slate flex flex-col"
      aria-label="比較差分パネル"
    >
      {/* ヘッダー */}
      <header className="border-b border-charcoal px-6 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-off-white leading-tight">
            比較結果
          </h2>
          <div className="text-xs text-soft-grid mt-1 font-mono break-all">
            {baseLabel} <span className="text-electric-teal">vs</span>{" "}
            {compareLabel}
          </div>
          <div className="text-xs text-soft-grid opacity-70 mt-1">
            {shortMatchHint(diff.matchedBy)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-[8px] text-soft-grid hover:bg-charcoal transition-colors text-xl leading-none"
        >
          ×
        </button>
      </header>

      {/* 本文 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 space-y-6">
        {/* 概要バッジ */}
        <section className="flex flex-wrap gap-2">
          <Badge color="electric-teal" count={onlyInBase.length} label="アクティブだけ" />
          <Badge color="alert-red" count={onlyInCompare.length} label="比較対象だけ" />
          <Badge color="muted-amber" count={modified.length} label="変わった" />
          <Badge color="soft-grid" count={unchanged.length} label="同じ" />
        </section>

        {/* リンク数の差分 */}
        <section>
          <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
            リンク数
          </h3>
          <div className="text-sm text-off-white">
            アクティブ <span className="font-mono">{edgeCountDiff.base}</span> /
            比較対象 <span className="font-mono">{edgeCountDiff.compare}</span>
            {edgeCountDiff.delta !== 0 && (
              <span className="ml-2 text-xs text-soft-grid">
                (差 {edgeCountDiff.delta > 0 ? "+" : ""}
                {edgeCountDiff.delta})
              </span>
            )}
          </div>
        </section>

        {/* サマリー差分 */}
        {summaryDiff.changed && (
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
              アプリ概要が変わった
            </h3>
            <div className="space-y-2 text-xs">
              {summaryDiff.base && (
                <div className="bg-electric-teal/10 p-2 rounded-[8px]">
                  <div className="text-electric-teal text-[10px] mb-1">
                    アクティブ
                  </div>
                  <div className="text-off-white leading-relaxed">
                    {summaryDiff.base}
                  </div>
                </div>
              )}
              {summaryDiff.compare && (
                <div className="bg-alert-red/10 p-2 rounded-[8px]">
                  <div className="text-alert-red text-[10px] mb-1">比較対象</div>
                  <div className="text-off-white leading-relaxed">
                    {summaryDiff.compare}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* アクティブだけにある */}
        {onlyInBase.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-electric-teal uppercase tracking-wide mb-2">
              ✓ アクティブだけにある画面({onlyInBase.length})
            </h3>
            <ul className="space-y-1">
              {onlyInBase.map((n) => (
                <li
                  key={`base-${n.id}`}
                  className="text-sm text-off-white flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-electric-teal flex-shrink-0" />
                  {n.label}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 比較対象だけにある */}
        {onlyInCompare.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-alert-red uppercase tracking-wide mb-2">
              ✗ 比較対象だけにある画面({onlyInCompare.length})
            </h3>
            <ul className="space-y-1">
              {onlyInCompare.map((n) => (
                <li
                  key={`cmp-${n.id}`}
                  className="text-sm text-off-white flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-alert-red flex-shrink-0" />
                  {n.label}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 変わった */}
        {modified.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-muted-amber uppercase tracking-wide mb-2">
              ⚠ 変わった画面({modified.length})
            </h3>
            <ul className="space-y-2">
              {modified.map((m) => (
                <li
                  key={`mod-${m.base.id}`}
                  className="text-sm text-off-white"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-amber flex-shrink-0" />
                    <span>{m.base.label}</span>
                  </div>
                  <div className="text-xs text-soft-grid ml-3.5 mt-0.5">
                    {m.changedFields.map(fieldLabel).join(" / ")}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 完全一致は折りたたみ */}
        {unchanged.length > 0 && (
          <details className="text-xs">
            <summary className="text-soft-grid cursor-pointer select-none">
              同じ画面({unchanged.length})を表示
            </summary>
            <ul className="space-y-1 mt-2">
              {unchanged.map((m) => (
                <li
                  key={`u-${m.base.id}`}
                  className="text-soft-grid flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-soft-grid/50 flex-shrink-0" />
                  {m.base.label}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </aside>
  );
}

function Badge({
  color,
  count,
  label,
}: {
  color: "electric-teal" | "alert-red" | "muted-amber" | "soft-grid";
  count: number;
  label: string;
}) {
  const cls = {
    "electric-teal": "bg-electric-teal/15 text-electric-teal",
    "alert-red": "bg-alert-red/15 text-alert-red",
    "muted-amber": "bg-muted-amber/15 text-muted-amber",
    "soft-grid": "bg-soft-grid/15 text-soft-grid",
  }[color];
  return (
    <div
      className={`${cls} rounded-[8px] px-2 py-1 text-xs flex items-center gap-1.5`}
    >
      <span className="font-mono font-semibold">{count}</span>
      <span>{label}</span>
    </div>
  );
}

export default DiffPanel;
