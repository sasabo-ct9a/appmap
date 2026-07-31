import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
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
  /** file:line 付き。件数のみだと Cursor が全体 grep で意図的な console.error まで
   *  消す過剰修正の温床になるので、位置情報を必ず返す。 */
  console_logs: ScanHit[];
  /** truncate 前の総数。UI/AI prompt での「N 箇所」表示はこの total を使う
   *  (secrets/todos/console_logs はそれぞれ 20/50/50 で切られるため、length では過少報告になる)。 */
  secrets_total: number;
  todos_total: number;
  console_logs_total: number;
  files_scanned: number;
  files_truncated: boolean;
  /** AI 分析より新しいテストフレームワーク検出結果(null = 未検出)*/
  detected_test_framework: string | null;
  /** 実テストファイル(言語別マーカーで判定)の存在 */
  has_test_files: boolean;
  /** .env / .env.local 等が実在するか(全階層を走査) */
  env_files_present: boolean;
  /** 全ての実在 env が .gitignore で保護されているか */
  env_covered_by_gitignore: boolean;
  /** 運用インフラ有無(build/test scripts / CI / lockfile / tsconfig) */
  project_meta: ProjectMeta;
};

/** 実運用 gates:TODO 件数より重要な「本番前にあるべきもの」の欠落を検出する。
 *  monorepo / Tauri 対応で manifests 配列を持つ(root だけでなく apps/*、
 *  packages/*、src-tauri など複数 manifest を per-manifest で扱う)。 */
export type ProjectMeta = {
  project_type: string | null;
  project_types: string[];
  has_build_script: boolean;
  has_test_script: boolean;
  has_typecheck_script: boolean;
  has_lockfile: boolean;
  has_tsconfig_file: boolean;
  is_typescript_project: boolean;
  has_ci_workflow: boolean;
  manifests: ManifestInfo[];
};

export type ManifestInfo = {
  manifest_type: string;
  path: string;
  has_build: boolean;
  has_test: boolean;
  has_typecheck: boolean;
  has_lockfile: boolean;
  /** 純粋な tsconfig ファイル実在(devDeps.typescript は含まない) */
  has_tsconfig_file: boolean;
  /** TS project 扱い(has_tsconfig_file OR typescript 依存)。typecheck 欠落 gate はこれで判定 */
  is_typescript_project: boolean;
};

/**
 * Rust の pre_release_scan コマンドから返る PreReleaseScanResult の
 * runtime decoder。Rust struct と TS type は手同期なので、片側変更で
 * silently 壊れるのを防ぐため invoke の境界で必ずパースを通す。
 *
 * schema が失敗した場合は詳細エラーを throw する(呼び出し側で scanError に載る)。
 */
// スキーマは全て .strict() を付ける。Rust 側にフィールドを追加したのに TS 側で
// 反映してない場合、silently 落ちて UI が古い形を見続ける事故を防ぐ。
// (Rust 側で削除・rename しても即 error で気づく。)
const ScanHitSchema = z
  .object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    snippet: z.string(),
    kind: z.string(),
  })
  .strict();

const ManifestInfoSchema = z
  .object({
    manifest_type: z.string(),
    path: z.string(),
    has_build: z.boolean(),
    has_test: z.boolean(),
    has_typecheck: z.boolean(),
    has_lockfile: z.boolean(),
    has_tsconfig_file: z.boolean(),
    is_typescript_project: z.boolean(),
  })
  .strict();

const ProjectMetaSchema = z
  .object({
    project_type: z.string().nullable(),
    project_types: z.array(z.string()),
    has_build_script: z.boolean(),
    has_test_script: z.boolean(),
    has_typecheck_script: z.boolean(),
    has_lockfile: z.boolean(),
    has_tsconfig_file: z.boolean(),
    is_typescript_project: z.boolean(),
    has_ci_workflow: z.boolean(),
    manifests: z.array(ManifestInfoSchema),
  })
  .strict();

const PreReleaseScanResultSchema = z
  .object({
    secrets: z.array(ScanHitSchema),
    todos: z.array(ScanHitSchema),
    console_logs: z.array(ScanHitSchema),
    secrets_total: z.number().int().nonnegative(),
    todos_total: z.number().int().nonnegative(),
    console_logs_total: z.number().int().nonnegative(),
    files_scanned: z.number().int().nonnegative(),
    files_truncated: z.boolean(),
    detected_test_framework: z.string().nullable(),
    has_test_files: z.boolean(),
    env_files_present: z.boolean(),
    env_covered_by_gitignore: z.boolean(),
    project_meta: ProjectMetaSchema,
  })
  .strict();

