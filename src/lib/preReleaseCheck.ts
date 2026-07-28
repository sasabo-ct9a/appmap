import { invoke } from "@tauri-apps/api/core";
import type { ScreenMapResult } from "./claudeCli";
import { type Language } from "./i18n";

/**
 * v0.1.8 リリース前チェックリスト。
 *
 * 3 系統の情報源:
 *   1. Rust の `pre_release_scan` コマンド:ファイル走査で秘密情報・TODO・console.log を検出
 *   2. screens(AI 分析結果)から:入口有無・risky 画面・changeHint 未取得ノード
 *   3. context(AI 抽出):テストフレームワーク・テスト有無
 *
 * 出力は severity 順 + カテゴリ横断で 1 リスト。ユーザーが上から潰していける形。
 * ノーコード経験者に向けて「何が危険か」と「どう直すか」を 1 行ずつ添える。
 */

// ────────────────────────────────────────────────────────────────
// Rust の scan 結果型(bindings)
// ────────────────────────────────────────────────────────────────
export type ScanHit = {
  file: string;
  line: number;
  snippet: string;
  kind: string;
};

export type PreReleaseScanResult = {
  secrets: ScanHit[];
  todos: ScanHit[];
  /** v0.1.10(Codex Medium #4):件数だけでなく file:line も返す。
   *  Cursor 修正時に「全体 grep で意図的な console.error まで消す」過剰修正を防ぐ。 */
  console_logs: ScanHit[];
  /** v0.1.10(Codex 二次指摘 Medium #4):truncate 前の総数。
   *  UI/AI prompt での「N 箇所」表示はこの total を使う(secrets/todos/console_logs
   *  はそれぞれ 20/50/50 で切られるため、length では過少報告になる)。 */
  secrets_total: number;
  todos_total: number;
  console_logs_total: number;
  files_scanned: number;
  files_truncated: boolean;
  /** v0.1.8:AI 分析より新しいテストフレームワーク検出結果(null = 未検出)*/
  detected_test_framework: string | null;
  /** テストファイル(*.test.*, *.spec.*, __tests__/)の存在 */
  has_test_files: boolean;
  /** v0.1.10(Codex Medium #5):.env / .env.local 等が存在するか */
  env_files_present: boolean;
  /** v0.1.10(Codex Medium #5):.gitignore が .env パターンを含むか */
  env_covered_by_gitignore: boolean;
};

export async function runCodeScan(
  folderPath: string,
): Promise<PreReleaseScanResult> {
  return await invoke<PreReleaseScanResult>("pre_release_scan", {
    folder: folderPath,
  });
}

// ────────────────────────────────────────────────────────────────
// 統合フィンディング型
// ────────────────────────────────────────────────────────────────
export type Severity = "high" | "medium" | "low";
export type Category =
  | "secrets"
  | "testing"
  | "dev-leftovers";

export type Finding = {
  id: string;
  severity: Severity;
  category: Category;
  /** タイトル(1 行、動詞または名詞句)*/
  title: string;
  /** なぜ危険か + 概略(ノーコード語で 1〜2 文)*/
  hint: string;
  /** 具体的な改善ステップ(番号リストで見せる、3〜6 個推奨)*/
  fixSteps: string[];
  /** ヒットしたファイル・行番号・スニペット(任意、あれば折り畳みで見せる)*/
  examples?: { file: string; line?: number; snippet?: string }[];
  /** ヒット総数(examples を切詰めていても総数は保持)*/
  count?: number;
};

// ────────────────────────────────────────────────────────────────
// 統合チェック関数
// ────────────────────────────────────────────────────────────────
export type CheckInputs = {
  screens: ScreenMapResult;
  scan: PreReleaseScanResult | null; // scan は失敗 or サンプル時 null
  language: Language;
};

// ────────────────────────────────────────────────────────────────
// 全体評価(スコア + 判定)
// ────────────────────────────────────────────────────────────────
export type Verdict = "ready" | "caution" | "block";

export type OverallAssessment = {
  verdict: Verdict;
  /** 判定短ラベル(色付きバッジ用)*/
  label: string;
  /** 判定サマリー文(1〜2 文、なぜその判定になったか)*/
  summary: string;
  /** 優先アクション(重大度順に最大 3 件のタイトル抜粋)*/
  priorityTitles: string[];
};
// v0.1.8:calcScore(100 減点式)は撤去。数字の権威性がユーザーに
//         「品質保証」と誤読される害の方が実利用より大きかった。
//         verdict(block/caution/ready)+ 件数だけで意思決定させる。

