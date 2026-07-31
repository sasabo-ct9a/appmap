import type { ScreenNode, ScreenEdge } from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";
import { pickLocalized, type Language } from "./i18n";

/**
 * v0.1.7 リライト:出来上がったマップから正式な「アプリ仕様書」(Markdown)を組み立てる。
 *
 * 出力構造(ユーザー要求のテンプレート):
 *   1. 概要 / 2. ユーザーとユースケース / 3. 機能要件 / 4. 非機能要件 /
 *   5. システム構成 / 6. データ設計 / 7. インターフェース設計 /
 *   8. 画面設計 / 9. 異常系 / 10. テスト方針 / 11. 開発計画 /
 *   12. 未決事項 / 変更履歴
 *
 * AI に無い情報は `＿＿＿＿`(全角アンダースコア)のプレースホルダで埋める。
 * mapping:
 *   - 背景・目的         ← appSummary
 *   - 用語定義           ← dataUsed(日本語)+ dataTech(識別子)
 *   - ユースケース       ← isEntryPoint / subActions
 *   - 機能要件           ← 全画面(userIntent + body + depth → 優先度)
 *   - 機能詳細           ← subActions / dataUsed / edges / changeHint
 *   - 技術スタック       ← files 拡張子ヒューリスティック
 *   - アーキテクチャ図   ← edges を mermaid graph に
 *   - ER図/テーブル      ← dataTech の { name, fields[] }
 *   - 画面設計           ← 全画面(label + subActions + 遷移先)
 */

// v0.1.8:エンドユーザーは実際に使う場面が薄く、また未実装だったため削除
//         2 択(エンジニア / ノーコード経験者)は実際に文言を切り替える
export type SpecAudience = "engineer" | "noCode";

/**
 * ノーコード読者向けに、DB 型・制約・優先度などのエンジニア用語を日常語に置換する。
 * engineer モードでは何もしない。
 * 部分置換なので、`INTEGER / UUID (id)` のように括弧付き文字列も自然に読める形に落ちる。
 */
export function simplifyForNoCode(
  text: string,
  audience: SpecAudience,
): string {
  if (audience !== "noCode") return text;
  const pairs: Array<[RegExp | string, string]> = [
    // DB 型
    [/INTEGER \/ UUID/g, "数値 ID"],
    [/INTEGER/g, "数値"],
    [/TIMESTAMP/g, "日時"],
    [/VARCHAR\(255\)/g, "文字列(短め)"],
    [/VARCHAR\(50\)/g, "文字列(短め)"],
    [/VARCHAR\(30\) \/ ENUM/g, "選択肢(いくつかから選ぶ)"],
    [/VARCHAR\(30\)/g, "文字列(短め)"],
    [/TEXT/g, "長文"],
    [/BOOLEAN/g, "はい/いいえ"],
    [/DECIMAL\(10, 2\)/g, "金額(小数あり)"],
    // 制約
    [/PRIMARY KEY, NOT NULL/g, "主キー(必須・重複禁止)"],
    [/FOREIGN KEY, NOT NULL/g, "参照キー(必須)"],
    [/UNIQUE, NOT NULL/g, "重複禁止・必須"],
    [/NOT NULL, DEFAULT now\(\)/g, "必須(自動で今の日時が入る)"],
    [/NOT NULL, DEFAULT false/g, "必須(初期はいいえ)"],
    [/NOT NULL, DEFAULT 0/g, "必須(初期は 0)"],
    [/NOT NULL/g, "必須"],
    [/NULL 可/g, "空欄可"],
    // 機能要件テーブルの優先度
    [/(^|\|)\s*Must\s*(\||$)/g, "$1 必須 $2"],
    [/(^|\|)\s*Should\s*(\||$)/g, "$1 あると良い $2"],
    [/(^|\|)\s*Could\s*(\||$)/g, "$1 後回しでOK $2"],
  ];
  let out = text;
  for (const [pat, rep] of pairs) {
    out = typeof pat === "string" ? out.split(pat).join(rep) : out.replace(pat, rep);
  }
  return out;
}