/**
 * Promise に上限時間を設ける。期限超過で reject する(元の Promise は放置=結果を捨てる)。
 * Rust の invoke がハングした場合の UI 保険。Rust タスク自体はキャンセルできないが、
 * JS 側の await を打ち切って scanError に倒すことで無限スピナーを防ぐ。
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function runCodeScan(
  folderPath: string,
  language: Language = "ja",
): Promise<PreReleaseScanResult> {
  // 通常スキャンは cap 付き(walk 1万件 / content 200件)で数秒で終わる。
  // これを大きく超えるのは Rust 側の異常(想定外の巨大フォルダ or 処理停止)。
  // 無限スピナーを避け、scanError → "unknown" 判定に倒すためのタイムアウト。
  const SCAN_TIMEOUT_MS = 120_000;
  const timeoutMsg =
    language === "ja"
      ? "コードのスキャンが120秒以内に終わりませんでした。フォルダがとても大きいか、スキャンが途中で止まった可能性があります。フォルダを選び直すか、再読込を試してください。"
      : "The code scan did not finish within 120s. The folder may be very large or the scan stalled. Try reselecting the folder or reloading.";
  const raw = await withTimeout(
    invoke("pre_release_scan", { folder: folderPath }),
    SCAN_TIMEOUT_MS,
    timeoutMsg,
  );
  const parsed = PreReleaseScanResultSchema.safeParse(raw);
  if (!parsed.success) {
    // 片側変更(Rust or TS)で境界が壊れた時に、エラー箇所を明示。
    // fresh install / DB migration 後に古い binary が繋がるようなケースを早期発見できる。
    throw new Error(
      `pre_release_scan returned a shape TS did not expect. Rust/TS type sync broken. Details: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ────────────────────────────────────────────────────────────────
// スタックヒント(fixSteps の推奨コマンドを分岐させるため)
// ────────────────────────────────────────────────────────────────
export type StackHint = "node" | "python" | "rust" | "go" | "ruby" | "php" | "unknown";

/** screens.context.techStack から stack を推定する。判定不能なら "unknown"。 */
function inferStackHint(techStack: {
  frontend?: string | null;
  backend?: string | null;
  db?: string | null;
} | null | undefined): StackHint {
  const joined = [techStack?.frontend, techStack?.backend]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!joined) return "unknown";
  if (/\b(react|vue|svelte|next|nuxt|angular|node|express|nest|fastify|typescript|javascript|remix)\b/.test(joined)) return "node";
  if (/\b(python|django|fastapi|flask|pyramid|starlette|tornado)\b/.test(joined)) return "python";
  if (/\b(rust|actix|axum|rocket|tauri)\b/.test(joined)) return "rust";
  if (/\b(go\b|golang|gin|echo|fiber|chi)\b/.test(joined)) return "go";
  if (/\b(ruby|rails|sinatra|hanami)\b/.test(joined)) return "ruby";
  if (/\b(php|laravel|symfony|codeigniter)\b/.test(joined)) return "php";
  return "unknown";
}

// ────────────────────────────────────────────────────────────────
// 統合フィンディング型
// ────────────────────────────────────────────────────────────────
export type Severity = "high" | "medium" | "low";
export type Category = "secrets" | "testing" | "dev-leftovers";

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
export type Verdict = "ready" | "caution" | "block" | "unknown";

export type OverallAssessment = {
  verdict: Verdict;
  /** 判定短ラベル(色付きバッジ用)*/
  label: string;
  /** 判定サマリー文(1〜2 文、なぜその判定になったか)*/
  summary: string;
  /** 優先アクション(重大度順に最大 3 件のタイトル抜粋)*/
  priorityTitles: string[];
};
// calcScore(100 減点式)は撤去。数字の権威性がユーザーに
// 「品質保証」と誤読される害の方が実利用より大きかった。
// verdict(block/caution/ready/unknown)+ 件数だけで意思決定させる。

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

/**
 * 全体評価を計算する。
 * scanState:
 *   - "ok":スキャン完了(finding からそのまま verdict 算出)
 *   - "sample":サンプル表示中(実データではないので Ready 断定はしない)
 *   - "failed":スキャン失敗(unknown 判定 → 誤った安心を与えない)
 *   - "unavailable":scan 未取得(まだ実行してない / 対象フォルダ無し)
 * isPartialCoverage:
 *   - true の時、実際は 200 ファイルで打ち切られている(monorepo 等)。
 *     finding 0 でも「全部見てないから Ready と言えない」→ unknown 扱いに落とす。
 */