function calcVerdict(findings: Finding[]): Verdict {
  const highs = findings.filter((f) => f.severity === "high").length;
  const meds = findings.filter((f) => f.severity === "medium").length;
  if (highs > 0) return "block";
  if (meds > 0) return "caution";
  return "ready"; // low だけ / 何もなし
}

/**
 * v0.1.8:findings + 全体評価 + プロジェクト context を統合して、
 * Cursor / Claude Code / Copilot 等の AI コーディングアシスタントに
 * そのまま貼れる形の依頼プロンプトを組み立てる。
 *
 * 設計:
 *   - Markdown。番号付きセクションで AI が段階的に処理できる形
 *   - 各項目に「なぜ」「どう直すか」「該当箇所」を含める(自己完結)
 *   - AI に「1 つずつ順に対応・完了報告」を求める
 *   - 秘密情報の該当箇所は伏せ字済み(scan 側で処理済み)
 */
export function buildAIFixPrompt({
  findings,
  screens,
  assessment,
  language,
}: {
  findings: Finding[];
  screens: ScreenMapResult;
  assessment: OverallAssessment;
  language: Language;
}): string {
  const isJa = language === "ja";
  const lines: string[] = [];

  // ── 冒頭:目的
  lines.push(
    isJa
      ? "このプロジェクトの本番リリース準備を進めたい。以下の問題を優先度順に解決してください。"
      : "I want to make this project production-ready. Please resolve the following issues in priority order.",
  );
  lines.push("");

  // ── 現状評価(v0.1.8:スコア数値は削除。AI に「65/100」と伝えても意味が無く、
  //     受け手の AI が根拠のある数値と誤解して修正提案の重み付けを誤る恐れがある)
  lines.push(isJa ? "## 現状評価" : "## Current assessment");
  lines.push(
    `- ${isJa ? "判定" : "Verdict"}: **${assessment.label}**`,
  );
  lines.push(`- ${assessment.summary}`);
  lines.push("");

  // ── プロジェクト情報(あれば)
  const ctx = screens.context;
  if (ctx?.techStack) {
    lines.push(isJa ? "## プロジェクト情報" : "## Project stack");
    if (ctx.techStack.frontend) lines.push(`- ${isJa ? "フロントエンド" : "Frontend"}: ${ctx.techStack.frontend}`);
    if (ctx.techStack.backend) lines.push(`- ${isJa ? "バックエンド" : "Backend"}: ${ctx.techStack.backend}`);
    if (ctx.techStack.db) lines.push(`- ${isJa ? "データベース" : "Database"}: ${ctx.techStack.db}`);
    if (ctx.techStack.external && ctx.techStack.external.length > 0) {
      lines.push(`- ${isJa ? "外部サービス" : "External services"}: ${ctx.techStack.external.join(", ")}`);
    }
    if (ctx.testing?.framework) {
      lines.push(`- ${isJa ? "テストフレームワーク" : "Test framework"}: ${ctx.testing.framework}`);
    }
    lines.push("");
  }

  // v0.1.10 スリム化後:findings は全てコード変更可能な項目のみ(risky-screens 等の
  // 「手動確認」項目は buildFindings 段階で除外済み)。単純に列挙する。
  lines.push(
    isJa
      ? "## 対応してほしい問題(優先度順)"
      : "## Issues to fix (priority order)",
  );
  lines.push("");
  findings.forEach((f, i) => {
    const num = i + 1;
    const sevLabel = f.severity.toUpperCase();
    lines.push(`### ${num}. [${sevLabel}] ${f.title}`);
    lines.push("");
    lines.push(
      isJa ? `**なぜ問題か:** ${f.hint}` : `**Why it's a problem:** ${f.hint}`,
    );
    lines.push("");
    if (f.fixSteps && f.fixSteps.length > 0) {
      lines.push(isJa ? "**対応手順:**" : "**Steps to fix:**");
      f.fixSteps.forEach((step, si) => {
        lines.push(`${si + 1}. ${step}`);
      });
      lines.push("");
    }
    if (f.examples && f.examples.length > 0) {
      lines.push(isJa ? "**該当箇所:**" : "**Locations:**");
      f.examples.slice(0, 10).forEach((ex) => {
        const loc = ex.line !== undefined ? `${ex.file}:${ex.line}` : ex.file;
        lines.push(`- \`${loc}\`${ex.snippet ? ` — ${ex.snippet.trim()}` : ""}`);
      });
      if (f.count !== undefined && f.examples.length < f.count) {
        lines.push(
          isJa
            ? `- ... 他 ${f.count - f.examples.length} 箇所`
            : `- ... and ${f.count - f.examples.length} more`,
        );
      }
      lines.push("");
    }
  });

  // ── 進め方の指示(AI に守ってほしいルール)
  lines.push(isJa ? "## 進め方" : "## How to proceed");
  if (isJa) {
    lines.push("- 1 問題ずつ、上から順に対応してください");
    lines.push("- 各対応の後、何を変更したかを 1〜2 行で報告してください");
    lines.push("- 判断に迷う場合は作業を止め、選択肢を提示して私に聞いてください");
    lines.push("- 秘密情報は伏字にしてあります。実際の値は私が入力するので、コード側では `process.env.XXX` のように環境変数から読む形に置き換えてください");
    lines.push("- 全対応が終わったら、AppMap で再スキャンして残問題がないか確認することを推奨します");
  } else {
    lines.push("- Address one issue at a time, in order");
    lines.push("- After each fix, briefly report (1-2 lines) what you changed");
    lines.push("- If uncertain, stop and ask me with options rather than guessing");
    lines.push("- Secret values are masked. Replace them with `process.env.XXX`-style env-var references; I'll set the actual values myself");
    lines.push("- After all fixes, re-scan with AppMap to verify no remaining issues");
  }

  return lines.join("\n");
}

