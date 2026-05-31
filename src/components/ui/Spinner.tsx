import { t, type Language } from "../../lib/i18n";

/**
 * インライン SVG のスピナー(分析中などのローディング表示用)。
 *
 * Tailwind の `animate-spin` で連続回転。
 * 色は `currentColor` 継承なので親の `text-*` クラスで指定できる。
 * デフォルト Electric Teal(進行のブランド色)。
 *
 * v0.1.6: aria-label を UI 言語に応じて切替。language を渡されなければ "ja"。
 */
type SpinnerProps = {
  className?: string;
  language?: Language;
};

function Spinner({
  className = "w-4 h-4 text-electric-teal",
  language = "ja",
}: SpinnerProps) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={t(language).ui.spinnerLabel}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M12 2 a 10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default Spinner;
