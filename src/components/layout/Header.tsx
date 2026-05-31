import LogoMark from "../ui/LogoMark";
import { t, type Language } from "../../lib/i18n";

/**
 * グローバルヘッダー(Phase 2 完成版、DARK モード)。
 *
 * - 左: ロゴマーク + 「AppMap」テキスト
 * - 右: [JA / EN 言語トグル] + [ノーコード語切替トグル] の 2 つを横並び
 *
 * v0.1.6 追加: 英日切替トグル(ノーコード語の左)。
 *   - 視覚:segmented pill(JA | EN)、アクティブ側が bg-electric-teal で塗り
 *   - aria: role=group + 子の button に aria-pressed
 *   - 言語トグルは ON/OFF のスイッチ型ではなく「2 つの選択肢を等価に並べる」型のほうが
 *     どちらが現在の言語か瞬時に読める(ノーコード語トグルとは設計意図が違う)
 *
 * 高さ 64px、bg Slate、下に Charcoal の仕切り線。
 *
 * ノーコード語トグルの視覚仕様(§10.5.6 + §10.2 DARK):
 *   - トラック: OFF=Charcoal / ON=Electric Teal、`rounded-full`
 *   - ハンドル: Soft Grid の小円、left-0.5(OFF) ↔ left-[18px](ON)を遷移
 *   - `<button role="switch" aria-checked>` で a11y 対応
 */
type HeaderProps = {
  noCodeMode: boolean;
  onNoCodeModeChange: (next: boolean) => void;
  language: Language;
  onLanguageChange: (next: Language) => void;
};

function Header({
  noCodeMode,
  onNoCodeModeChange,
  language,
  onLanguageChange,
}: HeaderProps) {
  const T = t(language);
  return (
    <header className="h-16 bg-slate border-b border-charcoal flex-shrink-0">
      <div className="mx-auto max-w-7xl h-full px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LogoMark className="w-7 h-7" />
          <span className="text-base font-semibold tracking-tight text-off-white">
            AppMap
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* v0.1.6: 言語切替(JA / EN)。ノーコード語の左に配置(指定通り) */}
          <div
            role="group"
            aria-label={T.header.languageAriaLabel}
            className="flex items-center bg-charcoal rounded-full p-0.5"
          >
            <button
              type="button"
              onClick={() => onLanguageChange("ja")}
              aria-pressed={language === "ja"}
              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                language === "ja"
                  ? "bg-electric-teal text-charcoal"
                  : "text-soft-grid hover:text-off-white"
              }`}
            >
              JA
            </button>
            <button
              type="button"
              onClick={() => onLanguageChange("en")}
              aria-pressed={language === "en"}
              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                language === "en"
                  ? "bg-electric-teal text-charcoal"
                  : "text-soft-grid hover:text-off-white"
              }`}
            >
              EN
            </button>
          </div>

          {/* ノーコード語切替トグル */}
          <button
            type="button"
            role="switch"
            aria-checked={noCodeMode}
            aria-label={T.header.noCodeAriaLabel}
            onClick={() => onNoCodeModeChange(!noCodeMode)}
            className="flex items-center gap-2 cursor-pointer"
          >
            <span className="text-xs text-soft-grid">
              {T.header.noCodeLabel}
            </span>
            <span
              className={`w-10 h-6 rounded-full relative transition-colors ${
                noCodeMode ? "bg-electric-teal" : "bg-charcoal"
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-soft-grid transition-all ${
                  noCodeMode ? "left-[18px]" : "left-0.5"
                }`}
              />
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
