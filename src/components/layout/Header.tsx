import LogoMark from "../ui/LogoMark";
import { t, type Language } from "../../lib/i18n";
import type { DetailLevel } from "../../lib/storage";

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
  /** v0.1.7: 詳細レベル(簡素 / 標準 / 詳細)。 */
  detailLevel: DetailLevel;
  onDetailLevelChange: (next: DetailLevel) => void;
  /** v0.1.7: 設定モーダル(AI エンジン切替など)を開く。 */
  onOpenSettings: () => void;
};

function Header({
  noCodeMode,
  onNoCodeModeChange,
  language,
  onLanguageChange,
  detailLevel,
  onDetailLevelChange,
  onOpenSettings,
}: HeaderProps) {
  const T = t(language);
  const detailOptions: { key: DetailLevel; label: string }[] = [
    { key: "simple", label: T.header.detailLevelSimple },
    { key: "detailed", label: T.header.detailLevelDetailed },
  ];
  return (
    <header className="h-16 bg-slate/75 backdrop-blur-md border-b border-electric-teal/10 flex-shrink-0 relative z-30">
      {/* v0.1.7 デザイン刷新:下端の細い teal アクセント線 */}
      <div
        className="absolute bottom-0 left-0 right-0 h-px pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(20,184,166,0.35) 50%, transparent 100%)",
        }}
      />
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

          {/* v0.1.7: 詳細レベル切替(簡素 / 標準 / 詳細)*/}
          <div
            role="group"
            aria-label={T.header.detailLevelAriaLabel}
            className="flex items-center bg-charcoal rounded-full p-0.5"
          >
            {detailOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => onDetailLevelChange(opt.key)}
                aria-pressed={detailLevel === opt.key}
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                  detailLevel === opt.key
                    ? "bg-electric-teal text-charcoal"
                    : "text-soft-grid hover:text-off-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
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

          {/* v0.1.7: 設定(AI エンジン切替など)*/}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t(language).localLLM.settingsButtonAria}
            className="w-8 h-8 flex items-center justify-center rounded-[8px] text-soft-grid hover:bg-charcoal hover:text-off-white transition-colors cursor-pointer"
          >
            {/* インライン SVG 歯車アイコン */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
