import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  installClaudeCode,
  runClaudeLogin,
} from "../../lib/claudeCli";
import Button from "./Button";
import Spinner from "./Spinner";
import { t, type Language } from "../../lib/i18n";

/**
 * アプリ内ガイド付きセットアップウィザード(機能拡張 Option A)。
 *
 * 目的:
 *   ターミナル恐怖症の非エンジニアでも、AppMap を入れたあと数クリックで
 *   Node.js → Claude Code CLI → Claude ログイン まで到達できるようにする。
 *
 * ステップ:
 *   1. Node.js   — 入っていなければ [Node.js を入手] で nodejs.org を開く
 *   2. Claude Code CLI — [インストール] ボタンで内部で `npm install -g` 実行
 *   3. Claude ログイン — [ログイン] ボタンで claude login → ブラウザ OAuth
 *
 * Mac で npm install が EACCES(権限エラー)で失敗した場合は、コピペ用の
 * `sudo npm install -g ...` コマンドを別ブロックで提示する(エラーメッセージから
 * 自動判定)。
 *
 * 全部済んだら null を返してウィザードは消える。状態は親(App.tsx)が
 * onRefresh で再チェックして反映する。
 *
 * v0.1.6: 全文言を i18n 化(language prop)。Mac の権限エラーガイダンスや
 * PATH 反映ラグの説明、エラー分類の親切メッセージも JA / EN で切替。
 */
type SetupWizardProps = {
  /** Node.js version 文字列。null なら未インストール。 */
  nodeVersion: string | null;
  /** Claude Code CLI version 文字列。null なら未インストール。 */
  claudeVersion: string | null;
  /** `claude login` 完走済みのタイムスタンプ。null ならまだ。 */
  loginCompletedAt: number | null;
  /** Node / Claude Code の状態を再チェックする(install 後に呼ばれる)。 */
  onRefresh: () => Promise<void>;
  /** Login 完了を親に通知(storage への永続化用)。 */
  onLoginCompleted: () => void;
  /** v0.1.6: UI 言語。 */
  language: Language;
};

