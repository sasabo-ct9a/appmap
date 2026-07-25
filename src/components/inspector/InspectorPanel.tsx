import { useEffect, useRef, useState } from "react";
import type { ScreenNode, ScreenEdge } from "../../types/screen";
import { t, pickLocalized, type Language } from "../../lib/i18n";
import { PlayTriangleIcon, LightbulbIcon } from "../ui/Icons";
import { computeStableColorIndex, paletteAt } from "../../lib/nodeColors";
import {
  getNote,
  setNote,
  type NodeTag,
} from "../../lib/nodeNotes";
import {
  askNode,
  clearQAHistory,
  loadQAHistory,
  saveQAHistory,
  type QAMessage,
} from "../../lib/nodeQA";
import type { EditorChoice, Engine } from "../../lib/storage";
import { openInEditor } from "../../lib/openInEditor";

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
  /** v0.1.8:メモ・タグの localStorage キーに使う。null = サンプル用 */
  folderPath: string | null;
  /** v0.1.8:このノードのメモが変更された時に親に通知(バッジ表示更新のため)*/
  onNoteChange?: () => void;
  /** v0.1.8:AI Q&A の呼び分け(claude / local)*/
  engine: Engine;
  /** v0.1.8:関連ファイルクリックで開くエディタ */
  preferredEditor: EditorChoice;
};

