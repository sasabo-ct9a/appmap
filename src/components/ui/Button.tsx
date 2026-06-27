import type { ReactNode } from "react";

/**
 * Button(CLAUDE.md §10.5.5、DARK モード)。
 *
 * Phase 3 で使う variant のみ実装(Primary, Secondary)。
 * Tertiary / Danger は使う場面が出てきた時に追加(KISS、§7「小さく作って動かす」)。
 *
 * - Primary: bg Electric Teal、文字 white、hover 時 90% 透過で軽く暗く
 * - Secondary: 透明背景 + 1px Soft Grid outline、文字 Off White、hover 時 bg-slate
 * - すべて 14px 半径(§10.4 主役級操作)
 * - disabled 時は opacity-50 + cursor-not-allowed
 */
type ButtonProps = {
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
};

// v0.1.7 大刷新:LIGHT モードに合わせて色更新。Primary は teal、Secondary は白背景 + ink テキスト。
const VARIANT_CLASSES: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-feature-teal hover:bg-feature-teal/90 text-white shadow-sm",
  secondary:
    "border border-border-soft text-ink hover:bg-canvas bg-paper",
};

function Button({
  variant = "primary",
  type = "button",
  disabled,
  onClick,
  children,
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-[14px] text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </button>
  );
}

export default Button;