type BuildOptions = {
  screens: ScreenMapResult;
  audience: SpecAudience;
  language: Language;
  folderPath: string | null;
  /** v0.1.7:モーダル上で入力された作成者名(空文字 or undefined ならプレースホルダのまま) */
  authorName?: string;
};

function indexEdges(edges: ScreenEdge[]): {
  outgoing: Map<number, Array<{ to: number; bidi: boolean }>>;
  incoming: Map<number, Array<{ from: number; bidi: boolean }>>;
} {
  const outgoing = new Map<number, Array<{ to: number; bidi: boolean }>>();
  const incoming = new Map<number, Array<{ from: number; bidi: boolean }>>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push({ to: e.to, bidi: !!e.bidirectional });
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push({ from: e.from, bidi: !!e.bidirectional });
  }
  return { outgoing, incoming };
}

function indexNodes(nodes: ScreenNode[]): Map<number, ScreenNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function escTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const PH = "＿＿＿＿"; // プレースホルダ

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// v0.1.33:フィールド名から DB 型・主キー・暗号化・論理削除を推測する guessFieldSpec は撤去した。
//   DB があるとは限らないのに「嘘の DB 設計」を出す元凶だった(Codex 辛口 #3)。§6 は「扱う情報」
//   の平易な列挙に置き換え済み。

/** dataTech の要素を { name, fields[] } に正規化 */
function normalizeTech(
  t: string | { name: string; fields?: string[] },
): { name: string; fields: string[] } {
  if (typeof t === "string") return { name: t, fields: [] };
  return { name: t.name, fields: t.fields ?? [] };
}

/** 技術スタックを file 拡張子から推測 */
function detectStack(files: string[]): {
  frontend: string;
  backend: string;
  db: string;
  extra: string[];
} {
  const flat = files.map((f) => f.toLowerCase());
  const hasExt = (ext: string) => flat.some((f) => f.endsWith(ext));
  const hasName = (name: string) => flat.some((f) => f.endsWith(name));
  const frontend: string[] = [];
  const backend: string[] = [];
  const db: string[] = [];
  const extra: string[] = [];

  if (hasExt(".tsx") || hasExt(".jsx")) frontend.push("React + TypeScript");
  else if (hasExt(".ts")) frontend.push("TypeScript");
  if (hasExt(".vue")) frontend.push("Vue");
  if (hasExt(".svelte")) frontend.push("Svelte");
  if (hasName("tauri.conf.json")) extra.push("Tauri (Desktop)");
  if (hasName("cargo.toml") || hasExt(".rs")) backend.push("Rust");
  if (hasExt(".py")) backend.push("Python");
  if (hasExt(".go")) backend.push("Go");
  if (hasExt(".rb")) backend.push("Ruby");
  if (hasExt(".java")) backend.push("Java");
  if (hasName("package.json")) extra.push("Node.js");
  if (hasName("vite.config.ts") || hasName("vite.config.js")) extra.push("Vite");
  if (hasExt(".sql")) db.push("SQL");
  if (hasName("prisma.schema") || hasName("schema.prisma")) db.push("Prisma");

  return {
    frontend: frontend.join(" / ") || "(未検出、実装時に選定)",
    backend: backend.join(" / ") || "(未検出、実装時に選定)",
    db: db.join(" / ") || "(未検出、実装時に選定)",
    extra,
  };
}