// v0.1.7 色統一:nodeColors の stable index + paletteAt を使用

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
  folderPath,
  onNoteChange,
  engine,
  preferredEditor,
}: InspectorPanelProps) {
  const T = t(language);
  // v0.1.8:メモ・タグ。ノード切替時に該当データを再読込
  const [tag, setTag] = useState<NodeTag | null>(null);
  const [memo, setMemo] = useState<string>("");
  // v0.1.8:Q&A 状態
  const [qaHistory, setQaHistory] = useState<QAMessage[]>([]);
  const [qaInput, setQaInput] = useState<string>("");
  const [qaLoading, setQaLoading] = useState<boolean>(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const qaScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (node === null) return;
    const n = getNote(folderPath, node.id);
    setTag(n.tag);
    setMemo(n.memo);
    // Q&A 履歴も同時に切替
    setQaHistory(loadQAHistory(folderPath, node.id));
    setQaInput("");
    setQaError(null);
  }, [node?.id, folderPath, node]);

  // 応答が来た後、履歴の末尾までスクロール
  useEffect(() => {
    if (qaScrollRef.current) {
      qaScrollRef.current.scrollTop = qaScrollRef.current.scrollHeight;
    }
  }, [qaHistory.length, qaLoading]);

  if (node === null) return null;

  const handleAskAI = async (question: string) => {
    if (!question.trim() || qaLoading || node === null) return;
    const userMsg: QAMessage = {
      role: "user",
      content: question.trim(),
      timestamp: Date.now(),
    };
    const nextHistory = [...qaHistory, userMsg];
    setQaHistory(nextHistory);
    saveQAHistory(folderPath, node.id, nextHistory);
    setQaInput("");
    setQaLoading(true);
    setQaError(null);
    try {
      const answer = await askNode({
        node,
        allNodes,
        allEdges,
        question,
        engine,
        language,
        folderPath,
      });
      const aiMsg: QAMessage = {
        role: "assistant",
        content: answer,
        timestamp: Date.now(),
      };
      const finalHistory = [...nextHistory, aiMsg];
      setQaHistory(finalHistory);
      saveQAHistory(folderPath, node.id, finalHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setQaError(msg || T.qa.errorGeneric);
    } finally {
      setQaLoading(false);
    }
  };

  // v0.1.7 色統一
  const stableColorIndex = computeStableColorIndex(allNodes, allEdges, language);
  const paletteFor = (id: number) =>
    paletteAt(stableColorIndex.get(id) ?? 0);
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
              <PlayTriangleIcon className="w-2 h-2" />
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
                <LightbulbIcon
                  className="w-4 h-4 flex-shrink-0 mt-0.5"
                  color={palette.text}
                />
                <p className="text-xs text-ink leading-relaxed">
                  {pickLocalized(changeHint.note, language)}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-ink-soft mb-3 leading-relaxed">
              {impact.desc}
            </p>
            {/* バーの意味を明示:何を測っているかが一目で分かるように */}
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-ink-strong">
                {tx("この変更の影響の大きさ", "Impact of this change")}
              </span>
              <span
                className="text-[11px] font-bold tabular-nums"
                style={{ color: impact.color }}
              >
                {impact.shortLabel}
              </span>
            </div>
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

        {/* v0.1.8:メモとタグ(自分専用の付箋、ローカル保存)*/}
        <Section title={T.notes.sectionTitle}>
          <div className="mb-2">
            <div className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-1.5">
              {T.notes.tagsLabel}
            </div>
            {(() => {
              const options: {
                key: NodeTag;
                label: string;
                color: string;
                hint: string;
              }[] = [
                {
                  key: "important",
                  label: T.notes.tagImportant,
                  color: "#ef4444",
                  hint: T.notes.tagHintImportant,
                },
                {
                  key: "later",
                  label: T.notes.tagLater,
                  color: "#f59e0b",
                  hint: T.notes.tagHintLater,
                },
                {
                  key: "question",
                  label: T.notes.tagQuestion,
                  color: "#6366f1",
                  hint: T.notes.tagHintQuestion,
                },
                {
                  key: "reviewed",
                  label: T.notes.tagReviewed,
                  color: "#14b8a6",
                  hint: T.notes.tagHintReviewed,
                },
              ];
              const activeHint = options.find((o) => o.key === tag)?.hint ?? "";
              return (
                <>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {options.map((opt) => {
                      const active = tag === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          title={opt.hint}
                          onClick={() => {
                            const next = active ? null : opt.key;
                            setTag(next);
                            setNote(folderPath, node.id, {
                              tag: next,
                              memo,
                            });
                            onNoteChange?.();
                          }}
                          className="text-[11px] font-semibold px-2 py-1 rounded-full border transition-colors cursor-pointer"
                          style={{
                            background: active ? opt.color : "transparent",
                            borderColor: opt.color,
                            color: active ? "white" : opt.color,
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                    {tag !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          setTag(null);
                          setNote(folderPath, node.id, {
                            tag: null,
                            memo,
                          });
                          onNoteChange?.();
                        }}
                        className="text-[10px] text-ink-soft underline hover:text-ink transition-colors cursor-pointer px-1"
                      >
                        {T.notes.tagClear}
                      </button>
                    )}
                  </div>
                  {/* 選択中タグの説明。未選択時は 4 種類の凡例を表示 */}
                  {tag !== null ? (
                    <div
                      className="rounded-[8px] px-2.5 py-1.5 text-[11px] leading-relaxed"
                      style={{
                        background: `${
                          options.find((o) => o.key === tag)?.color
                        }14`,
                        color:
                          options.find((o) => o.key === tag)?.color ??
                          "#334155",
                      }}
                    >
                      {activeHint}
                    </div>
                  ) : (
                    <ul className="space-y-1 text-[10.5px] text-ink-soft leading-snug">
                      {options.map((opt) => (
                        <li
                          key={opt.key}
                          className="flex items-start gap-1.5"
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1"
                            style={{ background: opt.color }}
                          />
                          <span>
                            <span
                              className="font-semibold mr-1"
                              style={{ color: opt.color }}
                            >
                              {opt.label}:
                            </span>
                            {opt.hint}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              );
            })()}
          </div>
          <div>
            <div className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-1.5">
              {T.notes.memoLabel}
            </div>
            <textarea
              value={memo}
              onChange={(e) => {
                const v = e.target.value;
                setMemo(v);
                setNote(folderPath, node.id, { tag, memo: v });
                onNoteChange?.();
              }}
              placeholder={T.notes.memoPlaceholder}
              spellCheck={false}
              rows={3}
              className="w-full text-xs text-ink-strong bg-canvas border border-border-soft rounded-[8px] px-2.5 py-2 resize-y outline-none focus:border-feature-teal focus:ring-2 focus:ring-feature-teal/30 transition-colors leading-relaxed"
              style={{ minHeight: 60, maxHeight: 180 }}
            />
            <p className="text-[10px] text-ink-soft mt-1 leading-snug">
              {T.notes.hint}
            </p>
          </div>
        </Section>

        {/* v0.1.8:AI に聞く(ノード単位の Q&A、履歴はフォルダ×ノードで localStorage 保存)*/}
        <Section title={T.qa.sectionTitle}>
          <p className="text-[11px] text-ink-soft mb-2 leading-relaxed">
            {T.qa.hint}
          </p>

          {/* 履歴(質問が 1 件以上、またはローディング/エラーがある時だけ枠を出す。
              空の時に枠を出すと「入力欄?」と誤解されるので敢えて出さない)*/}
          {(qaHistory.length > 0 || qaLoading || qaError) && (
            <div
              ref={qaScrollRef}
              className="rounded-[10px] bg-canvas border border-border-soft p-2.5 space-y-2 mb-2 overflow-y-auto"
              style={{ maxHeight: 260 }}
            >
              {qaHistory.map((m, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span
                    className="flex-shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={{
                      background:
                        m.role === "user"
                          ? "var(--color-feature-blue-soft)"
                          : "var(--color-feature-teal-soft)",
                      color:
                        m.role === "user"
                          ? "var(--color-feature-blue)"
                          : "var(--color-feature-teal)",
                    }}
                  >
                    {m.role === "user" ? T.qa.youLabel : T.qa.aiLabel}
                  </span>
                  <p className="text-[12px] text-ink-strong leading-relaxed flex-1 whitespace-pre-wrap break-words">
                    {m.content}
                  </p>
                </div>
              ))}
              {qaLoading && (
                <div className="flex items-center gap-2 py-1">
                  <span
                    className="w-3 h-3 rounded-full border-2 border-feature-teal border-t-transparent animate-spin"
                    aria-hidden="true"
                  />
                  <span className="text-[11px] text-ink-soft italic">
                    {T.qa.sending}
                  </span>
                </div>
              )}
              {qaError && (
                <div
                  className="text-[11px] rounded-[8px] px-2 py-1.5"
                  style={{
                    background: "var(--color-impact-high-soft, #fee2e2)",
                    color: "var(--color-impact-high, #b91c1c)",
                  }}
                >
                  {qaError}
                </div>
              )}
            </div>
          )}

          {/* サジェスチョン(履歴が空の時だけ)*/}
          {qaHistory.length === 0 && !qaLoading && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide mb-1">
                {T.qa.suggestionsLabel}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  T.qa.suggestionWhat,
                  T.qa.suggestionRisk,
                  T.qa.suggestionRename,
                ].map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleAskAI(s)}
                    disabled={qaLoading}
                    className="text-[11px] px-2 py-1 rounded-full border border-border-soft bg-paper text-ink-strong hover:bg-canvas cursor-pointer transition-colors disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 入力 + 送信 */}
          <div className="flex gap-1.5">
            <textarea
              value={qaInput}
              onChange={(e) => setQaInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.metaKey || e.ctrlKey) &&
                  !qaLoading
                ) {
                  e.preventDefault();
                  handleAskAI(qaInput);
                }
              }}
              placeholder={T.qa.placeholder}
              disabled={qaLoading}
              spellCheck={false}
              rows={2}
              className="flex-1 text-xs text-ink-strong bg-canvas border border-border-soft rounded-[8px] px-2.5 py-1.5 resize-none outline-none focus:border-feature-teal focus:ring-2 focus:ring-feature-teal/30 transition-colors leading-relaxed disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => handleAskAI(qaInput)}
              disabled={qaLoading || !qaInput.trim()}
              className="flex-shrink-0 text-xs font-semibold px-3 rounded-[8px] bg-feature-teal text-white hover:bg-feature-teal/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {T.qa.sendButton}
            </button>
          </div>

          {qaHistory.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(T.qa.clearConfirm)) {
                  clearQAHistory(folderPath, node.id);
                  setQaHistory([]);
                  setQaError(null);
                }
              }}
              className="text-[10px] text-ink-soft underline hover:text-ink transition-colors cursor-pointer mt-2"
            >
              {T.qa.clearButton}
            </button>
          )}
        </Section>

        {/* 関連ファイル(v0.1.8:クリックで外部エディタ起動)*/}
        {files.length > 0 && (
          <details className="group">
            <summary className="text-[11px] font-bold text-ink-soft uppercase tracking-wide cursor-pointer flex items-center gap-1.5 select-none hover:text-ink transition-colors">
              <ChevronRight className="group-open:rotate-90 transition-transform" />
              {tx("関連ファイル", "Related files")} ({files.length})
              <span
                className="text-[9px] font-normal normal-case tracking-normal text-ink-soft ml-1 opacity-70"
                title={
                  folderPath
                    ? tx(
                        `クリックで ${editorLabel(preferredEditor, language)} で開く`,
                        `Click to open in ${editorLabel(preferredEditor, language)}`,
                      )
                    : tx("サンプル表示中は開けません", "Sample mode — files aren't openable")
                }
              >
                {folderPath
                  ? tx(
                      `— クリックで ${editorLabel(preferredEditor, language)} で開く`,
                      `— click to open in ${editorLabel(preferredEditor, language)}`,
                    )
                  : ""}
              </span>
            </summary>
            <ul className="mt-2 space-y-1 pl-4">
              {files.map((f) => {
                const isOpenable = folderPath !== null;
                return (
                  <li key={f}>
                    <button
                      type="button"
                      disabled={!isOpenable}
                      onClick={async () => {
                        if (!isOpenable) return;
                        try {
                          await openInEditor({
                            editor: preferredEditor,
                            folder: folderPath,
                            file: f,
                          });
                        } catch (err) {
                          const msg =
                            err instanceof Error ? err.message : String(err);
                          window.alert(
                            `${T.localLLM.editorOpenFailedTitle}\n\n${T.localLLM.editorOpenFailedBody}\n\n(${msg})`,
                          );
                        }
                      }}
                      className={`w-full text-left text-[11px] font-mono break-all leading-relaxed rounded px-2 py-1 -mx-2 transition-colors ${
                        isOpenable
                          ? "text-ink cursor-pointer hover:bg-canvas hover:text-feature-teal"
                          : "text-ink-soft cursor-not-allowed opacity-60"
                      }`}
                      title={
                        isOpenable
                          ? tx(
                              `${editorLabel(preferredEditor, language)} で開く`,
                              `Open in ${editorLabel(preferredEditor, language)}`,
                            )
                          : tx(
                              "サンプル表示中はファイルパスが実在しないため開けません",
                              "Sample paths don't exist on disk",
                            )
                      }
                    >
                      {f}
                    </button>
                  </li>
                );
              })}
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

/** v0.1.8:エディタ選択を短いラベルに整形(tooltip / hint 表示用)。 */
function editorLabel(editor: EditorChoice, language: Language): string {
  const isJa = language === "ja";
  if (editor === "cursor") return "Cursor";
  if (editor === "vscode") return "VS Code";
  return isJa ? "OS 既定" : "OS default";
}

export default InspectorPanel;