function SetupWizard({
  nodeVersion,
  claudeVersion,
  loginCompletedAt,
  onRefresh,
  onLoginCompleted,
  language,
}: SetupWizardProps) {
  const T = t(language);
  const W = T.setupWizard;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  // Codex review Med #2:install は成功したが PATH 反映ラグや npm prefix 差異で
  // claudeVersion が見つからないケースがある。install を一度試した事実を保持し、
  // 親から流れてくる claudeVersion が依然 null なら「再起動してください」を案内する。
  const [installAttempted, setInstallAttempted] = useState(false);

  const nodeOk = nodeVersion !== null;
  const claudeOk = claudeVersion !== null;
  const authOk = loginCompletedAt !== null;
  // 全部済んでいるならウィザードを描画しない(App 側で null チェック)
  if (nodeOk && claudeOk && authOk) return null;

  const completedCount = [nodeOk, claudeOk, authOk].filter(Boolean).length;

  const handleOpenNodejs = async () => {
    try {
      await openUrl("https://nodejs.org/");
    } catch (err) {
      console.warn("Failed to open nodejs.org:", err);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await installClaudeCode();
      setInstallAttempted(true);
      await onRefresh();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  // install を試した直後、refresh しても claudeVersion がまだ null → PATH 反映ラグ
  const showPathLagHint =
    installAttempted && claudeVersion === null && !installing && !installError;

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await runClaudeLogin();
      onLoginCompleted();
      await onRefresh();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoggingIn(false);
    }
  };

  // Codex review Low #2:npm install のエラーを分類して、ユーザーに短い
  // メッセージ + 行動指示 を出す。stderr/stdout の生表示だけだと非エンジニアには判定不能。
  type ErrorCategory =
    | { kind: "eacces"; hint: string }
    | { kind: "network"; hint: string }
    | { kind: "proxy"; hint: string }
    | { kind: "engine"; hint: string }
    | { kind: "registry"; hint: string }
    | { kind: "generic"; hint: string };

  const classifyInstallError = (msg: string): ErrorCategory => {
    const lower = msg.toLowerCase();
    if (/eacces|permission denied/.test(lower)) {
      return { kind: "eacces", hint: W.errorEacces };
    }
    if (/enotfound|getaddrinfo|enetunreach|econnreset|etimedout|network/.test(lower)) {
      return { kind: "network", hint: W.errorNetwork };
    }
    if (/proxy|tunnel|407|http_proxy|https_proxy/.test(lower)) {
      return { kind: "proxy", hint: W.errorProxy };
    }
    if (/unsupported engine|not satisfied|node\s*>?=|node version/.test(lower)) {
      return { kind: "engine", hint: W.errorEngine };
    }
    if (/e401|e403|registry|unauthorized|forbidden/.test(lower)) {
      return { kind: "registry", hint: W.errorRegistry };
    }
    return { kind: "generic", hint: W.errorGeneric };
  };

  const errorCategory =
    installError !== null ? classifyInstallError(installError) : null;
  const isEacces = errorCategory?.kind === "eacces";

  return (
    <div className="bg-slate border border-charcoal rounded-[14px] p-5 mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-semibold text-off-white">{W.title}</h2>
        <span className="text-xs text-soft-grid">
          {W.progress(completedCount)}
        </span>
      </div>

      <div className="space-y-3">
        {/* Step 1: Node.js */}
        <Step
          number={1}
          title={W.step1Title}
          description={W.step1Description}
          done={nodeOk}
          doneDetail={nodeVersion ?? ""}
          stepDoneLabel={W.stepDone}
          detailsLogSummary={W.detailsLogSummary}
          language={language}
          action={
            nodeOk ? null : (
              <Button variant="secondary" onClick={handleOpenNodejs}>
                {W.step1ActionLabel}
              </Button>
            )
          }
          hint={nodeOk ? null : W.step1Hint}
        />

        {/* Step 2: Claude Code CLI */}
        <Step
          number={2}
          title={W.step2Title}
          description={W.step2Description}
          done={claudeOk}
          doneDetail={claudeVersion ?? ""}
          running={installing}
          stepDoneLabel={W.stepDone}
          detailsLogSummary={W.detailsLogSummary}
          language={language}
          action={
            claudeOk ? null : (
              <Button
                onClick={handleInstall}
                disabled={!nodeOk || installing}
              >
                {installing ? W.step2InstallingLabel : W.step2InstallLabel}
              </Button>
            )
          }
          hint={
            !nodeOk
              ? W.step2HintNeedNode
              : claudeOk
                ? null
                : W.step2HintTime
          }
          error={installError && !isEacces ? installError : null}
          errorHint={
            installError && !isEacces && errorCategory
              ? errorCategory.hint
              : null
          }
        />

        {/* PATH 反映ラグ:install 完走したのに AppMap から claude が見えない */}
        {showPathLagHint && (
          <div className="ml-9 bg-charcoal rounded-[8px] p-3 text-xs space-y-2">
            <div className="text-muted-amber font-semibold">
              {W.pathLagHeader}
            </div>
            <div className="text-soft-grid leading-relaxed">
              {W.pathLagIntro}
            </div>
            <ul className="text-soft-grid leading-relaxed list-disc ml-4 space-y-1">
              <li>{W.pathLagBullet1}</li>
              <li>
                {W.pathLagBullet2Prefix}
                <code className="bg-slate px-1 rounded">claude --version</code>
                {W.pathLagBullet2Suffix}
              </li>
              <li>
                {W.pathLagBullet3Prefix}
                <code className="bg-slate px-1 rounded">npm config get prefix</code>
                {W.pathLagBullet3Suffix}
              </li>
            </ul>
          </div>
        )}

        {/* Mac EACCES hint(sudo 案内、コピー可) */}
        {isEacces && (
          <div className="ml-9 bg-charcoal rounded-[8px] p-3 text-xs space-y-2">
            <div className="text-alert-red font-semibold">
              {W.eaccesHeader}
            </div>
            <div className="text-soft-grid leading-relaxed">
              {W.eaccesBody}{" "}
              <strong>{W.eaccesPasteHint}</strong>
            </div>
            <code className="block bg-slate p-2 rounded-[4px] text-off-white font-mono select-text text-xs">
              sudo npm install -g @anthropic-ai/claude-code
            </code>
            <div className="text-soft-grid text-xs">{W.eaccesFooter}</div>
          </div>
        )}

        {/* Step 3: Claude ログイン */}
        <Step
          number={3}
          title={W.step3Title}
          description={W.step3Description}
          done={authOk}
          doneDetail={W.step3DoneDetail}
          running={loggingIn}
          stepDoneLabel={W.stepDone}
          detailsLogSummary={W.detailsLogSummary}
          language={language}
          action={
            authOk ? null : (
              <Button
                onClick={handleLogin}
                disabled={!claudeOk || loggingIn}
              >
                {loggingIn ? W.step3LoggingInLabel : W.step3LoginLabel}
              </Button>
            )
          }
          hint={
            !claudeOk
              ? W.step3HintNeedClaude
              : authOk
                ? null
                : W.step3HintReady
          }
          error={loginError}
        />
      </div>

      {nodeOk && claudeOk && !authOk && (
        <div className="mt-4 text-xs text-soft-grid">{W.finalHint}</div>
      )}
    </div>
  );
}