export function computeOverallAssessment(
  findings: Finding[],
  language: Language,
): OverallAssessment {
  const verdict = calcVerdict(findings);
  const t = translations(language);
  const highs = findings.filter((f) => f.severity === "high").length;
  const meds = findings.filter((f) => f.severity === "medium").length;
  const lows = findings.filter((f) => f.severity === "low").length;

  let label: string;
  let summary: string;
  if (verdict === "block") {
    label = t.verdictBlockLabel;
    summary = t.verdictBlockSummary(highs, meds);
  } else if (verdict === "caution") {
    label = t.verdictCautionLabel;
    summary = t.verdictCautionSummary(meds, lows);
  } else if (findings.length === 0) {
    label = t.verdictReadyLabel;
    summary = t.verdictReadyPerfectSummary;
  } else {
    label = t.verdictReadyLabel;
    summary = t.verdictReadyWithLowSummary(lows);
  }

  const priorityTitles = findings
    .slice() // 元配列を保護
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 } as const;
      return rank[a.severity] - rank[b.severity];
    })
    .slice(0, 3)
    .map((f) => f.title);

  return { verdict, label, summary, priorityTitles };
}

export function buildFindings({
  screens,
  scan,
  language,
}: CheckInputs): Finding[] {
  const findings: Finding[] = [];
  const t = translations(language);

  // ── 1. シークレット(コードスキャン)
  //   v0.1.10(Codex 二次指摘 Medium #4):count は truncate 前の総数(secrets_total)を使う。
  if (scan && scan.secrets.length > 0) {
    const total = scan.secrets_total;
    findings.push({
      id: "secrets",
      severity: "high",
      category: "secrets",
      title: t.secretsTitle(total),
      hint: t.secretsHint,
      fixSteps: t.secretsFix,
      examples: scan.secrets.slice(0, 10).map((s) => ({
        file: s.file,
        line: s.line,
        snippet: s.snippet,
      })),
      count: total,
    });
  }

  // v0.1.10(Codex 指摘 Medium #5):.env ファイルが .gitignore で守られていない場合、
  //   誤って git commit → push すると全公開になる。高い severity で先頭に出す。
  if (scan && scan.env_files_present && !scan.env_covered_by_gitignore) {
    findings.push({
      id: "env-unprotected",
      severity: "high",
      category: "secrets",
      title: t.envUnprotectedTitle,
      hint: t.envUnprotectedHint,
      fixSteps: t.envUnprotectedFix,
    });
  }

  // v0.1.10 スリム化:以下 4 項目を削除(価値疑問 or 誤検知多発のため)
  //   - no-entry / multi-entry:マップから直接見える情報、finding として重複
  //   - risky-screens:AI 主観判定、コード修正不能で価値薄
  //   - unanalyzed:AI 分析の副産物、実害無し
  //   - potential-errors:誤検知率高、Cursor に貼ると害の方が大きい
  // 残しているのは信頼度の高い実 grep ベースの検出のみ:
  //   - secrets(直書き秘密情報)
  //   - console-logs(残り数え上げ)
  //   - todos(残り数え上げ)
  //   - no-test-framework / no-tests(実ファイル・実 package.json ベース)

  // ── テスト整備
  //     優先度:scan(リアルタイム、package.json 直読)> context.testing(AI 分析結果、古い可能性)
  const scanFramework = scan?.detected_test_framework ?? null;
  const scanHasTests = scan?.has_test_files ?? false;
  const ctxTesting = screens.context?.testing;
  const framework = scanFramework ?? ctxTesting?.framework ?? null;
  const hasTests = scan ? scanHasTests : ctxTesting?.hasTests;

  if (!framework) {
    findings.push({
      id: "no-test-framework",
      severity: "medium",
      category: "testing",
      title: t.noTestFrameworkTitle,
      hint: t.noTestFrameworkHint,
      fixSteps: t.noTestFrameworkFix,
    });
  } else if (hasTests === false) {
    // v0.1.10 R3:framework が入っているだけ「準備は済んでいる」状態なので、
    // 「framework すら無い」よりは 1 段軽い。severity を low に格下げ。
    findings.push({
      id: "no-tests",
      severity: "low",
      category: "testing",
      title: t.noTestsTitle(framework),
      hint: t.noTestsHint,
      fixSteps: t.noTestsFix,
    });
  }

  // ── 6. 開発中コードの残置(scan 依存)
  //   v0.1.10(Codex 指摘 Medium #4):console_logs は count のみだったが Vec<ScanHit>
  //   に変えたので、examples に file:line を載せて Cursor が全体 grep 過剰修正しないように。
  //   v0.1.10 二次:count は truncate 前の総数(console_logs_total)を使う。
  if (scan && scan.console_logs.length > 0) {
    const total = scan.console_logs_total;
    findings.push({
      id: "console-logs",
      severity: total > 20 ? "medium" : "low",
      category: "dev-leftovers",
      title: t.consoleLogsTitle(total),
      hint: t.consoleLogsHint,
      fixSteps: t.consoleLogsFix,
      examples: scan.console_logs.slice(0, 10).map((s) => ({
        file: s.file,
        line: s.line,
        snippet: s.snippet,
      })),
      count: total,
    });
  }
  if (scan && scan.todos.length > 0) {
    const total = scan.todos_total;
    findings.push({
      id: "todos",
      severity: "low",
      category: "dev-leftovers",
      title: t.todosTitle(total),
      hint: t.todosHint,
      fixSteps: t.todosFix,
      examples: scan.todos.slice(0, 8).map((h) => ({
        file: h.file,
        line: h.line,
        snippet: h.snippet,
      })),
      count: total,
    });
  }

  // severity 順 → id 順で安定ソート
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    const d = rank[a.severity] - rank[b.severity];
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return findings;
}