export function buildSpecDoc(opts: BuildOptions): string {
  const { screens, audience, language, folderPath } = opts;
  const authorName = (opts.authorName ?? "").trim();
  const authorCell = authorName || PH;
  // v0.1.8:対象読者に応じて用語を切り替える
  const audienceLabel =
    audience === "noCode" ? "ノーコード経験者向け" : "エンジニア向け";
  // v0.1.33:エンジニア向けだけに出す「重い章」と、実データが無いと嘘になる作文を分岐する。
  //   noCode 向けは SDLC フルテンプレを捨て、マップ由来の実データ(目的/画面/流れ/操作/
  //   扱う情報/分からないこと)だけに絞る(Codex 辛口レビュー・CLAUDE.md §1/§3.3)。
  const eng = audience === "engineer";
  const { outgoing, incoming } = indexEdges(screens.edges);
  const nodeById = indexNodes(screens.nodes);
  const nowIso = today();
  const appName = folderPath
    ? folderPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "アプリ"
    : language === "ja"
      ? "アプリ"
      : "App";

  // 並び:主フロー(depth 0) → 深い層。同 depth 内は id 順で安定
  const sortedNodes = [...screens.nodes].sort((a, b) => {
    const da = a.depth ?? 0;
    const db = b.depth ?? 0;
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  const lines: string[] = [];

  // ========== ヘッダー ==========
  lines.push(`# ${appName} 仕様書`);
  lines.push("");
  lines.push(`- バージョン: v0.1`);
  lines.push(`- 作成者: ${authorCell}`);
  lines.push(`- 最終更新: ${nowIso}`);
  lines.push(`- ステータス: draft / review / approved`);
  lines.push(`- 対象読者: ${audienceLabel}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 1. 概要 ==========
  lines.push("## 1. 概要");
  lines.push("");

  lines.push("### 1.1 背景・目的");
  const summary = screens.appSummary
    ? pickLocalized(screens.appSummary, language)
    : "";
  lines.push(
    summary ||
      "(自動要約は生成されませんでした。プロジェクトの背景・目的・解決したい課題をここに追記してください。)",
  );
  lines.push("");

  lines.push("### 1.2 スコープ");
  lines.push(
    `- 対象: 本仕様書 §3 に列挙された全機能、および §8 に掲載された全画面。エンドユーザーが日常的に利用する主要ユースケース。`,
  );
  lines.push(
    `- 対象外: 未実装の拡張機能、外部連携先サービスの管理コンソール、決済・認証プロバイダー側の設定作業、社内向け運用ツール。`,
  );
  lines.push("");

  lines.push("### 1.3 用語定義");
  lines.push("| 用語 | 定義 |");
  lines.push("|---|---|");
  // dataUsed(人間向けの情報名)だけを列挙する。以前は dataUsed[i] と dataTech[i](型名)を
  //   同じ添字で対応付けていたが、両者は対応が保証されず用語↔型がズレて壊れていた
  //   (Codex 辛口 #7)。コードの型名(ScreenNode 等)は noCode 読者に無意味なので出さない(§3.3)。
  const terms = new Set<string>();
  for (const n of sortedNodes) {
    for (const d of n.detail.dataUsed ?? []) {
      const jp = pickLocalized(d, language).trim();
      if (jp) terms.add(jp);
    }
  }
  if (terms.size === 0) {
    lines.push(
      `| (該当なし) | 分析対象コードから固有の用語は抽出されませんでした。プロジェクト固有の業務用語をここに追記してください。 |`,
    );
  } else {
    for (const term of terms) {
      lines.push(
        `| ${escTable(term)} | (この仕様書で扱う情報。必要なら意味を追記) |`,
      );
    }
  }
  lines.push("");

  lines.push("### 1.4 成功条件");
  lines.push("リリース判定・受入判定に用いる条件。");
  lines.push("");
  lines.push(
    `- §2.2 に定義された全ユースケースが基本フロー通りに完走できること`,
  );
  lines.push(
    `- 想定ユーザー(§2.1)が初回起動から 5 分以内に主要機能を利用開始できること`,
  );
  lines.push(
    `- 応答の速さ・使い勝手など、決めた品質目標を満たすこと`,
  );
  lines.push(
    `- 想定される異常系(§9)で、ユーザーがデータを失わずに操作を再開できること`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 2. ユーザーとユースケース ==========
  lines.push("## 2. ユーザーとユースケース");
  lines.push("");

  lines.push("### 2.1 ユーザー種別・権限");
  lines.push("| 種別 | 説明 | 権限 |");
  lines.push("|---|---|---|");
  lines.push(`| エンドユーザー | 本アプリの利用者 | 一般機能の利用 |`);
  lines.push(
    `| 管理者 | システム設定・ユーザー管理・データ整備を行う運用担当者 | 全機能 + 管理機能へのアクセス |`,
  );
  lines.push("");

  lines.push("### 2.2 ユースケース");
  lines.push("");
  const entry = sortedNodes.find((n) => n.isEntryPoint) ?? sortedNodes[0];
  const ucNodes = entry
    ? [entry, ...sortedNodes.filter((n) => n.id !== entry.id)]
    : sortedNodes;
  ucNodes.slice(0, 5).forEach((n, i) => {
    const title = pickLocalized(n.userIntent ?? n.label, language);
    const ucId = `UC-${pad2(i + 1)}`;
    lines.push("```");
    lines.push(`${ucId}: ${title}`);
    lines.push(`アクター: エンドユーザー`);
    lines.push(
      `前提条件: ${n.isEntryPoint ? "起動直後のホーム画面" : "遷移元画面から到達済み"}`,
    );
    lines.push("基本フロー:");
    const actions = (n.subActions ?? []).slice(0, 5);
    if (actions.length === 0) {
      lines.push(`  1. ${pickLocalized(n.userIntent ?? n.label, language)}`);
      lines.push(`  2. 目的の情報を確認し、次の画面へ遷移する`);
    } else {
      actions.forEach((a, j) => {
        lines.push(`  ${j + 1}. ${pickLocalized(a, language)}`);
      });
    }
    lines.push(
      `代替フロー / 異常系: 入力エラーは該当項目をハイライトして再入力を促す。ネットワーク切断・タイムアウト時は再試行ボタンを表示。予期しない例外はエラー画面へ遷移し、直前の入力状態を保持`,
    );
    const outs = outgoing.get(n.id) ?? [];
    if (outs.length > 0) {
      const nextLabels = outs
        .map((o) =>
          pickLocalized(
            nodeById.get(o.to)?.userIntent ??
              nodeById.get(o.to)?.label ??
              "",
            language,
          ),
        )
        .filter(Boolean)
        .join(" / ");
      lines.push(
        `事後条件: ${nextLabels || "終端画面(以降の遷移なし)"} に遷移可能`,
      );
    } else {
      lines.push(
        `事後条件: 対象の操作が完了し、実行結果がユーザーに通知される(終端画面)`,
      );
    }
    lines.push("```");
    lines.push("");
  });
  lines.push("---");
  lines.push("");

  // ========== 3. 機能要件 ==========
  lines.push("## 3. 機能要件");
  lines.push("");
  lines.push("| ID | 機能名 | 説明 | 優先度 | 依存 |");
  lines.push("|---|---|---|---|---|");
  for (const n of sortedNodes) {
    const fid = `F-${pad2(n.id)}`;
    const name = pickLocalized(n.userIntent ?? n.label, language);
    const bodyText = pickLocalized(n.detail.body, language);
    const desc = escTable(bodyText).slice(0, 80);
    const priority = n.isEntryPoint
      ? "Must"
      : (n.depth ?? 0) === 0
        ? "Must"
        : (n.depth ?? 0) === 1
          ? "Should"
          : "Could";
    const deps = (incoming.get(n.id) ?? [])
      .map((e) => `F-${pad2(e.from)}`)
      .join(", ");
    lines.push(
      `| ${fid} | ${escTable(name)} | ${desc} | ${priority} | ${deps || "-"} |`,
    );
  }
  lines.push("");
  lines.push("優先度は MoSCoW(Must / Should / Could / Won't)。");
  lines.push("");

  lines.push("### 3.x 機能詳細");
  lines.push("");
  for (const n of sortedNodes) {
    const fid = `F-${pad2(n.id)}`;
    const name = pickLocalized(n.userIntent ?? n.label, language);
    lines.push(`#### ${fid}: ${name}`);
    lines.push("");
    const inputs = (n.detail.dataUsed ?? [])
      .map((d) => pickLocalized(d, language))
      .join(", ");
    lines.push(
      `- 入力: ${inputs || "(入力データなし。ローカル状態のみで完結する画面)"}`,
    );
    lines.push(`- 処理: ${escTable(pickLocalized(n.detail.body, language))}`);
    const outs = (outgoing.get(n.id) ?? [])
      .map((o) =>
        pickLocalized(
          nodeById.get(o.to)?.userIntent ?? nodeById.get(o.to)?.label ?? "",
          language,
        ),
      )
      .filter(Boolean);
    lines.push(
      `- 出力: ${outs.length > 0 ? outs.join(", ") : "(終端機能、以降の画面遷移なし)"}`,
    );
    lines.push(
      `- バリデーション: 必須項目チェック、型・値域チェック、既存データとの整合性チェック(重複・参照整合性)`,
    );
    const hintNote = n.detail.changeHint
      ? pickLocalized(n.detail.changeHint.note, language)
      : "";
    lines.push(
      `- エラー時の挙動: ${escTable(hintNote) || "エラーメッセージを表示して再操作を促す。重大エラーはログに記録して監視系へ通知"}`,
    );
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  // ========== 4. 非機能要件 ==========
  // 非機能要件はコードから検出できない(このアプリに稼働率/認証/DB があるとは限らない)。
  //   以前は HTTPS・パスワードハッシュ化・稼働率99% 等を断定で出していたが、実体と違う
  //   「嘘の仕様」だった(Codex 辛口 #1)。engineer にだけ「実装時に決める観点」として出す。
  if (eng) {
    lines.push("## 4. 非機能要件");
    lines.push("");
    lines.push(
      "以下はコードからは確認できない運用の観点です。**このアプリに実際に当てはまるものだけ**、値を決めて記入してください(該当しない項目は削除)。",
    );
    lines.push("");
    lines.push("- パフォーマンス: 主要操作の目標応答時間、扱うデータ量の目安");
    lines.push("- 対応環境: 動作対象の OS / ブラウザ(このアプリの実際の対象)");
    lines.push(
      "- セキュリティ: 秘密情報(API キー等)の保管方法、外部に送るデータの扱い。※サーバー / ログイン / DB がある場合のみ、通信の暗号化・認証・個人情報保護を追記",
    );
    lines.push("- 可用性 / 保守性: 障害時の挙動、ログ、バックアップ(必要な場合のみ)");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // ========== 5. システム構成 ==========
  lines.push("## 5. システム構成");
  lines.push("");
  lines.push("### 5.1 技術スタック");
  const allFiles = sortedNodes.flatMap((n) => n.detail.files ?? []);
  const stackDetected = detectStack(allFiles);
  // v0.1.7 拡張:AI が context.techStack を返してきたら優先(意味に近いテキストが入る想定)
  const ctxStack = screens.context?.techStack;
  const frontendCell = ctxStack?.frontend || stackDetected.frontend;
  const backendCell = ctxStack?.backend || stackDetected.backend;
  const dbCell = ctxStack?.db || stackDetected.db;
  const externalList =
    ctxStack?.external && ctxStack.external.length > 0
      ? ctxStack.external
      : stackDetected.extra;
  // バックエンド / DB / 外部サービス / クラウドは「検出できた時だけ」出す。以前は AWS/GCP/Azure の
  //   固定行や、根拠のない「選定理由」を捏造していた(Codex 辛口 #2)。実値のある層だけ列挙する。
  const isDetected = (v?: string) =>
    !!v && !v.includes("未検出") && !v.includes("該当なし");
  lines.push("| レイヤー | 技術 |");
  lines.push("|---|---|");
  lines.push(`| フロントエンド / アプリ | ${frontendCell} |`);
  if (isDetected(backendCell)) lines.push(`| バックエンド | ${backendCell} |`);
  if (isDetected(dbCell)) lines.push(`| データベース | ${dbCell} |`);
  if (externalList.length > 0)
    lines.push(`| 外部サービス | ${externalList.join(" / ")} |`);
  lines.push("");
  lines.push(
    "※ バックエンド / DB / 外部サービスはコードから検出できた場合のみ記載。空欄はこのアプリでは確認されていません(ローカルで完結するアプリでは通常空です)。",
  );
  lines.push("");

  lines.push("### 5.2 アーキテクチャ図");
  lines.push("");
  if (screens.edges.length > 0) {
    lines.push("```mermaid");
    lines.push("graph TD");
    for (const n of sortedNodes) {
      const label = pickLocalized(n.userIntent ?? n.label, language)
        .replace(/"/g, "'")
        .slice(0, 20);
      lines.push(`  N${n.id}["${label}"]`);
    }
    for (const e of screens.edges) {
      const arrow = e.bidirectional ? "<-->" : "-->";
      lines.push(`  N${e.from} ${arrow} N${e.to}`);
    }
    lines.push("```");
  } else {
    lines.push(
      `(分析対象コード内に画面遷移は検出されませんでした。単一画面のアプリの場合は該当なし、複数画面がある場合は Mermaid 等で構成要素と通信の流れを図示してください)`,
    );
  }
  lines.push("");

  // 環境構成(ステージング / 本番 / Secrets Manager 等)はコードから検出できず、固定作文だった
  //   (Codex 辛口 #2)。engineer にだけ正直な注記として出し、noCode には出さない。
  if (eng) {
    lines.push("### 5.3 環境構成");
    lines.push(
      "環境の分け方はコードからは確認できません。クラウドやサーバーを使う場合のみ、開発 / 本番の分け方・秘密情報(API キー等)の保管場所をここに記載してください。ローカルだけで動くアプリなら該当なしです。",
    );
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  // ========== 6. 扱うデータ / 情報 ==========
  // 以前は dataTech(TypeScript の型)を「DB テーブル」として主キー / 暗号化 / 論理削除まで
  //   捏造していた(guessFieldSpec)。DB があるとは限らないのに嘘の DB 設計を出していた
  //   (Codex 辛口 #3)。ここは「アプリが扱う情報」を平易に並べるだけにする。DB 用語は
  //   実際に DB を検出した時だけ使う。
  lines.push("## 6. 扱うデータ / 情報");
  lines.push("");
  const infoTerms = new Set<string>();
  for (const n of sortedNodes) {
    for (const d of n.detail.dataUsed ?? []) {
      const jp = pickLocalized(d, language).trim();
      if (jp) infoTerms.add(jp);
    }
  }
  if (infoTerms.size > 0) {
    lines.push("このアプリで扱う情報:");
    lines.push("");
    for (const t of infoTerms) lines.push(`- ${t}`);
  } else {
    lines.push(
      "分析対象コードから、扱う情報は特定できませんでした。各画面で入力・表示・保存する情報をここに追記してください。",
    );
  }
  lines.push("");
  // engineer 向けにだけ、内部のデータ構造名(dataTech)を参考として出す。DB 用語(テーブル /
  //   主キー等)は、実際に DB が検出された時だけ使う。捏造した型・制約は出さない。
  if (eng) {
    const techNames = new Set<string>();
    for (const n of sortedNodes) {
      for (const rawT of n.detail.dataTech ?? []) {
        techNames.add(normalizeTech(rawT).name);
      }
    }
    if (techNames.size > 0) {
      lines.push(
        isDetected(dbCell)
          ? `参考:検出された DB(${dbCell})上のデータ構造(実際のスキーマは要確認):`
          : "参考:アプリ内部で扱うデータ構造(DB とは限りません。型・状態の名前):",
      );
      lines.push("");
      for (const t of techNames) lines.push(`- \`${t}\``);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("");

  // ========== 7. インターフェース設計 ==========
  lines.push("## 7. インターフェース設計");
  lines.push("");
  lines.push("### 7.1 API一覧");
  lines.push("");
  lines.push("| メソッド | パス | 概要 | 認証 |");
  lines.push("|---|---|---|---|");
  // v0.1.7 拡張:AI 抽出 apiEndpoints を "METHOD /path" として分解
  const endpoints = screens.context?.apiEndpoints ?? [];
  if (endpoints.length === 0) {
    lines.push(
      `| — | — | 分析対象コードから HTTP API エンドポイントは検出されませんでした。SPA・デスクトップアプリで API を利用しない場合は「該当なし」、Web バックエンドを持つ場合はこの表に追記してください | — |`,
    );
  } else {
    for (const ep of endpoints) {
      const m = ep.trim().match(/^([A-Z]+)\s+(\S+)$/);
      const method = m ? m[1] : "(要確認)";
      const path = m ? m[2] : escTable(ep.trim());
      lines.push(
        `| ${method} | ${escTable(path)} | §3 の対応する機能を参照 | 要(未認証エンドポイントは §7.3 で個別明記) |`,
      );
    }
  }
  lines.push("");

  // §7.2 / §7.3 は API が実在する時だけ出す。以前は未検出でも REST 例・OAuth 等を
  //   固定作文していた(Codex 辛口 #4, #5)。API が無いアプリでは §7.1 の「検出されず」で終わる。
  if (endpoints.length > 0) {
  lines.push("### 7.2 API詳細");
  lines.push("");
  lines.push(
    "- リクエスト例(JSON): `{ \"id\": 123, \"data\": { ... } }`(必須項目は §7.1 の各エンドポイントに準拠)",
  );
  lines.push(
    "- レスポンス例(JSON): `{ \"status\": \"ok\", \"data\": { ... }, \"requestId\": \"<UUID>\" }`",
  );
  lines.push(
    `- ステータスコード: 200 OK / 201 Created / 204 No Content / 400 Bad Request / 401 Unauthorized / 403 Forbidden / 404 Not Found / 409 Conflict / 429 Too Many Requests / 500 Internal Server Error`,
  );
  lines.push(
    "- エラーレスポンス形式: `{ \"error\": { \"code\": \"STRING_CODE\", \"message\": \"人間可読の説明\", \"details\": [...] }, \"requestId\": \"<UUID>\" }`",
  );
  lines.push("");

  lines.push("### 7.3 外部連携");
  lines.push(
    `- 連携先サービス: §5.1 の「外部サービス」欄に列挙された各サービス(連携先毎に契約・SLA を確認)`,
  );
  lines.push(
    `- 認証方式: OAuth 2.0 または API Key。認証情報は環境変数 / Secrets Manager で管理し、コード・設定ファイルへの直書きは禁止`,
  );
  lines.push(
    `- 障害時のフォールバック: 指数バックオフでの自動リトライ(最大 3 回、初回 500ms)。連続失敗時はユーザーに通知し、キャッシュされた最終値を返却。連携先の SLA を Runbook に記載`,
  );
  lines.push("");
  } // API が実在する時だけ §7.2/§7.3 を出す
  lines.push("---");
  lines.push("");

  // ========== 8. 画面設計 ==========
  lines.push("## 8. 画面設計");
  lines.push("");
  lines.push("| 画面ID | 画面名 | 主要素 | 遷移先 |");
  lines.push("|---|---|---|---|");
  for (const n of sortedNodes) {
    const sid = `S-${pad2(n.id)}`;
    const name = pickLocalized(n.label, language);
    const elems = (n.subActions ?? [])
      .slice(0, 4)
      .map((a) => pickLocalized(a, language))
      .join(" / ");
    const outs = (outgoing.get(n.id) ?? [])
      .map((o) => `S-${pad2(o.to)}`)
      .join(", ");
    lines.push(
      `| ${sid} | ${escTable(name)} | ${escTable(elems) || "(表示中心の画面、詳細は §3 の該当機能を参照)"} | ${outs || "-"} |`,
    );
  }
  lines.push("");
  lines.push(
    "各画面で状態別表示(ローディング / 空 / エラー)を定義。ワイヤーフレームは別紙参照可。",
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 9. 異常系・エッジケース ==========
  lines.push("## 9. 異常系・エッジケース");
  lines.push("");
  const edgeCases = screens.context?.edgeCases ?? [];
  if (edgeCases.length > 0) {
    // AI が読み取れた実際のエッジケースを列挙
    for (const ec of edgeCases) {
      lines.push(`- ${ec.replace(/\n/g, " ")}`);
    }
  } else {
    // 検出できない時は、このアプリ(ローカルで動く)で実際に起こる異常系だけを挙げる。
    //   以前は 楽観ロック / 403 / idempotency-key など、サーバー・認証・DB がある前提の
    //   作文だった(Codex 辛口 #6)。
    lines.push("- 入力・フォルダが読めない / 見つからない");
    lines.push("- ファイルが大きすぎる / 数が多すぎて処理しきれない");
    lines.push("- AI 分析に失敗した(応答なし・エラー・タイムアウト)");
    lines.push("- 外部 AI サービスの API キーが未設定 / ネット接続がない");
    if (eng) {
      lines.push(
        "- ※ サーバー・ログイン・DB を持つアプリの場合は、権限外アクセス・同時編集の競合・通信断なども別途検討",
      );
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 10. テスト方針 ==========
  lines.push("## 10. テスト方針");
  lines.push("");
  const testing = screens.context?.testing;
  if (testing) {
    const framework = testing.framework || "(未検出、実装時に選定)";
    const hasNote =
      testing.hasTests === true
        ? "既存テストあり"
        : testing.hasTests === false
          ? "テスト未整備(実装時に整備予定)"
          : "(状態未検出)";
    lines.push(`- テストフレームワーク: \`${framework}\``);
    lines.push(`- 現状: ${hasNote}`);
    lines.push("");
  }
  lines.push("| 種別 | 対象 | 基準 |");
  lines.push("|---|---|---|");
  lines.push(
    `| 単体テスト | 個別関数・コンポーネント | 主要分岐 100%、境界値・エッジケース網羅、CI で自動実行 |`,
  );
  lines.push(
    `| 結合テスト | 画面間の移動・主要な操作の流れ(分析 → 表示、PDF / コピー出力 等) | §2.2 の全ユースケースをカバー、想定エラーで代替フローが動作する |`,
  );
  lines.push(
    `| 受入テスト | エンドユーザー視点の主要シナリオ | 成功条件(1.4)と対応 |`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 11. 開発計画 ==========
  lines.push("## 11. 開発計画");
  lines.push("");
  lines.push("| フェーズ | 内容 | 完了条件 | 期日 |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Phase 1 | MVP 開発(§3 の Must 機能を実装、主要ユースケースを完走可能に) | 想定ユーザーが基本フローを完了できる、受入テスト(§10)合格 | 開発着手から 4 週間 |`,
  );
  lines.push(
    `| Phase 2 | 拡張機能(Should / Could 対応)+ UI 改善 | 全ユースケース網羅、ユーザーテスト完了 | Phase 1 完了から 4 週間 |`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 12. 未決事項 ==========
  lines.push("## 12. 未決事項");
  lines.push("");
  lines.push("| # | 内容 | 決定期限 | 担当 |");
  lines.push("|---|---|---|---|");
  // この仕様書は AI がマップから自動生成したもの。未決事項は「実データ由来で本当に確認が要る」
  //   ことに絞る(以前は消した §4/§5.3/§7.3 を参照する固定作文だった)。
  lines.push(
    `| 1 | 画面名・機能名が、実際のアプリでの呼び方と合っているか | — | — |`,
  );
  lines.push(
    `| 2 | 画面のつながり(遷移)が、実際の操作順と合っているか | — | — |`,
  );
  lines.push(
    `| 3 | 「扱うデータ / 情報」(§6)に、抜け漏れや不要なものがないか | — | — |`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 変更履歴 ==========
  lines.push("## 変更履歴");
  lines.push("");
  lines.push("| 日付 | バージョン | 変更内容 | 変更者 |");
  lines.push("|---|---|---|---|");
  lines.push(`| ${nowIso} | v0.1 | 初版(AppMap 自動生成) | ${authorCell} |`);
  lines.push("");

  // v0.1.8:ノーコード読者モードでは DB 型・制約・優先度を日常語に一括置換
  return simplifyForNoCode(lines.join("\n"), audience);
}
