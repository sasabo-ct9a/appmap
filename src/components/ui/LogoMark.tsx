/**
 * AppMap ロゴマーク(v0.1.8:Tilted Needle 案採用)。
 *
 * 構成要素:
 *   - 外枠: 暗いプレート(Charcoal #111827)、角丸 14px
 *   - 羅針盤の円: Electric Teal、細いストロークで半透明
 *   - 傾いた 2 色針: 北(濃 teal)+ 南(薄 teal)、35deg 回転で「これから進む」動きを示唆
 *   - 中央の白いピボットドット
 *
 * 色は HEX 直書き(ブランドマークなのでテーマトークンに依存させない)。
 * `className` で外側からサイズを指定する想定(例: `w-7 h-7`)。
 */
type LogoMarkProps = {
  className?: string;
};

function LogoMark({ className = "" }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="AppMap ロゴ"
    >
      {/* 外枠: 暗いプレート */}
      <rect width="64" height="64" rx="14" fill="#111827" />

      {/* 羅針盤の円(外周)*/}
      <circle
        cx="32"
        cy="32"
        r="25"
        fill="none"
        stroke="#14B8A6"
        strokeWidth="2.4"
        opacity="0.5"
      />

      {/* 傾いた 2 色針(35deg 回転)*/}
      <g transform="rotate(35 32 32)">
        {/* 北側:濃い teal(進行方向)*/}
        <path d="M32 10 L37.3 40 L32 34.7 L26.7 40 Z" fill="#14B8A6" />
        {/* 南側:薄い teal(後方、動きの残像)*/}
        <path
          d="M32 54 L37.3 24 L32 29.3 L26.7 24 Z"
          fill="#5EEAD4"
          opacity="0.85"
        />
      </g>

      {/* 中央ピボット */}
      <circle cx="32" cy="32" r="2.4" fill="#F9FAFB" />
    </svg>
  );
}

export default LogoMark;
