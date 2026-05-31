import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { annotateText } from "../ui/Tooltip";
import { t, type Language } from "../../lib/i18n";

/**
 * ノード詳細パネル(CLAUDE.md §10.5.4、DARK モード)。
 *
 * 構成:
 *   - パネルヘッダー: タイトル + 閉じる × ボタン、Charcoal の下境界線で仕切る
 *   - 本文エリア(スクロール可能):
 *     - Description セクション(node.detail.body または bodyNoCode)
 *     - 関連ノードセクション(エッジで繋がる隣接ノード一覧、§6 仕様)
 *
 * 関連ノードの導出: allEdges から from/to が node.id に一致するものを抽出し、
 *   反対側の id を集めて allNodes から該当する ScreenNode を取り出す。
 *   双方向(bidirectional)の扱いは現在「エッジ存在 = 関連」とシンプルに判定。
 *
 * カラーマッピング(§10.2 DARK モード):
 *   bg: Slate / 文字: Off White(主)・ Soft Grid(補助)/ 仕切り線: Charcoal
 *   関連ノードのアクセントドット: Electric Teal(ブランド色で繋がりを示す)
 *
 * props:
 *   - node: 表示するノード。null なら非表示
 *   - allNodes / allEdges: 関連ノード導出のための全データ
 *   - onClose: × クリック時(新 Step 4 で配線)
 *   - noCodeMode: true で bodyNoCode 表示(新 Step 5 で配線)
 */
type InspectorPanelProps = {
  node: ScreenNode | null;
  allNodes: ScreenNode[];
  allEdges: ScreenEdge[];
  onClose: () => void;
  noCodeMode: boolean;
  /** v0.1.6: UI 言語(セクション見出し・safety バッジの JA/EN 切替に使用)。 */
  language: Language;
};

function InspectorPanel({
  node,
  allNodes,
  allEdges,
  onClose,
  noCodeMode,
  language,
}: InspectorPanelProps) {
  const T = t(language);
  if (node === null) return null;

  const body = noCodeMode ? node.detail.bodyNoCode : node.detail.body;

  // 構造ラベル(セクション見出し)はモードに依らず統一(§2 ターゲットユーザー全員
  // 「コード読みたくない」前提なので、わざわざ技術寄り表記を用意する意味が薄い)。
  // 「DESCRIPTION」のような英語 / 「つながり」のような子供っぽい語は避け、
  // クリーンな Notion / Bubble ネイティブ語彙で統一。
  // noCodeMode の効果は **本文 body の翻訳** のみ。
  const descriptionLabel = T.inspector.descriptionLabel;
  const relatedLabel = T.inspector.relatedLabel;
  const filesLabel = T.inspector.filesLabel;
  const dataLabel = T.inspector.dataLabel;
  const hintLabel = T.inspector.hintLabel;
  const files = node.detail.files ?? [];
  const dataUsed = node.detail.dataUsed ?? [];
  const changeHint = node.detail.changeHint;

  // クイックウィン 5: changeHint の safety レベルに応じた色 / 文言(統一版)
  const safetyDisplay = (() => {
    if (!changeHint) return null;
    if (changeHint.safety === "easy") {
      return {
        label: T.inspector.safetyEasy,
        textColor: "text-electric-teal",
        bgColor: "bg-electric-teal/15",
      };
    }
    if (changeHint.safety === "risky") {
      return {
        label: T.inspector.safetyRisky,
        textColor: "text-alert-red",
        bgColor: "bg-alert-red/15",
      };
    }
    return {
      label: T.inspector.safetyNeutral,
      textColor: "text-muted-amber",
      bgColor: "bg-muted-amber/15",
    };
  })();

  // 関連ノード = この node に繋がるエッジで結ばれた他ノード
  const relatedIds = allEdges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => (e.from === node.id ? e.to : e.from));
  const relatedNodes = allNodes.filter((n) => relatedIds.includes(n.id));

  return (
    <aside
      className="w-[360px] bg-slate flex flex-col"
      aria-label={T.inspector.panelAriaLabel}
    >
      {/* パネルヘッダー */}
      <header className="border-b border-charcoal px-6 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-off-white leading-tight">
            {node.detail.title}
          </h2>
          {/* Phase 3 polish: path 風 mono 副題(NodeTile と一致させる)*/}
          <div className="text-xs text-soft-grid font-mono opacity-60 mt-1">
            /screen/{node.id}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={T.inspector.closeAriaLabel}
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-[8px] text-soft-grid hover:bg-charcoal transition-colors text-xl leading-none"
        >
          ×
        </button>
      </header>

      {/* 本文エリア — overflow-x を明示的に切り、Tooltip など絶対配置子要素が
          パネル右端を超えても横スクロールバーを出さない */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 space-y-6">
        {/* クイックウィン 3: エントリーポイントヒント(この画面から読むと早い) */}
        {node.isEntryPoint && (
          <div className="bg-electric-teal/10 border border-electric-teal/40 rounded-[8px] px-3 py-2 text-xs text-electric-teal">
            {T.inspector.entryPointHint}
          </div>
        )}

        {/* Description */}
        <section>
          <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
            {descriptionLabel}
          </h3>
          {/*
            機能拡張 G: 本文中の専門用語に hover 解説を仕込む(§3.3、§10.5.7)。
            noCodeMode ON のときも適用(bodyNoCode に Database のような
            Bubble/Notion 用語が出てくる場合、analogy が役に立つ)。
          */}
          <p className="text-sm leading-relaxed text-off-white">
            {annotateText(body)}
          </p>
        </section>

        {/* クイックウィン 4: この画面で使っているデータ(非技術名) */}
        {dataUsed.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
              {dataLabel}({dataUsed.length})
            </h3>
            <ul className="space-y-1">
              {dataUsed.map((d) => (
                <li
                  key={d}
                  className="text-sm text-off-white flex items-center gap-2"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-muted-amber flex-shrink-0"
                    aria-hidden="true"
                  />
                  {d}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* クイックウィン 5: 変更しやすさ / 影響範囲ヒント */}
        {changeHint && safetyDisplay && (
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
              {hintLabel}
            </h3>
            <div
              className={`${safetyDisplay.bgColor} rounded-[8px] px-3 py-2`}
            >
              <div
                className={`text-xs font-semibold ${safetyDisplay.textColor} mb-1`}
              >
                {safetyDisplay.label}
              </div>
              <div className="text-sm text-off-white leading-relaxed">
                {annotateText(changeHint.note)}
              </div>
            </div>
          </section>
        )}

        {/*
          関連ファイル(機能拡張 C): AI が「この画面に対応する実コード」を
          特定できているノードだけ表示。ノーコード経験者は「自分のアプリのこの画面が
          コード上どこか」を一目で照らせるようになる。
        */}
        {files.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
              {filesLabel}({files.length})
            </h3>
            <ul className="space-y-1">
              {files.map((f) => (
                <li
                  key={f}
                  className="text-xs text-off-white font-mono break-all leading-relaxed select-text"
                  title={f}
                >
                  {f}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 関連ノード(エッジで繋がる隣接ノード) */}
        {relatedNodes.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-2">
              {relatedLabel}({relatedNodes.length})
            </h3>
            <ul className="space-y-2">
              {relatedNodes.map((n) => (
                <li
                  key={n.id}
                  className="text-sm text-off-white flex items-center gap-2"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-electric-teal flex-shrink-0"
                    aria-hidden="true"
                  />
                  {n.label}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

export default InspectorPanel;