// ────────────────────────────────────────────────────────────────
// i18n(このファイル完結。i18n.ts に混ぜると Translations 型が肥大するので分離)
// ────────────────────────────────────────────────────────────────
type Copy = {
  secretsTitle: (n: number) => string;
  secretsHint: string;
  secretsFix: string[];
  // v0.1.10(Codex 指摘 Medium #5):.env が .gitignore で守られていないとき
  envUnprotectedTitle: string;
  envUnprotectedHint: string;
  envUnprotectedFix: string[];
  noEntryTitle: string;
  noEntryHint: string;
  noEntryFix: string[];
  multiEntryTitle: (n: number) => string;
  multiEntryHint: string;
  multiEntryFix: string[];
  riskyTitle: (n: number) => string;
  riskyHint: string;
  riskyFix: string[];
  unanalyzedTitle: (n: number) => string;
  unanalyzedHint: string;
  unanalyzedFix: string[];
  noTestFrameworkTitle: string;
  noTestFrameworkHint: string;
  noTestFrameworkFix: string[];
  noTestsTitle: (framework: string) => string;
  noTestsHint: string;
  noTestsFix: string[];
  consoleLogsTitle: (n: number) => string;
  consoleLogsHint: string;
  consoleLogsFix: string[];
  todosTitle: (n: number) => string;
  todosHint: string;
  todosFix: string[];
  // v0.1.9:予想エラー(静的検出、AI で深掘り可能)
  potentialErrorsTitle: (n: number) => string;
  potentialErrorsHint: string;
  potentialErrorsFix: string[];
  potentialErrorsDeepDive: string;
  // 全体評価
  verdictBlockLabel: string;
  verdictBlockSummary: (highs: number, meds: number) => string;
  verdictCautionLabel: string;
  verdictCautionSummary: (meds: number, lows: number) => string;
  verdictReadyLabel: string;
  verdictReadyPerfectSummary: string;
  verdictReadyWithLowSummary: (lows: number) => string;
  overallHeading: string;
  priorityHeading: string;
};