type StepProps = {
  number: number;
  title: string;
  description: string;
  done: boolean;
  doneDetail: string;
  running?: boolean;
  action: React.ReactNode;
  hint: string | null;
  /** v0.1.6: 「完了」相当の aria-label を i18n から流す。 */
  stepDoneLabel: string;
  /** v0.1.6: <details> サマリー文言を i18n から流す。 */
  detailsLogSummary: string;
  /** v0.1.6: Spinner の aria-label を切替えるための言語。 */
  language: Language;
  /**
   * エラー本文(生 stderr / message)。アクセシビリティのため role="alert"。
   * Low #3 対応:role="alert" + aria-live で支援技術にも届く。
   */
  error?: string | null;
  /**
   * Low #2 対応:エラー分類で得た人間向け短いメッセージ。生 error は折りたたみで
   * 別途見せて、上には親切なメッセージを出す。
   */
  errorHint?: string | null;
};

function Step({
  number,
  title,
  description,
  done,
  doneDetail,
  running,
  action,
  hint,
  stepDoneLabel,
  detailsLogSummary,
  language,
  error,
  errorHint,
}: StepProps) {
  return (
    <div
      className="flex items-start gap-3"
      // Low #3:進行中ステップに aria-busy を付与
      aria-busy={running ? "true" : undefined}
    >
      {/* ステータスアイコン */}
      <div className="flex-shrink-0 w-6 h-6 mt-0.5 flex items-center justify-center text-sm">
        {done ? (
          <span className="text-electric-teal" aria-label={stepDoneLabel}>
            ✓
          </span>
        ) : running ? (
          <Spinner className="w-4 h-4 text-electric-teal" language={language} />
        ) : (
          <span className="text-soft-grid">{number}</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-off-white">{title}</span>
          {done && (
            <span className="text-xs font-mono text-electric-teal">
              {doneDetail}
            </span>
          )}
        </div>
        <div className="text-xs text-soft-grid mt-0.5">{description}</div>
        {hint && (
          <div className="text-xs text-soft-grid mt-1 opacity-75">{hint}</div>
        )}
        {error && (
          <div
            className="mt-2 space-y-2"
            role="alert"
            aria-live="polite"
          >
            {/* 親切メッセージ(Low #2) */}
            {errorHint && (
              <div className="bg-alert-red/15 rounded-[8px] p-2 text-xs text-off-white leading-relaxed">
                {errorHint}
              </div>
            )}
            {/* 生のエラー(コピー用) */}
            <details className="bg-charcoal rounded-[8px] p-2 text-xs">
              <summary className="text-soft-grid cursor-pointer select-none">
                {detailsLogSummary}
              </summary>
              <pre className="text-alert-red font-mono whitespace-pre-wrap select-text mt-2 leading-relaxed">
                {error}
              </pre>
            </details>
          </div>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

export default SetupWizard;
