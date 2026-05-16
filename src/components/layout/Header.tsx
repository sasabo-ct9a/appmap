import LogoMark from "../ui/LogoMark";

/**
 * グローバルヘッダー(Phase 2 完成版、DARK モード)。
 *
 * - 左: ロゴマーク + 「AppMap」テキスト
 * - 右: ノーコード語切替トグル(Step 5 で実機能化)
 *
 * 高さ 64px、bg Slate、下に Charcoal の仕切り線。
 *
 * トグルの視覚仕様(§10.5.6 + §10.2 DARK):
 *   - トラック: OFF=Charcoal / ON=Electric Teal、`rounded-full`
 *   - ハンドル: Soft Grid の小円、left-0.5(OFF) ↔ left-[18px](ON)を遷移
 *   - `<button role="switch" aria-checked>` で a11y 対応
 *
 * Toggle は Header 内インラインで実装(再利用兆候が出たら ui/Toggle.tsx
 * に切り出す。Phase 2 ではここだけで使うので KISS、§7 準拠)。
 */
type HeaderProps = {
  noCodeMode: boolean;
  onNoCodeModeChange: (next: boolean) => void;
};

function Header({ noCodeMode, onNoCodeModeChange }: HeaderProps) {
  return (
    <header className="h-16 bg-slate border-b border-charcoal flex-shrink-0">
      <div className="mx-auto max-w-7xl h-full px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LogoMark className="w-7 h-7" />
          <span className="text-base font-semibold tracking-tight text-off-white">
            AppMap
          </span>
        </div>

        {/* ノーコード語切替トグル */}
        <button
          type="button"
          role="switch"
          aria-checked={noCodeMode}
          aria-label="ノーコード語切替"
          onClick={() => onNoCodeModeChange(!noCodeMode)}
          className="flex items-center gap-2 cursor-pointer"
        >
          <span className="text-xs text-soft-grid">ノーコード語</span>
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
    </header>
  );
}

export default Header;
