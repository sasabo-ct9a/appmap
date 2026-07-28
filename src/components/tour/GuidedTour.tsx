import { useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "../../lib/i18n";

/**
 * v0.1.10:ガイド付きツアー。ノーコード経験者が「何ができるか」を段階的に把握するため。
 *
 * 設計:
 *   - トリガー:サイドバーの「ツアーを開始」ボタンからのみ(自動起動なし)
 *   - 形式:スポットライトオーバーレイ(SVG マスクで対象だけ切り抜き)
 *   - 対象:data-tour="..." 属性で指定
 *   - 対象が見つからない/画面外のステップは自動 skip(現在のページ状態に依存しない)
 *   - スキップ・完了は同一(閉じるだけ、フラグ保存しない)
 *
 * 外部ライブラリを使わない理由:100 行程度の SVG マスク描画で足りるので依存を増やさない。
 */

export type TourStep = {
  /** data-tour="foo" の "foo" 部分。center 表示なら省略。*/
  target?: string;
  title: string;
  body: string;
  /** カードの配置(target からどちら方向に出すか)。省略時は自動判定 */
  placement?: "top" | "bottom" | "left" | "right" | "center";
};

type GuidedTourProps = {
  open: boolean;
  onClose: () => void;
  language: Language;
  steps: TourStep[];
};

const PADDING = 8; // 対象矩形の周囲に空けるマージン
const CARD_WIDTH = 320;
const CARD_MARGIN = 14; // 対象矩形とカードの間隔

type Rect = { x: number; y: number; width: number; height: number } | null;

function GuidedTour({ open, onClose, language, steps }: GuidedTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect>(null);
  const [viewport, setViewport] = useState({
    w: typeof window !== "undefined" ? window.innerWidth : 1200,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  });
  const cardRef = useRef<HTMLDivElement | null>(null);

  const isJa = language === "ja";
  const T = useMemo(
    () => ({
      next: isJa ? "次へ" : "Next",
      back: isJa ? "戻る" : "Back",
      skip: isJa ? "スキップ" : "Skip",
      close: isJa ? "閉じる" : "Close",
      done: isJa ? "完了" : "Done",
      step: (n: number, total: number) =>
        isJa ? `${n} / ${total}` : `${n} of ${total}`,
    }),
    [isJa],
  );

  const currentStep = steps[stepIndex] ?? null;

  // open が切り替わったら 0 に戻す。閉じるときも同じで OK
  useEffect(() => {
    if (open) {
      setStepIndex(0);
      // v0.1.10:open した瞬間の実 window サイズに viewport を同期。
      //   コンポーネントは App.tsx 起動時にマウントされるため useState 初期値は
      //   その時点のサイズをキャプチャしたまま古くなりがち(ユーザーが後で
      //   ウィンドウをリサイズすると背景オーバーレイが画面全体を覆わない不具合の原因)。
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    }
  }, [open]);

  // v0.1.10:ステップが切り替わった瞬間に対象要素を画面内に強制表示 → 座標を確定。
  //   注意:App.tsx の <main> が overflow-auto で独自スクロールしているため、
  //   scrollIntoView({ block: "center" }) が親スクロールコンテナを勝手にたどってくれる。
  //
  //   v0.1.10 追加:ウィンドウリサイズ / スクロール / 対象要素のサイズ変化で
  //   位置がずれるので、以下のイベントで rect を再測定する:
  //     - window resize(ウィンドウ幅高さ変更 → layout reflow で target が動く)
  //     - scroll(capture, ドキュメント全域 → App.tsx の <main> の内部スクロール含む)
  //     - ResizeObserver(target + documentElement → 内部レイアウト変化に反応)
  //   すべて rAF debounce することで、連続イベントでも 1 フレーム内に 1 回だけ測定。
  useEffect(() => {
    if (!open) return;
    const target = currentStep?.target;
    if (!target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${target}"]`);
    if (!el) {
      setRect(null);
      return;
    }

    // 共通の測定関数(初回 + 再測定で使い回し)
    let pendingRaf: number | null = null;
    const measure = () => {
      pendingRaf = null;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setRect({ x: r.left, y: r.top, width: r.width, height: r.height });
      } else {
        setRect(null);
      }
      // viewport も同時に更新(SVG 全体サイズ)。resize で乖離しないように。
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    const scheduleMeasure = () => {
      if (pendingRaf !== null) return; // 同フレーム内の重複を捨てる
      pendingRaf = requestAnimationFrame(measure);
    };

    // 初回:対象を画面中央に持ってきてから 1 フレーム後に測定
    el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    scheduleMeasure();

    // 変化を監視する複数のソース
    window.addEventListener("resize", scheduleMeasure);
    // capture:true で App.tsx の <main> のような内部スクロールも拾える
    window.addEventListener("scroll", scheduleMeasure, { capture: true, passive: true });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(el);
    resizeObserver.observe(document.documentElement);

    return () => {
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, { capture: true });
      resizeObserver.disconnect();
    };
  }, [open, currentStep]);

  // ESC で閉じる、← → で移動
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        setStepIndex((i) => (i < steps.length - 1 ? i + 1 : i));
      } else if (e.key === "ArrowLeft") {
        setStepIndex((i) => (i > 0 ? i - 1 : i));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, steps.length, onClose]);

  if (!open || !currentStep) return null;

  // 対象要素をハイライトする矩形(padding 込み)
  const highlight = rect
    ? {
        x: Math.max(0, rect.x - PADDING),
        y: Math.max(0, rect.y - PADDING),
        width: rect.width + PADDING * 2,
        height: rect.height + PADDING * 2,
      }
    : null;

  // カード位置決定
  const cardPos = computeCardPosition(
    highlight,
    currentStep.placement,
    viewport,
    CARD_WIDTH,
  );

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={isJa ? "ガイド付きツアー" : "Guided tour"}
    >
      {/* SVG マスクで対象矩形だけ切り抜いた背景。
          v0.1.10:viewBox を明示して DOM の CSS サイズ(w-full h-full)と
          内部座標系(viewport.w × viewport.h)を一致させる。
          これが無いと SVG が伸縮せず一部しか darkened にならない不具合が出る。 */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-auto"
        viewBox={`0 0 ${viewport.w} ${viewport.h}`}
        preserveAspectRatio="none"
        onClick={onClose}
      >
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width={viewport.w} height={viewport.h} fill="white" />
            {highlight && (
              <rect
                x={highlight.x}
                y={highlight.y}
                width={highlight.width}
                height={highlight.height}
                rx="10"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width={viewport.w}
          height={viewport.h}
          fill="rgba(0, 0, 0, 0.55)"
          mask="url(#tour-mask)"
        />
        {highlight && (
          <rect
            x={highlight.x}
            y={highlight.y}
            width={highlight.width}
            height={highlight.height}
            rx="10"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2.5"
            pointerEvents="none"
          />
        )}
      </svg>

      {/* 説明カード。onClick は自身の伝播を止めて背景クリックのみで閉じるようにする */}
      <div
        ref={cardRef}
        className="absolute bg-paper rounded-[14px] shadow-lg border border-border-soft"
        style={{
          left: cardPos.left,
          top: cardPos.top,
          width: CARD_WIDTH,
          pointerEvents: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-feature-teal">
              {T.step(stepIndex + 1, steps.length)}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="text-ink-soft hover:text-ink text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-canvas cursor-pointer"
              aria-label={T.close}
            >
              ×
            </button>
          </div>
          <h3 className="text-base font-bold text-ink-strong mb-1.5">
            {currentStep.title}
          </h3>
          <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
            {currentStep.body}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-soft bg-canvas rounded-b-[14px]">
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-ink-soft hover:text-ink cursor-pointer"
          >
            {T.skip}
          </button>
          <div className="flex items-center gap-2">
            {/* 進捗ドット */}
            <div className="flex items-center gap-1 mr-2" aria-hidden="true">
              {steps.map((_, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    width: i === stepIndex ? 10 : 6,
                    height: 6,
                    borderRadius: 3,
                    background:
                      i === stepIndex
                        ? "var(--color-feature-teal)"
                        : "rgba(148,163,184,0.5)",
                    transition: "all 120ms",
                  }}
                />
              ))}
            </div>
            {!isFirst && (
              <button
                type="button"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                className="text-[12px] text-ink hover:bg-canvas px-3 py-1.5 rounded-[8px] border border-border-soft cursor-pointer"
              >
                {T.back}
              </button>
            )}
            <button
              type="button"
              onClick={
                isLast
                  ? onClose
                  : () =>
                      setStepIndex((i) => Math.min(steps.length - 1, i + 1))
              }
              className="text-[12px] font-semibold text-white bg-feature-teal hover:bg-feature-teal/90 px-3 py-1.5 rounded-[8px] cursor-pointer"
            >
              {isLast ? T.done : T.next}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** カード位置を対象矩形の周囲から決定。ビューポート外にはみ出さないようクランプ */
function computeCardPosition(
  highlight: { x: number; y: number; width: number; height: number } | null,
  placement: TourStep["placement"],
  viewport: { w: number; h: number },
  cardWidth: number,
): { left: number; top: number } {
  // 対象がない or center 指定 → 中央
  if (!highlight || placement === "center") {
    return {
      left: Math.max(0, viewport.w / 2 - cardWidth / 2),
      top: Math.max(0, viewport.h / 2 - 100),
    };
  }
  const estimatedCardH = 190; // カード高さ想定(実測は面倒なので固定値)
  // 自動判定:右側に空間があれば right、下に空間があれば bottom、というシンプルなロジック
  let effective = placement;
  if (!effective) {
    const spaceRight = viewport.w - (highlight.x + highlight.width);
    const spaceBelow = viewport.h - (highlight.y + highlight.height);
    if (spaceRight >= cardWidth + CARD_MARGIN + 20) effective = "right";
    else if (spaceBelow >= estimatedCardH + CARD_MARGIN + 20) effective = "bottom";
    else if (highlight.x >= cardWidth + CARD_MARGIN + 20) effective = "left";
    else effective = "top";
  }
  let left = 0;
  let top = 0;
  if (effective === "right") {
    left = highlight.x + highlight.width + CARD_MARGIN;
    top = highlight.y;
  } else if (effective === "left") {
    left = highlight.x - cardWidth - CARD_MARGIN;
    top = highlight.y;
  } else if (effective === "top") {
    left = highlight.x + highlight.width / 2 - cardWidth / 2;
    top = highlight.y - estimatedCardH - CARD_MARGIN;
  } else {
    // bottom
    left = highlight.x + highlight.width / 2 - cardWidth / 2;
    top = highlight.y + highlight.height + CARD_MARGIN;
  }
  // ビューポートクランプ(端 8px マージン)
  left = Math.min(viewport.w - cardWidth - 8, Math.max(8, left));
  top = Math.min(viewport.h - estimatedCardH - 8, Math.max(8, top));
  return { left, top };
}

export default GuidedTour;