const JA: Copy = {
  secretsTitle: (n) => `${n} 箇所で秘密情報がコードに書き込まれています`,
  secretsHint:
    "API キー・パスワードは絶対にコードに直書きしないこと。誤ってコピー・公開されて盗まれます。",
  secretsFix: [
    "プロジェクト直下に `.env`(または `.env.local`)ファイルを作り、`API_KEY=xxx` の形で秘密情報を移す",
    "`.gitignore` に `.env` が入っているか確認(入っていなければ追加)",
    "コード側は `process.env.API_KEY`(Node)/ `import.meta.env.VITE_API_KEY`(Vite)で参照するように書き換える",
    "既に GitHub 等に push 済みなら、そのキーは漏洩済み扱い。発行元のダッシュボードで **即ローテーション**(無効化 → 新規発行)",
    "本番デプロイ先(Vercel / Netlify / AWS 等)の環境変数設定にも同じ値を登録",
  ],
  envUnprotectedTitle:
    ".env ファイルが `.gitignore` で守られていません",
  envUnprotectedHint:
    ".env(または .env.local など)がプロジェクト内にありますが、`.gitignore` に含まれていません。この状態で `git add .` すると秘密情報ごと公開リポジトリに上がる恐れがあります。",
  envUnprotectedFix: [
    "プロジェクト直下の `.gitignore` を開く(無ければ新規作成)",
    "以下 3 行を追加:`.env` / `.env.local` / `.env.*.local`",
    "`git status` で .env が「Untracked files」に表示されないことを確認(既に追跡中なら次のステップ)",
    "既に追跡されている場合:`git rm --cached .env` で追跡から外し、変更をコミット",
    "GitHub 等に既に push 済みなら .env 内の秘密情報は漏洩済み扱い。**すべての API キー・パスワードを即ローテーション**",
  ],
  noEntryTitle: "アプリの入口画面が定義されていません",
  noEntryHint:
    "起動時にどの画面から始まるかが不明です。動線設計が成立しません。",
  noEntryFix: [
    "起動時にユーザーが最初に見る画面を 1 つ決める(例:ログイン画面、トップページ)",
    "AI コーディングツールに「◯◯画面を起動時のエントリーポイントに設定して」と指示、または該当ファイルに ` isEntryPoint: true` 相当の目印を付ける",
    "AppMap で再分析して緑の「はじまり」バッジが該当画面に付くことを確認",
  ],
  multiEntryTitle: (n) => `入口画面が ${n} つあります(通常は 1 つ)`,
  multiEntryHint:
    "複数の起点があるとユーザー動線が予測不能になり、仕様書も曖昧になります。",
  multiEntryFix: [
    "本当の意味の入口(未認証ユーザーが最初に見る画面)を 1 つに絞る",
    "認証済みユーザー用のダッシュボード等を「入口」と混同していないか確認",
    "意図的に複数入口が必要な場合(例:管理画面と一般画面)は仕様書 §2.2 ユースケースに明記",
    "余分な入口フラグをコードから外して再分析",
  ],
  riskyTitle: (n) =>
    `${n} つの画面が「変更するとリスク高い」と判定されています`,
  riskyHint:
    "他画面への影響が大きい画面です。意図せず壊れると復旧に時間がかかります。",
  riskyFix: [
    "該当画面を実際に触って主要操作が動くか手で確認",
    "その画面から遷移する全ての画面も一通り触ってみる(連鎖破壊がないか)",
    "エラー発生時の挙動を意図的に試す(ネット切断・不正入力・権限外)",
    "変更履歴(Git ログ)で直近何が変わったかを確認",
    "可能ならステージング環境で 1 日運用してから本番に出す",
  ],
  unanalyzedTitle: (n) => `${n} つの画面が AI の影響判定を受けていません`,
  unanalyzedHint:
    "AI が「変更したらどうなる?」を判断できなかった画面です。仕様書出力時に空欄になります。",
  unanalyzedFix: [
    "**設定** → **Detail level** を「Detailed」に切替",
    "対象フォルダを再分析(履歴の同じフォルダを選ぶか、Pick folder から再選択)",
    "それでも埋まらない画面は、コードに JSDoc / コメントで役割を明記してから再分析",
    "AI に頼らずインスペクター右パネルの「メモ」に自分で補足を書くのも有効",
  ],
  noTestFrameworkTitle: "テストフレームワークが検出できませんでした",
  noTestFrameworkHint:
    "Jest / Vitest / Pytest などのテスト環境が見つかりません。本番運用するなら最低限、主要画面遷移を検証するテストを 1 つ用意することを強く推奨します。",
  noTestFrameworkFix: [
    "Node.js プロジェクトなら:`npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom` を実行(Vitest 推奨)",
    "`vitest.config.ts` を作成(AI に「Vitest 用の設定ファイルを作って」と依頼すれば書いてくれる)",
    "`package.json` の scripts に `\"test\": \"vitest\"` を追加",
    "`src/__tests__/smoke.test.ts` を作り、`expect(true).toBe(true)` の疎通テストを書いて `npm test` で走ることを確認",
    "以降は「この画面の◯◯機能のテスト書いて」と AI に頼めば自動生成できる",
  ],
  noTestsTitle: (fw) =>
    `${fw} は導入されていますが、テストが 1 つも書かれていません`,
  noTestsHint:
    "テストゼロで本番に出すと「動くはずが動かない」が発覚するまで気づけません。",
  noTestsFix: [
    "まずは Happy Path(正常系)を 1 つ:入口画面から主要機能まで動くか検証するテスト",
    "AI コーディングツールに「◯◯画面の happy path テストを書いて」と依頼",
    "生成されたテストを `npm test` で実行、Green になることを確認",
    "同じ要領で「変更したときリスク高い」画面(§ 上記)にもテストを追加",
    "CI(GitHub Actions 等)で自動実行するように `.github/workflows/test.yml` を設定",
  ],
  consoleLogsTitle: (n) => `console.log が ${n} 箇所残っています`,
  consoleLogsHint:
    "デバッグ用の出力が残ったままです。本番で個人情報や内部データを漏らす原因になります。",
  consoleLogsFix: [
    "各該当行を実際に確認する。**本番に不要と判断したデバッグ出力だけ**削除する。意図的な `console.error` / `console.warn` / 運用ログはそのまま残す",
    "本番でも残したいログは、ちゃんとしたロガー(`pino` / `winston` / `debug` 等)に置き換える",
    "Vite なら `vite-plugin-remove-console` を導入して本番ビルド時に自動除去(`npm i -D vite-plugin-remove-console`)",
    "ESLint 設定で `no-console` ルールを本番ビルド時のみ warn/error にすると、以降混入を防げる",
  ],
  todosTitle: (n) => `TODO / FIXME コメントが ${n} 箇所残っています`,
  todosHint:
    "未完了の作業メモです。放置すると「いつか誰かがやる」でずっと残ります。",
  todosFix: [
    "1 つずつ判断:今リリース前に対応する / 後回しにする / 既に対応済みでコメントだけ残っている",
    "対応するものは、その TODO が指す機能を実際にコード変更として実装(該当箇所を直接編集)",
    "後回しにするものは GitHub Issue に起票して、コメントを `TODO(#123): xxx` の形で Issue リンクだけ残す",
    "既に対応済みのコメントは削除",
    "以降は TODO を書くときに「担当者 or Issue 番号」を必ず添える運用にすると溜まりにくい",
  ],
  // v0.1.9:予想エラー(静的パターン検出 + AI 深掘り可能)
  potentialErrorsTitle: (n) =>
    `実行時にエラーになりそうな箇所が ${n} 件見つかりました`,
  potentialErrorsHint:
    "コードのパターンだけを見て、当てはまる箇所を広めに列挙しています。周辺コードで問題にならないケースも含まれます。下の「AI で深掘り」を押すと、Claude が実コードを読んで本当に問題かを判定 + 修正方法を教えてくれます。",
  potentialErrorsFix: [
    "各該当箇所の周辺コードを実際に読み、既に安全処理が入っているか確認する(`?? fallback` / 直前の length チェック / `?.` optional chaining / try/catch / .catch)。安全処理が既にある箇所は**変更しない**(不要なノイズになる)",
    "安全処理が無い場合のみ:`JSON.parse(...)` は try/catch で囲む、配列アクセス前に `.length` チェック、`fetch` は `.catch` または try/catch で失敗ハンドリング、DOM 要素は `?.` で null チェック",
    "対応後、簡潔に「変更した箇所 / 判断で変更しなかった箇所」の一覧を報告してください",
  ],
  // v0.1.10:上記 fixSteps は Cursor / Claude Code 向け。AppMap 内での workflow
  //   (「AI で深掘りボタン」)は UI 側の hint で案内する。
  potentialErrorsDeepDive: "AI で深掘り",
  // 全体評価(JA)v0.1.8:「品質保証」に読める強い口調をやめ、抜け漏れチェックの実態に合わせる
  verdictBlockLabel: "出荷前に修正したい項目あり",
  verdictBlockSummary: (h, m) =>
    `重大レベルの抜けが ${h} 件${m > 0 ? `、中レベルが ${m} 件` : ""}見つかりました。まず重大(赤)を潰してから出荷するのが安全です。放置すると個人情報漏洩・不正利用・データ破損につながる可能性のある項目が含まれます。`,
  verdictCautionLabel: "修正したい項目あり",
  verdictCautionSummary: (m, l) =>
    `致命的な抜けは見つかりませんでしたが、中レベルが ${m} 件${l > 0 ? `(軽微 ${l} 件も)` : ""}あります。可能なら中(黄)から潰しておくと、運用中のトラブル対処が楽になります。`,
  verdictReadyLabel: "明らかな抜けは見つかりませんでした",
  verdictReadyPerfectSummary:
    "このチェックが見る範囲では、重大・中・軽微いずれの抜けも検出されませんでした。ただし本チェックはバグ・セキュリティ・実際の動作までは確認していません。出荷前に手動での動作確認を必ず行ってください。",
  verdictReadyWithLowSummary: (l) =>
    `重大レベルの抜けはありません。軽微が ${l} 件ありますが、リリースをブロックする理由にはなりません。時間ができたら潰しておくと以降が楽になります。`,
  overallHeading: "全体評価",
  priorityHeading: "まず対応すべき項目",
};