export function computeOverallAssessment(
  findings: Finding[],
  language: Language,
  scanState: "ok" | "sample" | "failed" | "unavailable" = "ok",
  isPartialCoverage: boolean = false,
): OverallAssessment {
  const t = translations(language);
  const highs = findings.filter((f) => f.severity === "high").length;
  const meds = findings.filter((f) => f.severity === "medium").length;
  const lows = findings.filter((f) => f.severity === "low").length;

  // Ready と結論するのは「scan が完了 かつ 全ファイルを走査 かつ サンプルではない」時だけ。
  //   sample / failed / unavailable / partial coverage いずれも Ready 断定させない。
  //   ただし、既に High(重大)findings があるなら、その事実は覆されないので block を優先する。
  let verdict: Verdict;
  let label: string;
  let summary: string;
  if (scanState === "failed") {
    verdict = "unknown";
    label = t.verdictUnknownLabel;
    summary = t.verdictUnknownFailedSummary;
  } else if (scanState === "unavailable") {
    verdict = "unknown";
    label = t.verdictUnknownLabel;
    summary = t.verdictUnknownUnavailableSummary;
  } else if (scanState === "sample") {
    // サンプル表示中は実データではないので Ready と結論しない。
    // High/Medium finding があってもそれは「サンプル上」の話。verdict は unknown で統一。
    verdict = "unknown";
    label = t.verdictUnknownLabel;
    summary = t.verdictUnknownSampleSummary;
  } else {
    // scanState === "ok"
    const rawVerdict = calcVerdict(findings);
    if (rawVerdict === "block") {
      // 既知の重大問題は打ち切りに関係なく確定事実として block を出す
      verdict = "block";
      label = t.verdictBlockLabel;
      summary = t.verdictBlockSummary(highs, meds);
    } else if (isPartialCoverage) {
      // caution / ready を Ready ではなく unknown にする(未スキャン部分に高 severity が
      // 潜んでる可能性を消せない)
      verdict = "unknown";
      label = t.verdictUnknownLabel;
      summary = t.verdictUnknownPartialSummary;
    } else if (rawVerdict === "caution") {
      verdict = "caution";
      label = t.verdictCautionLabel;
      summary = t.verdictCautionSummary(meds, lows);
    } else if (findings.length === 0) {
      verdict = "ready";
      label = t.verdictReadyLabel;
      summary = t.verdictReadyPerfectSummary;
    } else {
      verdict = "ready";
      label = t.verdictReadyLabel;
      summary = t.verdictReadyWithLowSummary(lows);
    }
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
  // count は truncate 前の総数(secrets_total)を使う。scan.secrets.length は
  // 表示用に切詰められた件数で、実件数を過少報告してしまうため。
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

  // .env が実在するが .gitignore で守られていない場合:git commit → push で秘密情報
  //   まるごと公開される事故のリスク。severity high で他の finding より優先表示。
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

  // ── 運用ゲート(build/test script・typecheck・lockfile・CI)は撤去した。
  //   CLAUDE.md §6.5 スコープ憲章の判断基準に反するため:非エンジニアには専門用語で
  //   「なぜ大事か」が伝わらず、直すのに DevOps 知識が要り、かつスタック固有(Unity/C# には
  //   package.json も lockfile も無関係)で誤検出の温床だった。ここには追加しない。

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
  // scan がある(実フォルダを直近でスキャン済み)なら scan を単独ソースにする。
  //   AI context の framework は分析当時の情報で、その後 package.json から削除しても
  //   残り続けてしまうため、scan 完了後に fallback すると「実在しない framework が
  //   検出されてる」誤情報になる。scan==null(サンプル or 未実行)の時だけ AI context を使う。
  const ctxTesting = screens.context?.testing;
  const framework = scan
    ? scan.detected_test_framework
    : ctxTesting?.framework ?? null;
  const hasTests = scan ? scan.has_test_files : ctxTesting?.hasTests;

  const stackHint = inferStackHint(screens.context?.techStack);
  if (framework) {
    if (hasTests === false) {
      // framework が入っているだけ「準備は済んでいる」状態なので、「framework すら無い」よりは
      // 1 段軽い扱い(severity を low に格下げ)。
      findings.push({
        id: "no-tests",
        severity: "low",
        category: "testing",
        title: t.noTestsTitle(framework),
        hint: t.noTestsHint,
        fixSteps: t.noTestsFix(stackHint),
      });
    }
  } else if (hasTests !== true) {
    // framework 未検出 かつ テストファイルも無い → テスト整備なしとして指摘。
    //   JS/TS/Python は framework を依存パッケージで検出するが、Rust/Go/C# は
    //   テストランナーがツールチェーン内蔵(cargo test / go test / dotnet test)。
    //   これらは framework が常に null なので、テストファイルがあれば整備済みとみなし
    //   「テストフレームワーク未検出」を出さない(全 Rust/Go/C# 誤検出の回避)。
    findings.push({
      id: "no-test-framework",
      severity: "medium",
      category: "testing",
      title: t.noTestFrameworkTitle,
      hint: t.noTestFrameworkHint,
      fixSteps: t.noTestFrameworkFix(stackHint),
    });
  }

  // ── 6. 開発中コードの残置(scan 依存)
  // console_logs は file:line を持つので、examples に載せて Cursor に該当箇所だけ
  //   修正させる(全体 grep での過剰修正を防ぐ)。count は truncate 前の総数を使う。
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
  // .env が .gitignore で守られていないときの hotfix 指示
  envUnprotectedTitle: string;
  envUnprotectedHint: string;
  envUnprotectedFix: string[];
  // 運用ゲート(build/test/typecheck/lockfile/CI)の Copy は CLAUDE.md §6.5 スコープ憲章で
  // 撤去済みのため削除した。ここには戻さない。
  noTestFrameworkTitle: string;
  noTestFrameworkHint: string;
  /** stack ヒント(node/python/rust/go/ruby/php/unknown)から適切な導入手順を返す。
   *  Node 前提の `npm install vitest` を Rust/Python プロジェクトに出す事故を防ぐ。 */
  noTestFrameworkFix: (stack: StackHint) => string[];
  noTestsTitle: (framework: string) => string;
  noTestsHint: string;
  noTestsFix: (stack: StackHint) => string[];
  consoleLogsTitle: (n: number) => string;
  consoleLogsHint: string;
  consoleLogsFix: string[];
  todosTitle: (n: number) => string;
  todosHint: string;
  todosFix: string[];
  // 全体評価
  verdictBlockLabel: string;
  verdictBlockSummary: (highs: number, meds: number) => string;
  verdictCautionLabel: string;
  verdictCautionSummary: (meds: number, lows: number) => string;
  verdictReadyLabel: string;
  verdictReadyPerfectSummary: string;
  verdictReadyWithLowSummary: (lows: number) => string;
  verdictUnknownLabel: string;
  verdictUnknownFailedSummary: string;
  verdictUnknownUnavailableSummary: string;
  verdictUnknownPartialSummary: string;
  verdictUnknownSampleSummary: string;
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
  envUnprotectedTitle: ".env ファイルが `.gitignore` で守られていません",
  envUnprotectedHint:
    ".env(または .env.local など)がプロジェクト内にありますが、`.gitignore` に含まれていません。この状態で `git add .` すると秘密情報ごと公開リポジトリに上がる恐れがあります。",
  envUnprotectedFix: [
    "プロジェクト直下の `.gitignore` を開く(無ければ新規作成)",
    "以下 3 行を追加:`.env` / `.env.local` / `.env.*.local`",
    "`git status` で .env が「Untracked files」に表示されないことを確認(既に追跡中なら次のステップ)",
    "既に追跡されている場合:`git rm --cached .env` で追跡から外し、変更をコミット",
    "GitHub 等に既に push 済みなら .env 内の秘密情報は漏洩済み扱い。**すべての API キー・パスワードを即ローテーション**",
  ],
  noTestFrameworkTitle: "自動テストがまだありません",
  noTestFrameworkHint:
    "自動テストとは、プログラムが「アプリが壊れていないか」を毎回自動で確かめてくれる仕組みです。今は手で触って確認できていれば大丈夫ですが、画面や機能が増えると手動だけでは追いつかなくなります。まずは「主要な画面がちゃんと開くか」を確かめる 1 件だけでも用意しておくと安心です(責めているわけではありません)。",
  noTestFrameworkFix: (stack) => {
    switch (stack) {
      case "node":
        return [
          "`npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom` を実行(Vitest 推奨)",
          "`vitest.config.ts` を作成(AI に「Vitest 用の設定ファイルを作って」と依頼)",
          "`package.json` の scripts に `\"test\": \"vitest\"` を追加",
          "`src/__tests__/smoke.test.ts` を作り、`expect(true).toBe(true)` の疎通テストを書いて `npm test` で走ることを確認",
        ];
      case "python":
        return [
          "`pip install pytest`(または `pip install -r requirements-dev.txt` に pytest 追加)",
          "プロジェクトルートに `tests/` フォルダと `tests/test_smoke.py` を作成、`def test_smoke(): assert True` を書く",
          "`pytest` を実行して 1 件 PASSED になることを確認",
        ];
      case "rust":
        return [
          "既にある lib.rs / main.rs の末尾に `#[cfg(test)] mod tests { #[test] fn smoke() { assert!(true); } }` を追加",
          "`cargo test` で 1 件 ok になることを確認",
          "integration test を書くなら `tests/` フォルダを作って `.rs` ファイルを置く",
        ];
      case "go":
        return [
          "`main_test.go`(または該当パッケージ内の `xxx_test.go`)を作り、`func TestSmoke(t *testing.T) { t.Log(\"ok\") }` を書く",
          "`go test ./...` で 1 件 PASS を確認",
        ];
      case "ruby":
        return [
          "`bundle add rspec --group development`(or `gem 'rspec'` を Gemfile に追加)",
          "`bundle exec rspec --init` で初期化、`spec/smoke_spec.rb` に `RSpec.describe 'smoke' do it { expect(true).to be true } end` を書く",
          "`bundle exec rspec` で 1 件 pass を確認",
        ];
      case "php":
        return [
          "`composer require --dev phpunit/phpunit`",
          "`phpunit.xml` を作成(Laravel なら標準で入っているはず)",
          "`tests/SmokeTest.php` に `public function test_smoke() { $this->assertTrue(true); }` を書く",
          "`vendor/bin/phpunit` で 1 件 OK を確認",
        ];
      default:
        return [
          "プロジェクトの言語/フレームワークに合ったテストランナーを選ぶ(Node → Vitest/Jest、Python → pytest、Rust → cargo test、Go → go test、Ruby → RSpec、PHP → PHPUnit など)",
          "1 件だけの疎通テスト(assert true 相当)を書き、コマンドで PASS することを確認する",
          "AI コーディングツールに「このプロジェクトに最小のテスト環境を導入して、疎通テストを 1 件書いて」と依頼するのが最も早い",
        ];
    }
  },
  noTestsTitle: (fw) =>
    `${fw} は導入されていますが、テストが 1 つも書かれていません`,
  noTestsHint:
    "テストゼロで本番に出すと「動くはずが動かない」が発覚するまで気づけません。",
  noTestsFix: (stack) => {
    const runCmd =
      stack === "python" ? "pytest"
        : stack === "rust" ? "cargo test"
        : stack === "go" ? "go test ./..."
        : stack === "ruby" ? "bundle exec rspec"
        : stack === "php" ? "vendor/bin/phpunit"
        : "npm test"; // node or unknown
    return [
      "まずは Happy Path(正常系)を 1 つ:入口画面から主要機能まで動くか検証するテスト",
      "AI コーディングツールに「◯◯画面の happy path テストを書いて」と依頼",
      `生成されたテストを \`${runCmd}\` で実行、Green になることを確認`,
      "同じ要領で他の重要フローにもテストを追加",
      "CI(GitHub Actions 等)で自動実行するように workflow を設定",
    ];
  },
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
  verdictUnknownLabel: "コード検査は完了していません",
  verdictUnknownFailedSummary:
    "コードスキャンが失敗したため、抜けの有無を確認できていません。フォルダのアクセス権や再度スキャンボタンでの再実行を試してください。",
  verdictUnknownUnavailableSummary:
    "コードスキャンがまだ実行されていません。フォルダを選ぶとスキャンが自動的に走ります。",
  verdictUnknownPartialSummary:
    "プロジェクトが大きく、一部のファイルまでは見ていません。優先度の高いディレクトリを先にスキャンしていますが、残りは未走査です。そのため「明らかな抜けなし」とは断定できません(見た範囲では上の項目のとおりです)。",
  verdictUnknownSampleSummary:
    "サンプルデータを表示中です。実際のフォルダをまだスキャンしていないので、結論(準備 OK / 修正必要)は出せません。フォルダを選ぶと本番診断が走ります。",
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
  noTestFrameworkTitle: "No automated tests yet",
  noTestFrameworkHint:
    "Automated tests let a program check, every time, that your app hasn't broken. Manual clicking is fine for now, but as screens and features grow it gets hard to keep up. Even one test that confirms your main screen loads is a good start — this isn't a scolding.",
  noTestFrameworkFix: (stack) => {
    switch (stack) {
      case "node":
        return [
          "Run `npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom` (Vitest recommended)",
          "Create `vitest.config.ts` (ask your AI \"make a Vitest config\")",
          "Add `\"test\": \"vitest\"` to the `scripts` block of `package.json`",
          "Create `src/__tests__/smoke.test.ts` with a trivial `expect(true).toBe(true)` and run `npm test` to confirm",
        ];
      case "python":
        return [
          "Run `pip install pytest` (or add pytest to `requirements-dev.txt`)",
          "Create `tests/` folder + `tests/test_smoke.py` with `def test_smoke(): assert True`",
          "Run `pytest` and confirm 1 test PASSED",
        ];
      case "rust":
        return [
          "Add `#[cfg(test)] mod tests { #[test] fn smoke() { assert!(true); } }` to lib.rs / main.rs",
          "Run `cargo test` and confirm 1 test ok",
          "For integration tests, create a `tests/` folder and put `.rs` files there",
        ];
      case "go":
        return [
          "Create `main_test.go` (or `xxx_test.go` in the relevant package) with `func TestSmoke(t *testing.T) { t.Log(\"ok\") }`",
          "Run `go test ./...` and confirm 1 PASS",
        ];
      case "ruby":
        return [
          "Run `bundle add rspec --group development` (or add `gem 'rspec'` to Gemfile)",
          "Init with `bundle exec rspec --init`, then write `spec/smoke_spec.rb` with `RSpec.describe 'smoke' do it { expect(true).to be true } end`",
          "Run `bundle exec rspec` and confirm 1 pass",
        ];
      case "php":
        return [
          "Run `composer require --dev phpunit/phpunit`",
          "Create `phpunit.xml` (Laravel ships this already)",
          "Write `tests/SmokeTest.php` with `public function test_smoke() { $this->assertTrue(true); }`",
          "Run `vendor/bin/phpunit` and confirm 1 OK",
        ];
      default:
        return [
          "Pick a test runner matching your language/framework (Node → Vitest/Jest, Python → pytest, Rust → cargo test, Go → go test, Ruby → RSpec, PHP → PHPUnit)",
          "Write a single smoke test (assert true equivalent) and run the appropriate command to confirm PASS",
          "The fastest path: ask your AI coding tool to \"set up the minimal test environment for this project and write one smoke test\"",
        ];
    }
  },
  noTestsTitle: (fw) => `${fw} is installed but no tests were written`,
  noTestsHint:
    "Shipping with zero tests means \"it worked in dev\" is your only guarantee.",
  noTestsFix: (stack) => {
    const runCmd =
      stack === "python" ? "pytest"
        : stack === "rust" ? "cargo test"
        : stack === "go" ? "go test ./..."
        : stack === "ruby" ? "bundle exec rspec"
        : stack === "php" ? "vendor/bin/phpunit"
        : "npm test";
    return [
      "Start with a Happy Path test: does the flow from entry point to main feature work?",
      "Ask your AI coding tool: \"write a happy-path test for screen X\"",
      `Run \`${runCmd}\` and confirm it goes green`,
      "Add tests for other critical flows next",
      "Wire it into CI (GitHub Actions etc.) for auto-execution",
    ];
  },
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
  verdictUnknownLabel: "Code check did not complete",
  verdictUnknownFailedSummary:
    "The code scan failed, so no verdict can be given. Check folder access permissions or press the Rescan button.",
  verdictUnknownUnavailableSummary:
    "The code scan has not run yet. Pick a folder and the scan will start automatically.",
  verdictUnknownPartialSummary:
    "The project is large, so some files weren't inspected. Priority directories were scanned first, but the rest was skipped, so \"no gaps found\" can't be concluded (what was scanned is shown above).",
  verdictUnknownSampleSummary:
    "Showing sample data. No real folder has been scanned yet, so no verdict (ready / issues to fix) can be given. Pick a folder to run the real diagnosis.",
  overallHeading: "Overall assessment",
  priorityHeading: "Fix these first",
};

function translations(language: Language): Copy {
  return language === "en" ? EN : JA;
}
