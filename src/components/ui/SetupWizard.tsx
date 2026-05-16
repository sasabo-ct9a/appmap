import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  installClaudeCode,
  runClaudeLogin,
} from "../../lib/claudeCli";
import Button from "./Button";
import Spinner from "./Spinner";

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
};

function SetupWizard({
  nodeVersion,
  claudeVersion,
  loginCompletedAt,
  onRefresh,
  onLoginCompleted,
}: SetupWizardProps) {
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
  // 日本語メッセージ + 行動指示 を出す。stderr/stdout の生表示だけだと、
  // 非エンジニアには判定不能。
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
      return {
        kind: "eacces",
        hint: "Mac の権限で書き込めません。下のコマンドをターミナルで実行してください。",
      };
    }
    if (/enotfound|getaddrinfo|enetunreach|econnreset|etimedout|network/.test(lower)) {
      return {
        kind: "network",
        hint: "ネットワークに繋がっていません。Wi-Fi / 有線 / VPN を確認して、もう一度試してください。",
      };
    }
    if (/proxy|tunnel|407|http_proxy|https_proxy/.test(lower)) {
      return {
        kind: "proxy",
        hint: "Proxy 経由のネットワークでブロックされています。会社・学校ならネット管理者に確認するか、`npm config set proxy <url>` を試してください。",
      };
    }
    if (/unsupported engine|not satisfied|node\s*>?=|node version/.test(lower)) {
      return {
        kind: "engine",
        hint: "Node.js のバージョンが合いません。nodejs.org から最新の LTS を入れ直してください。",
      };
    }
    if (/e401|e403|registry|unauthorized|forbidden/.test(lower)) {
      return {
        kind: "registry",
        hint: "npm レジストリの認証で弾かれました。`npm logout` のあと再試行するか、private registry 設定を確認してください。",
      };
    }
    return {
      kind: "generic",
      hint: "想定外のエラーです。下のメッセージをコピーして作者に共有してください。",
    };
  };

  const errorCategory =
    installError !== null ? classifyInstallError(installError) : null;
  const isEacces = errorCategory?.kind === "eacces";

  return (
    <div className="bg-slate border border-charcoal rounded-[14px] p-5 mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-semibold text-off-white">
          AppMap を使う準備
        </h2>
        <span className="text-xs text-soft-grid">
          {completedCount} / 3 完了
        </span>
      </div>

      <div className="space-y-3">
        {/* Step 1: Node.js */}
        <Step
          number={1}
          title="Node.js"
          description="AppMap が裏で使うプログラムの土台です"
          done={nodeOk}
          doneDetail={nodeVersion ?? ""}
          action={
            nodeOk ? null : (
              <Button variant="secondary" onClick={handleOpenNodejs}>
                Node.js を入手
              </Button>
            )
          }
          hint={nodeOk ? null : "ボタンを押すと nodejs.org が開きます。LTS をインストールしたら、AppMap をいったん閉じて再起動してください。"}
        />

        {/* Step 2: Claude Code CLI */}
        <Step
          number={2}
          title="Claude Code CLI"
          description="AppMap と Claude を繋ぐツール"
          done={claudeOk}
          doneDetail={claudeVersion ?? ""}
          running={installing}
          action={
            claudeOk ? null : (
              <Button
                onClick={handleInstall}
                disabled={!nodeOk || installing}
              >
                {installing ? "インストール中…" : "インストール"}
              </Button>
            )
          }
          hint={
            !nodeOk
              ? "(先に Node.js を入れてください)"
              : claudeOk
                ? null
                : "30 秒〜数分かかります。"
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
              ⚠ インストールは完了しましたが、AppMap からまだ Claude Code が見えません
            </div>
            <div className="text-soft-grid leading-relaxed">
              npm のグローバルパス反映に時間がかかっていることがあります。
              下記のいずれかを試してください:
            </div>
            <ul className="text-soft-grid leading-relaxed list-disc ml-4 space-y-1">
              <li>AppMap をいったん閉じて再起動</li>
              <li>
                ターミナルで <code className="bg-slate px-1 rounded">claude --version</code>{" "}
                が動くか確認(動かなければ別シェルを開いて再試行)
              </li>
              <li>
                <code className="bg-slate px-1 rounded">npm config get prefix</code>{" "}
                の出力が PATH に含まれているか確認
              </li>
            </ul>
          </div>
        )}

        {/* Mac EACCES hint(sudo 案内、コピー可) */}
        {isEacces && (
          <div className="ml-9 bg-charcoal rounded-[8px] p-3 text-xs space-y-2">
            <div className="text-alert-red font-semibold">
              ⚠ 権限エラー(Mac)
            </div>
            <div className="text-soft-grid leading-relaxed">
              Mac の権限の都合で、自動インストールに失敗しました。
              <br />
              ターミナルを開いて、以下を <strong>コピペして</strong> 実行してください
              (途中で Mac のパスワードを聞かれます):
            </div>
            <code className="block bg-slate p-2 rounded-[4px] text-off-white font-mono select-text text-xs">
              sudo npm install -g @anthropic-ai/claude-code
            </code>
            <div className="text-soft-grid text-xs">
              完了したら AppMap を再起動してください。
            </div>
          </div>
        )}

        {/* Step 3: Claude ログイン */}
        <Step
          number={3}
          title="Claude にログイン"
          description="ブラウザで Claude Pro / Max アカウントを認証"
          done={authOk}
          doneDetail="ログイン済み"
          running={loggingIn}
          action={
            authOk ? null : (
              <Button
                onClick={handleLogin}
                disabled={!claudeOk || loggingIn}
              >
                {loggingIn ? "ブラウザで認証中…" : "ログイン"}
              </Button>
            )
          }
          hint={
            !claudeOk
              ? "(先に Claude Code CLI を入れてください)"
              : authOk
                ? null
                : "ボタンを押すとブラウザが開きます。Anthropic のログイン画面で Claude Pro / Max アカウントを認証してください。"
          }
          error={loginError}
        />
      </div>

      {nodeOk && claudeOk && !authOk && (
        <div className="mt-4 text-xs text-soft-grid">
          ここまで完了したら、「フォルダを選ぶ」が使えるようになります。
        </div>
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
  /**
   * エラー本文(生 stderr / message)。アクセシビリティのため role="alert"。
   * Low #3 対応:role="alert" + aria-live で支援技術にも届く。
   */
  error?: string | null;
  /**
   * Low #2 対応:エラー分類で得た人間向け短いメッセージ。生 error は折りたたみで
   * 別途見せて、上には親切な日本語を出す。
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
          <span className="text-electric-teal" aria-label="完了">
            ✓
          </span>
        ) : running ? (
          <Spinner className="w-4 h-4 text-electric-teal" />
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
            {/* 日本語の親切メッセージ(Low #2) */}
            {errorHint && (
              <div className="bg-alert-red/15 rounded-[8px] p-2 text-xs text-off-white leading-relaxed">
                {errorHint}
              </div>
            )}
            {/* 生のエラー(コピー用) */}
            <details className="bg-charcoal rounded-[8px] p-2 text-xs">
              <summary className="text-soft-grid cursor-pointer select-none">
                詳細ログ(コピー可)
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
