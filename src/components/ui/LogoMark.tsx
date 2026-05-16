/**
 * AppMap ロゴマーク(Map Window 案、Doc 3 §1-A 採用)。
 *
 * 構成要素:
 *   - 外枠: 暗いプレート(Charcoal)、角丸 14px(縮小時のスケール感を保つ rx=14/64)
 *   - 内側ウィンドウ枠: 細いストロークの矩形 + 上部にトラフィックドット 3 つ
 *   - マップグラフ: 4 ノード + 4 エッジ。3 ノードを Electric Teal で塗り、
 *     1 ノードは枠線のみで強弱を出す
 *
 * 色は HEX 直書き(ブランドマークなのでテーマトークンに依存させない)。
 * `className` で外側からサイズを指定する想定(例: `w-7 h-7`)。
 *
 * 注: 本コンポーネントはユーザー提供のアイコン画像(チャット添付)から
 * **目視で再構成した近似版**。デザイン原本(SVG / Figma 等)の供給があれば
 * 差し替え可能。
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

      {/* 内側のウィンドウ枠 */}
      <rect
        x="10"
        y="10"
        width="44"
        height="44"
        rx="3"
        stroke="#9CA3AF"
        strokeWidth="1.2"
        fill="none"
      />

      {/* ウィンドウ上部のトラフィックドット 3 つ */}
      <circle cx="14" cy="15" r="1" fill="#9CA3AF" />
      <circle cx="17.5" cy="15" r="1" fill="#9CA3AF" />
      <circle cx="21" cy="15" r="1" fill="#9CA3AF" />

      {/* マップグラフのエッジ(線を先に描いてノードの後ろに置く) */}
      <line x1="22" y1="40" x2="32" y2="32" stroke="#9CA3AF" strokeWidth="1.2" />
      <line x1="32" y1="32" x2="44" y2="38" stroke="#9CA3AF" strokeWidth="1.2" />
      <line x1="22" y1="40" x2="32" y2="46" stroke="#9CA3AF" strokeWidth="1.2" />
      <line x1="32" y1="46" x2="44" y2="38" stroke="#9CA3AF" strokeWidth="1.2" />

      {/* ノード: 3 個 Teal フィル + 1 個アウトライン */}
      <circle cx="22" cy="40" r="2.8" fill="#14B8A6" />
      <circle
        cx="32"
        cy="32"
        r="2.4"
        fill="#111827"
        stroke="#9CA3AF"
        strokeWidth="1.2"
      />
      <circle cx="44" cy="38" r="2.8" fill="#14B8A6" />
      <circle cx="32" cy="46" r="2.8" fill="#14B8A6" />
    </svg>
  );
}

export default LogoMark;
