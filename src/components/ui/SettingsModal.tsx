import { useEffect } from "react";
import { t, type Language } from "../../lib/i18n";
import type { Engine } from "../../lib/storage";

/**
 * v0.1.7 設定モーダル(現状は AI エンジン切替のみ)。
 *
 * Header の歯車アイコンから開く。Escape / 背景クリックで閉じる。
 * AI エンジン:Claude(クラウド)/ ローカル LLM(オフライン)の 2 択。
 *   - 選択は即座に親に伝わる(`onEngineChange` callback)→ localStorage 永続化は親側
 *   - エンジン変更時、もし対応する Setup が未完なら親側で適切なウィザードを表示する設計
 */
type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  engine: Engine;
  onEngineChange: (next: Engine) => void;
  language: Language;
};

function SettingsModal({
  open,
  onClose,
  engine,
  onEngineChange,
  language,
}: SettingsModalProps) {
  const T = t(language).localLLM;

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const options: {
    key: Engine;
    label: string;
    note: string;
  }[] = [
    {
      key: "claude",
      label: T.engineClaude,
      note: T.engineClaudeNote,
    },
    {
      key: "local",
      label: T.engineLocal,
      note: T.engineLocalNote,
    },
  ];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={T.settingsTitle}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(520px,92vw)] bg-slate rounded-[14px] border border-charcoal shadow-md flex flex-col overflow-hidden"
      >
        {/* ヘッダー */}
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-charcoal">
          <h2 className="text-base font-semibold text-off-white">
            {T.settingsTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="w-8 h-8 flex items-center justify-center rounded-[8px] text-soft-grid hover:bg-charcoal transition-colors text-xl leading-none"
          >
            ×
          </button>
        </header>

        {/* 本体 */}
        <div className="px-5 py-4 space-y-4">
          <section>
            <h3 className="text-xs font-medium text-soft-grid uppercase tracking-wide mb-3">
              {T.engineLabel}
            </h3>
            <div className="space-y-2">
              {options.map((opt) => {
                const active = engine === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => onEngineChange(opt.key)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-[8px] px-4 py-3 transition-colors cursor-pointer border ${
                      active
                        ? "bg-electric-teal/10 border-electric-teal"
                        : "bg-charcoal/40 border-charcoal hover:bg-charcoal/70"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-3 h-3 rounded-full flex-shrink-0 border-2 ${
                          active
                            ? "border-electric-teal bg-electric-teal"
                            : "border-soft-grid bg-transparent"
                        }`}
                        aria-hidden="true"
                      />
                      <span
                        className={`text-sm font-semibold ${
                          active ? "text-electric-teal" : "text-off-white"
                        }`}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <div className="text-xs text-soft-grid mt-1 ml-5 leading-relaxed">
                      {opt.note}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
