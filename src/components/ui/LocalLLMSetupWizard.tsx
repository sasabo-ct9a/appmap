import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  checkLlamaBinary,
  checkLlamaModel,
  downloadLlamaModel,
  getLlamaModelPath,
} from "../../lib/llamaClient";
import Button from "./Button";
import Spinner from "./Spinner";
import { t, type Language } from "../../lib/i18n";

/**
 * v0.1.7 ローカル LLM セットアップウィザード(engine="local" 時に SetupWizard の代わりに表示)。
 *
 * 2 ステップ:
 *   1. **llama-server バイナリ確認**(Phase 1 は手動配置を案内)
 *   2. **モデル DL**(Qwen 2.5-Coder 7B Q4、~4.5 GB)— 進捗バー
 *
 * 両方完了で null を返す → 親が「フォルダを選ぶ」を有効化する。
 * Phase 2 で binary も同梱化されたら、Step 1 は自動チェック → 透過になる。
 */
type LocalLLMSetupWizardProps = {
  language: Language;
  /** Wizard 内の状態が変わったら親(App.tsx)に通知して再描画させる用。 */
  onChange: () => void;
};

function LocalLLMSetupWizard({ language, onChange }: LocalLLMSetupWizardProps) {
  const T = t(language);
  const W = T.localLLM;

  const [binaryVersion, setBinaryVersion] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState<boolean>(false);
  const [modelDir, setModelDir] = useState<string>("");
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [checkingBinary, setCheckingBinary] = useState<boolean>(false);

  // 初回マウントでバイナリ + モデル状態をチェック
  useEffect(() => {
    void refreshAll();
  }, []);

  const refreshAll = async () => {
    setCheckingBinary(true);
    const [ver, hasModel, dir] = await Promise.all([
      checkLlamaBinary(),
      checkLlamaModel(),
      getLlamaModelPath().catch(() => ""),
    ]);
    setBinaryVersion(ver);
    setModelReady(hasModel);
    setModelDir(dir);
    setCheckingBinary(false);
    onChange();
  };

  const handleRecheck = async () => {
    await refreshAll();
  };

  const handleOpenBinDir = async () => {
    // model dir の隣 (/bin/) を表示。なければ model dir を開く。
    if (!modelDir) return;
    // path には ファイル名がついてるので親ディレクトリの models フォルダを開き、その隣に bin を作るよう案内
    const parent = modelDir.replace(/[\\/][^\\/]+$/, "").replace(/[\\/]models$/, "");
    const binDir = parent ? `${parent}${navigator.platform.startsWith("Win") ? "\\bin" : "/bin"}` : modelDir;
    try {
      await openPath(binDir);
    } catch {
      // bin が無ければ親(AppMap data dir)を開く
      try {
        await openPath(parent || modelDir);
      } catch (err) {
        console.warn("openPath failed:", err);
      }
    }
  };

  const handleDownload = async () => {
    if (binaryVersion === null) return;
    setDownloading(true);
    setDownloadError(null);
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      await downloadLlamaModel((downloaded, total) => {
        setDownloadedBytes(downloaded);
        setTotalBytes(total);
      });
      await refreshAll();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const binaryOk = binaryVersion !== null;
  const modelOk = modelReady;

  // 全部済んでいたら描画しない
  if (binaryOk && modelOk) return null;

  const completedCount = [binaryOk, modelOk].filter(Boolean).length;
  const downloadedMB = Math.round(downloadedBytes / (1024 * 1024));
  const totalMB = totalBytes > 0 ? Math.round(totalBytes / (1024 * 1024)) : 0;

  return (
    <div className="bg-slate border border-charcoal rounded-[14px] p-5 mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-semibold text-off-white">{W.wizardTitle}</h2>
        <span className="text-xs text-soft-grid">
          {W.wizardProgress(completedCount)}
        </span>
      </div>

      <div className="space-y-3">
        {/* Step 1: llama-server バイナリ */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-6 h-6 mt-0.5 flex items-center justify-center text-sm">
            {binaryOk ? (
              <span className="text-electric-teal" aria-label={W.stepDone}>
                ✓
              </span>
            ) : checkingBinary ? (
              <Spinner className="w-4 h-4 text-electric-teal" language={language} />
            ) : (
              <span className="text-soft-grid">1</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-medium text-off-white">{W.step1Title}</span>
              {binaryOk && (
                <span className="text-xs font-mono text-electric-teal">
                  {binaryVersion?.split("\n")[0]?.slice(0, 40)}
                </span>
              )}
            </div>
            <div className="text-xs text-soft-grid mt-0.5">{W.step1Description}</div>
            {!binaryOk && (
              <>
                <div className="text-xs text-soft-grid mt-1 opacity-75">
                  {W.step1ManualHint}
                </div>
                {modelDir && (
                  <div className="mt-2 bg-charcoal rounded-[8px] p-2">
                    <div className="text-xs text-soft-grid mb-1">
                      {W.step1NotFound}:
                    </div>
                    <code className="block text-xs text-off-white font-mono select-text break-all">
                      {modelDir.replace(/[\\/]models[\\/].*$/, navigator.platform.startsWith("Win") ? "\\bin\\llama-server.exe" : "/bin/llama-server")}
                    </code>
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" onClick={handleOpenBinDir}>
                    {W.step1ShowPath}
                  </Button>
                  <Button variant="secondary" onClick={handleRecheck}>
                    {W.step1Recheck}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Step 2: モデル DL */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-6 h-6 mt-0.5 flex items-center justify-center text-sm">
            {modelOk ? (
              <span className="text-electric-teal" aria-label={W.stepDone}>
                ✓
              </span>
            ) : downloading ? (
              <Spinner className="w-4 h-4 text-electric-teal" language={language} />
            ) : (
              <span className="text-soft-grid">2</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-off-white">{W.step2Title}</div>
            <div className="text-xs text-soft-grid mt-0.5">{W.step2Description}</div>
            {!modelOk && (
              <>
                {downloading ? (
                  <>
                    <div className="text-xs text-soft-grid mt-2">
                      {W.step2Progress(downloadedMB, totalMB)}
                    </div>
                    {/* 進捗バー */}
                    <div className="w-full bg-charcoal rounded-full h-2 mt-1 overflow-hidden">
                      <div
                        className="bg-electric-teal h-full transition-all"
                        style={{
                          width:
                            totalBytes > 0
                              ? `${Math.min(100, (downloadedBytes / totalBytes) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {!binaryOk && (
                      <div className="text-xs text-soft-grid mt-1 opacity-75">
                        {W.step2NeedBinary}
                      </div>
                    )}
                    <div className="mt-2">
                      <Button
                        onClick={handleDownload}
                        disabled={!binaryOk}
                      >
                        {W.step2DownloadLabel}
                      </Button>
                    </div>
                  </>
                )}
                {downloadError && (
                  <div className="bg-alert-red/15 rounded-[8px] p-2 mt-2 text-xs text-off-white leading-relaxed select-text">
                    {W.errorDownloadFailed(downloadError)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {binaryOk && !modelOk && (
        <div className="mt-4 text-xs text-soft-grid">{W.finalHint}</div>
      )}
    </div>
  );
}

export default LocalLLMSetupWizard;
