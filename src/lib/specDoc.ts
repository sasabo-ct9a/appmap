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

export type SpecAudience = "engineer" | "noCode" | "endUser";

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

/**
 * フィールド名から DB 型・制約・説明を推測(v0.1.7 ビジネス用途化)
 * 完全一致・部分一致の順に評価。ハズレの可能性はあるので、ユーザーが後で修正できることが前提。
 */
function guessFieldSpec(field: string): {
  dataType: string;
  constraint: string;
  note: string;
} {
  const f = field.toLowerCase().replace(/[\s`]/g, "");
  // 完全一致優先
  if (f === "id")
    return {
      dataType: "INTEGER / UUID",
      constraint: "PRIMARY KEY, NOT NULL",
      note: "主キー",
    };
  if (f === "created_at" || f === "createdat")
    return {
      dataType: "TIMESTAMP",
      constraint: "NOT NULL, DEFAULT now()",
      note: "作成日時",
    };
  if (f === "updated_at" || f === "updatedat")
    return {
      dataType: "TIMESTAMP",
      constraint: "NOT NULL",
      note: "最終更新日時",
    };
  if (f === "deleted_at" || f === "deletedat")
    return {
      dataType: "TIMESTAMP",
      constraint: "NULL 可",
      note: "論理削除日時(NULL なら未削除)",
    };
  // 部分一致
  if (f.endsWith("_id") || (f.endsWith("id") && f.length > 2))
    return {
      dataType: "INTEGER / UUID",
      constraint: "FOREIGN KEY, NOT NULL",
      note: "関連レコードへの参照キー",
    };
  if (f.endsWith("_at") || f.endsWith("at"))
    return {
      dataType: "TIMESTAMP",
      constraint: "NOT NULL",
      note: "日時",
    };
  if (f.includes("email") || f.includes("mail"))
    return {
      dataType: "VARCHAR(255)",
      constraint: "UNIQUE, NOT NULL",
      note: "メールアドレス",
    };
  if (f.includes("password") || f.includes("passwd"))
    return {
      dataType: "VARCHAR(255)",
      constraint: "NOT NULL",
      note: "ハッシュ化されたパスワード(平文は保存しない)",
    };
  if (f.includes("username") || f.includes("user_name"))
    return {
      dataType: "VARCHAR(50)",
      constraint: "UNIQUE, NOT NULL",
      note: "ユーザー名(表示・ログイン用)",
    };
  if (
    f.startsWith("is_") ||
    f.startsWith("has_") ||
    f === "enabled" ||
    f === "active" ||
    f === "disabled"
  )
    return {
      dataType: "BOOLEAN",
      constraint: "NOT NULL, DEFAULT false",
      note: "真偽フラグ",
    };
  if (f.includes("status") || f.includes("state"))
    return {
      dataType: "VARCHAR(30) / ENUM",
      constraint: "NOT NULL",
      note: "ステータス",
    };
  if (f.includes("type") || f.includes("kind") || f.includes("category"))
    return {
      dataType: "VARCHAR(30)",
      constraint: "NOT NULL",
      note: "種別",
    };
  if (f.includes("price") || f.includes("amount") || f.includes("total"))
    return {
      dataType: "DECIMAL(10, 2)",
      constraint: "NOT NULL",
      note: "金額",
    };
  if (f.includes("count") || f.endsWith("num") || f.includes("_count"))
    return {
      dataType: "INTEGER",
      constraint: "NOT NULL, DEFAULT 0",
      note: "数量",
    };
  if (f.includes("url") || f.includes("link") || f.includes("uri"))
    return {
      dataType: "TEXT",
      constraint: "任意",
      note: "URL",
    };
  if (
    f.includes("body") ||
    f.includes("content") ||
    f.includes("description") ||
    f.includes("note") ||
    f.includes("memo")
  )
    return {
      dataType: "TEXT",
      constraint: "任意",
      note: "本文・説明",
    };
  if (f.includes("name") || f.includes("title") || f.includes("label"))
    return {
      dataType: "VARCHAR(255)",
      constraint: "NOT NULL",
      note: "名称・タイトル",
    };
  if (f.includes("token") || f.includes("secret") || f.includes("apikey"))
    return {
      dataType: "VARCHAR(255)",
      constraint: "NOT NULL",
      note: "認証トークン(暗号化推奨)",
    };
  if (f.includes("image") || f.includes("photo") || f.includes("avatar"))
    return {
      dataType: "TEXT",
      constraint: "任意",
      note: "画像 URL / パス",
    };
  // 汎用
  return {
    dataType: "VARCHAR(255)",
    constraint: "任意",
    note: "業務要件に合わせて設定",
  };
}

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
  void audience;
  const authorName = (opts.authorName ?? "").trim();
  const authorCell = authorName || PH;
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
  const termMap = new Map<string, string>();
  for (const n of sortedNodes) {
    const dataUsed = n.detail.dataUsed ?? [];
    const dataTech = (n.detail.dataTech ?? []).map(normalizeTech);
    const upto = Math.max(dataUsed.length, dataTech.length);
    for (let i = 0; i < upto; i++) {
      const jp =
        i < dataUsed.length ? pickLocalized(dataUsed[i], language) : "";
      const tech = i < dataTech.length ? dataTech[i].name : "";
      if (!jp && !tech) continue;
      const key = jp || tech;
      if (termMap.has(key)) continue;
      const def = tech ? `\`${tech}\`` : "(業務用語、技術的な対応名なし)";
      termMap.set(key, def);
    }
  }
  if (termMap.size === 0) {
    lines.push(
      `| (該当なし) | 分析対象コードから固有の用語は抽出されませんでした。プロジェクト固有の業務用語をここに追記してください。 |`,
    );
  } else {
    for (const [term, def] of termMap) {
      lines.push(`| ${escTable(term)} | ${def} |`);
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
    `- §4 の非機能要件(応答時間・可用性・セキュリティ)を満たすこと`,
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
  lines.push("## 4. 非機能要件");
  lines.push("");
  lines.push("| 項目 | 要件 |");
  lines.push("|---|---|");
  lines.push(
    `| パフォーマンス | 主要操作は 2 秒以内に応答。一覧表示は 100 件で 1 秒以内。バッチ処理は 5,000 件 / 分以上を目安 |`,
  );
  lines.push(
    `| 可用性 | 稼働率 99%(月間ダウンタイム 7 時間以内)。計画メンテナンスは事前告知の上、深夜帯に実施。障害復旧目標(RTO)4 時間 |`,
  );
  lines.push(
    `| セキュリティ | 全通信 HTTPS(TLS 1.2 以上)。パスワードは最低 8 文字・記号必須で保存はハッシュ化。セッション有効期間 24 時間。個人情報は暗号化保管し、アクセスログを 90 日保持 |`,
  );
  lines.push(
    `| スケーラビリティ | 初期想定:同時利用 100 名、データ 10 万件。増加時はステートレスな構成による水平スケール、DB は読取レプリカで分散 |`,
  );
  lines.push(
    `| 保守性 | エラーログは構造化(JSON)形式で 30 日保持。監視ダッシュボードで主要メトリクス(応答時間・エラー率・キュー滞留)を可視化。週次自動バックアップ、保持 90 日 |`,
  );
  lines.push(
    `| 対応環境 | Chrome / Edge / Safari の最新版および 1 世代前。モバイルは iOS 15 以上 / Android 10 以上。デスクトップアプリは Windows 10 以上 / macOS 12 以上 |`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

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
  lines.push("| レイヤー | 技術 | 選定理由 |");
  lines.push("|---|---|---|");
  lines.push(
    `| フロントエンド | ${frontendCell} | エコシステムが成熟、情報量が多く保守しやすい。コンポーネント再利用でUI開発を効率化 |`,
  );
  lines.push(
    `| バックエンド | ${backendCell} | 業務要件・パフォーマンス・保守性のバランスを重視して選定 |`,
  );
  lines.push(
    `| データベース | ${dbCell} | データ規模・参照パターン・トランザクション要件に適合 |`,
  );
  lines.push(
    `| インフラ | クラウドマネージド(AWS / GCP / Azure から選定) | 運用負荷を抑え、需要に応じた拡張性を確保 |`,
  );
  lines.push(
    `| 外部サービス | ${externalList.length > 0 ? externalList.join(" / ") : "(該当なし)"} | 業務要件を短期間で満たすため、自前実装を避けて既存サービスを活用 |`,
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

  lines.push("### 5.3 環境構成");
  lines.push(
    "開発 / ステージング / 本番の分離方針。環境変数はキー名のみ記載。",
  );
  lines.push("");
  lines.push(
    `- 開発環境: ローカル端末上で動作。環境変数は \`.env.local\`。モックデータ / スタブ API を利用可能`,
  );
  lines.push(
    `- ステージング: 本番同構成のクラウド環境。テストデータで受入確認。環境変数は \`.env.staging\`。デプロイは main ブランチマージで自動`,
  );
  lines.push(
    `- 本番環境: クラウド運用、監視・アラート有効。シークレットは Secrets Manager 相当で管理し、コードや設定ファイルには含めない。デプロイは承認フロー経由`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 6. データ設計 ==========
  lines.push("## 6. データ設計");
  lines.push("");
  lines.push("### 6.1 ER図・テーブル定義");
  lines.push("");
  lines.push("| テーブル | カラム | 型 | 制約 | 説明 |");
  lines.push("|---|---|---|---|---|");
  const seenTables = new Set<string>();
  for (const n of sortedNodes) {
    for (const rawT of n.detail.dataTech ?? []) {
      const t = normalizeTech(rawT);
      if (seenTables.has(t.name)) continue;
      seenTables.add(t.name);
      if (t.fields.length === 0) {
        lines.push(
          `| \`${t.name}\` | \`id\` | INTEGER / UUID | PRIMARY KEY, NOT NULL | 主キー(フィールドは分析未検出、実装時に追記) |`,
        );
      } else {
        t.fields.forEach((f, i) => {
          const tableCol = i === 0 ? `\`${t.name}\`` : "";
          const spec = guessFieldSpec(f);
          lines.push(
            `| ${tableCol} | \`${f}\` | ${spec.dataType} | ${spec.constraint} | ${spec.note} |`,
          );
        });
      }
    }
  }
  if (seenTables.size === 0) {
    lines.push(
      `| (該当なし) | — | — | — | 分析対象コード内にデータモデルが検出されませんでした。ローカル状態のみで動作する場合は「該当なし」、DB を利用する場合はこの表に追記してください |`,
    );
  }
  lines.push("");

  lines.push("### 6.2 データライフサイクル");
  lines.push("生成・更新・削除・保持期間。個人情報を含む場合は明記。");
  lines.push("");
  lines.push(
    `- 生成: ユーザーの入力・登録操作、または外部連携(API / インポート)によって生成される`,
  );
  lines.push(
    `- 更新: 所有ユーザーまたは管理者のみが変更可能。重要データは変更履歴(監査ログ)を保持`,
  );
  lines.push(
    `- 削除: 論理削除(deleted_at フラグ)を推奨。物理削除は 90 日後に一括バッチで実施`,
  );
  lines.push(
    `- 保持期間: サービス利用中は無期限。退会後は 90 日以内に匿名化 / 削除(個人情報保護法・GDPR に準拠)`,
  );
  lines.push("");
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
  if (edgeCases.length === 0) {
    lines.push(
      `- ネットワーク断・タイムアウト: 30 秒でタイムアウト。指数バックオフで最大 3 回リトライ。連続失敗時は「オフラインです」と表示して直近のキャッシュを返却`,
    );
    lines.push(
      `- 外部サービス障害時の挙動: 部分縮退で継続可能な機能は維持。連携必須機能はエラー画面へ誘導し、代替手段(サポート連絡先など)を案内`,
    );
    lines.push(
      `- 重複送信・冪等性: 送信ボタンは押下直後に無効化。API はリクエスト単位の idempotency-key を検査して重複を排除`,
    );
    lines.push(
      `- 権限外アクセス: サーバーサイドで再検証(クライアント側のガードは補助)。権限外は 403 と共に汎用エラー画面を表示、機密情報の露出を避ける`,
    );
    lines.push(
      `- 同時編集・競合: 楽観ロック(updated_at 比較)を採用。競合検出時は差分を提示して手動マージを促す`,
    );
  } else {
    // v0.1.7 拡張:AI が読み取れたエッジケースを列挙、既定の観点は後ろに残す
    for (const ec of edgeCases) {
      lines.push(`- ${ec.replace(/\n/g, " ")}`);
    }
    lines.push(`- その他観点(未検証): 権限外アクセス / 同時編集・競合`);
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
    `| 結合テスト | 画面間遷移・API 連携・DB アクセス | §2.2 の全ユースケースをカバー、想定エラーで代替フローが動作する |`,
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
    `| Phase 2 | 拡張機能(Should / Could 対応)+ UI 改善 + 運用整備 | 全ユースケース網羅、ユーザーテスト完了、監視・バックアップ稼働 | Phase 1 完了から 4 週間 |`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ========== 12. 未決事項 ==========
  lines.push("## 12. 未決事項");
  lines.push("");
  lines.push("| # | 内容 | 決定期限 | 担当 |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| 1 | 非機能要件(§4)の具体値精査(想定ユーザー数・データ量に応じた閾値) | Phase 1 開発着手前 | プロダクトオーナー |`,
  );
  lines.push(
    `| 2 | 環境構成(§5.3)の具体的なクラウド事業者・リージョン選定 | Phase 1 開発着手前 | インフラ担当 |`,
  );
  lines.push(
    `| 3 | 外部連携(§7.3)の連携先契約状況・SLA 確認 | 本番リリース前 | プロダクトオーナー |`,
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

  return lines.join("\n");
}