const EN: Copy = {
  secretsTitle: (n) => `${n} hardcoded secrets in your code`,
  secretsHint:
    "Never put API keys or passwords directly in code. They can be leaked by accident.",
  secretsFix: [
    "Create a `.env` (or `.env.local`) file at the project root and move the secrets as `API_KEY=xxx`",
    "Confirm `.env` is listed in `.gitignore` (add it if not)",
    "In code, reference via `process.env.API_KEY` (Node) or `import.meta.env.VITE_API_KEY` (Vite) instead",
    "If already pushed to GitHub, treat the keys as leaked. **Rotate them immediately** in the provider's dashboard",
    "Add the same values to your production host's env-var settings (Vercel / Netlify / AWS, etc.)",
  ],
  envUnprotectedTitle:
    ".env file exists but is not covered by `.gitignore`",
  envUnprotectedHint:
    "A .env (or .env.local) file exists in your project, but `.gitignore` doesn't cover it. `git add .` at this state would upload secrets to a public repo.",
  envUnprotectedFix: [
    "Open `.gitignore` at the project root (create it if it doesn't exist)",
    "Add these 3 lines: `.env` / `.env.local` / `.env.*.local`",
    "Run `git status` and confirm .env does NOT appear under 'Untracked files' (if it's already tracked, do the next step)",
    "If already tracked: `git rm --cached .env` to untrack it, then commit",
    "If already pushed to GitHub, treat everything in .env as leaked. **Rotate every API key / password immediately**",
  ],
  noEntryTitle: "No entry screen is defined",
  noEntryHint:
    "It's unclear which screen the user sees first. The user flow can't be established.",
  noEntryFix: [
    "Decide which single screen the user sees first (e.g. login, top page)",
    "Tell your AI coding tool to \"set screen X as the entry point\", or mark the file with an `isEntryPoint: true`-equivalent flag",
    "Re-analyze in AppMap and check the green \"START\" badge appears on that screen",
  ],
  multiEntryTitle: (n) => `${n} entry screens defined (usually should be 1)`,
  multiEntryHint:
    "Multiple starting points make the user flow unpredictable and the spec ambiguous.",
  multiEntryFix: [
    "Pick one real entry point (the screen unauthenticated users see first)",
    "Check you're not confusing an authenticated dashboard with the entry point",
    "If multiple entries are intentional (e.g. admin vs. user), document them in spec §2.2 Use Cases",
    "Remove the extra entry-point flags in code and re-analyze",
  ],
  riskyTitle: (n) => `${n} screens flagged as high-risk to change`,
  riskyHint:
    "These screens have large downstream impact. Unintended breakage takes long to recover from.",
  riskyFix: [
    "Manually walk through the main operations on each screen",
    "Also touch the screens these lead to (check for chain breakage)",
    "Deliberately trigger error conditions (network drop, invalid input, unauthorized access)",
    "Check git log for recent changes to these screens",
    "If possible, deploy to staging and use it for a day before production",
  ],
  unanalyzedTitle: (n) => `${n} screens have no risk analysis`,
  unanalyzedHint:
    "The AI couldn't judge the change impact for these screens. They'll show as blanks in the spec doc.",
  unanalyzedFix: [
    "Go to **Settings** → **Detail level** and switch to \"Detailed\"",
    "Re-analyze the target folder (either from history or Pick folder)",
    "For screens still not covered, add JSDoc / comments describing their purpose then re-analyze",
    "Alternatively, write your own note in the Inspector panel's Notes section",
  ],
  noTestFrameworkTitle: "No test framework detected",
  noTestFrameworkHint:
    "No Jest / Vitest / Pytest was found. We strongly recommend at least one integration test that covers the main user flow before production.",
  noTestFrameworkFix: [
    "For Node.js projects: run `npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom` (Vitest recommended)",
    "Create `vitest.config.ts` (ask your AI \"make a Vitest config\" and it'll write it)",
    "Add `\"test\": \"vitest\"` to the `scripts` block of `package.json`",
    "Create `src/__tests__/smoke.test.ts` with a trivial `expect(true).toBe(true)` and run `npm test` to confirm it works",
    "From then on, ask the AI \"write tests for feature X on screen Y\" to generate them",
  ],
  noTestsTitle: (fw) => `${fw} is installed but no tests were written`,
  noTestsHint:
    "Shipping with zero tests means \"it worked in dev\" is your only guarantee.",
  noTestsFix: [
    "Start with a Happy Path test: does the flow from entry point to main feature work?",
    "Ask your AI coding tool: \"write a happy-path test for screen X\"",
    "Run `npm test` and confirm it goes green",
    "Add tests for the high-risk screens (see above) next",
    "Wire it into CI (GitHub Actions etc.) with `.github/workflows/test.yml` for auto-execution",
  ],
  consoleLogsTitle: (n) => `${n} console.log calls left in code`,
  consoleLogsHint:
    "Debug output can leak personal data or internal state in production.",
  consoleLogsFix: [
    "Inspect each site. **Only delete the debug output you've judged unnecessary for production.** Keep intentional `console.error` / `console.warn` and operational logs.",
    "For logs you actually want in production, replace with a real logger (`pino` / `winston` / `debug`)",
    "For Vite, add `vite-plugin-remove-console` to strip them in production builds (`npm i -D vite-plugin-remove-console`)",
    "Enable the ESLint `no-console` rule to prevent new ones from creeping in",
  ],
  todosTitle: (n) => `${n} TODO / FIXME comments remain`,
  todosHint:
    "Unfinished-work markers. Left alone, they linger forever as \"someday, somebody\".",
  todosFix: [
    "Triage each one: do it now, defer it, or realize it's already done and just needs deletion",
    "For items to do now, implement the referenced work as an actual code change (edit the site directly)",
    "For deferred items, file a GitHub Issue and replace the comment with a link like `TODO(#123): ...`",
    "Delete already-handled comments outright",
    "Going forward, always tag TODOs with an owner or Issue number to keep them from accumulating",
  ],
  // v0.1.9: potential runtime errors (static detection + optional AI deep-dive)
  potentialErrorsTitle: (n) =>
    `${n} spot(s) that could crash at runtime`,
  potentialErrorsHint:
    "Detected purely from surface patterns and shown broadly — many of these will not actually cause problems in context. Click 'AI deep-dive' to have Claude read the source and tell you which are real and how to fix them.",
  potentialErrorsFix: [
    "For each location, read the surrounding code and check whether it is already guarded (`?? fallback` / preceding `.length` check / `?.` optional chaining / try/catch / .catch). If a safe pattern already exists, **do NOT modify** it (adds noise).",
    "Only if unguarded: wrap `JSON.parse(...)` in try/catch, add a `.length` check before indexed access, use `.catch` or try/catch on `fetch`, use `?.` on DOM element access.",
    "After the pass, briefly report which sites you changed vs which you left alone with reasoning.",
  ],
  potentialErrorsDeepDive: "AI deep-dive",
  // Overall assessment (EN) v0.1.8: softened to reflect the checklist's actual scope
  verdictBlockLabel: "Fix these before shipping",
  verdictBlockSummary: (h, m) =>
    `${h} high-severity gap(s)${m > 0 ? ` and ${m} medium` : ""} were found. Resolving the red items before shipping is safer — some can lead to data leaks, unauthorized access, or corruption.`,
  verdictCautionLabel: "Items worth fixing",
  verdictCautionSummary: (m, l) =>
    `No critical gaps found, but ${m} medium item(s)${l > 0 ? ` (and ${l} low)` : ""} remain. Resolving the yellow items first makes runtime troubleshooting easier.`,
  verdictReadyLabel: "No obvious gaps found",
  verdictReadyPerfectSummary:
    "Within this checklist's scope, no high, medium, or low-severity gaps were detected. Note: this check does NOT cover bugs, security, or actual runtime behavior. Manually verify the main user flow before shipping.",
  verdictReadyWithLowSummary: (l) =>
    `No high-severity gaps. ${l} low item(s) remain but do not block release. Handle them when convenient to make future work easier.`,
  overallHeading: "Overall assessment",
  priorityHeading: "Fix these first",
};

function translations(language: Language): Copy {
  return language === "en" ? EN : JA;
}
