/**
 * v0.1.7:絵文字を撤廃して SVG アイコンで統一するためのアイコン集。
 * すべて outline スタイル、24×24 viewBox、`currentColor` 使用。
 * サイズは呼び出し側の className(`w-4 h-4` 等)で制御。
 */

type IconProps = {
  className?: string;
  color?: string;
};

/** ✨ Sparkles — セクションタイトルの装飾に使う */
export function SparkleIcon({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z" />
      <path
        d="M18.5 3 L19.2 5 L21 5.5 L19.2 6 L18.5 8 L17.8 6 L16 5.5 L17.8 5 Z"
        opacity="0.7"
      />
      <path
        d="M5 16 L5.6 17.6 L7 18 L5.6 18.4 L5 20 L4.4 18.4 L3 18 L4.4 17.6 Z"
        opacity="0.6"
      />
    </svg>
  );
}

/** ▶ Play triangle — エントリーポイント示唆 */
export function PlayTriangleIcon({ className = "w-3 h-3" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 4 L20 12 L7 20 Z" />
    </svg>
  );
}

/** 💡 Lightbulb — Tips / callout */
export function LightbulbIcon({ className = "w-4 h-4", color }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 21 H15" />
      <path d="M10 18 H14" />
      <path d="M12 3 A6 6 0 0 0 7 12 C8 14 8.5 15 9 16 H15 C15.5 15 16 14 17 12 A6 6 0 0 0 12 3 Z" />
    </svg>
  );
}

/** 📦 Package — 空状態 */
export function PackageIcon({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 8 L12 3 L21 8 V16 L12 21 L3 16 Z" />
      <path d="M3 8 L12 13 L21 8" />
      <path d="M12 13 V21" />
    </svg>
  );
}

/** 👆 CursorPointer — ヒント */
export function CursorPointerIcon({ className = "w-3.5 h-3.5" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3 V12" />
      <path d="M12 12 L14 20 L15.5 15 L20 14 Z" />
    </svg>
  );
}

/** 🟢/🟡/🔴/⚪ 相当:色付きのドット。color を渡すか、既定の inherit で使う */
export function DotIcon({
  className = "w-3 h-3",
  color = "currentColor",
}: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={className}
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="5" fill={color} />
    </svg>
  );
}
