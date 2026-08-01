import type { ScreenNode, ScreenEdge } from "../types/screen";
import type { ScreenMapResult } from "./claudeCli";
import { pickLocalized, type Language } from "./i18n";

/**
 * 出来上がったマップから「実装仕様書(as-built)」を Markdown で組み立てる。
 *
 * as-built = 完成したコードから起こした「実際に何が出来たか」の仕様。要件定義
 * (as-planned = 何を作る"つもり"か)とは別物で、AppMap は as-built 側だけを作る。
 * 用途:理解 / 共有・プレゼン / 要件定義との突き合わせ / 納品(CLAUDE.md §6.6)。
 *
 * 信頼性マーカー(§6.6。ここが崩れると納品物の虚偽になる):
 *   ● 確定  … 静的検出の事実(使用技術・テスト有無・外部連携)。ほぼ間違えない。
 *   ◐ AI解析 … AI がコードを読み取った内容(要素・遷移・操作・データ)。実物と要照合。
 *   ▲ 要記入 … コードからは不明(非機能・意図・インフラ)。捏造せず記入欄にする。
 *
 * 2 モード:
 *   - noCode   = やさしい版(理解・共有)。◐/● の章だけ平易に、▲ は隠す。
 *   - engineer = 正式版(納品・突き合わせ)。全章 + ●/◐/▲ マーカー + 但し書き。
 */

export type SpecAudience = "engineer" | "noCode";

type BuildOptions = {
  screens: ScreenMapResult;
  audience: SpecAudience;
  language: Language;
  folderPath: string | null;
  /** モーダルで入力された作成者名(空なら ＿＿＿＿ にフォールバック) */
  authorName?: string;
};

// 信頼性マーカー(CLAUDE.md §6.6)
const MARK = { confirmed: "●", ai: "◐", fill: "▲" } as const;

const PH = "＿＿＿＿"; // 作成者名の未入力時プレースホルダ

function indexEdges(edges: ScreenEdge[]): {
  outgoing: Map<number, Array<{ to: number; bidi: boolean }>>;
} {
  const outgoing = new Map<number, Array<{ to: number; bidi: boolean }>>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push({ to: e.to, bidi: !!e.bidirectional });
  }
  return { outgoing };
}

function indexNodes(nodes: ScreenNode[]): Map<number, ScreenNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function escTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** dataTech の要素を名前だけに正規化(参考表示用。型・制約は推測せず捏造しない) */
function normalizeTechName(
  t: string | { name: string; fields?: string[] },
): string {
  return typeof t === "string" ? t : t.name;
}

/**
 * 技術スタックを file 拡張子から検出する(● 静的検出)。
 * 見つからない層は「(未検出)」を返し、呼び出し側で表に載せない。
 */
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
    frontend: frontend.join(" / ") || "(未検出)",
    backend: backend.join(" / ") || "(未検出)",
    db: db.join(" / ") || "(未検出)",
    extra,
  };
}

const isDetected = (v?: string): boolean =>
  !!v && !v.includes("未検出") && !v.includes("該当なし");

export function buildSpecDoc(opts: BuildOptions): string {
  const { screens, audience, language, folderPath } = opts;
  const authorName = (opts.authorName ?? "").trim();
  const authorCell = authorName || PH;
  // engineer = 正式版(納品・突き合わせ)。noCode = やさしい版。
  const eng = audience === "engineer";
  const audienceLabel = eng
    ? "正式版(納品・突き合わせ用)"
    : "やさしい版(理解・共有用)";

  const { outgoing } = indexEdges(screens.edges);
  const nodeById = indexNodes(screens.nodes);
  const nowIso = today();
  const appName = folderPath
    ? folderPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "アプリ"
    : language === "ja"
      ? "アプリ"
      : "App";

  // 並び:主フロー(depth 0)→ 深い層。同 depth 内は id 順で安定。
  const sortedNodes = [...screens.nodes].sort((a, b) => {
    const da = a.depth ?? 0;
    const db = b.depth ?? 0;
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  const L: string[] = [];
  // 章番号は「出した章だけ」で連番にする(やさしい版は ▲ 章を出さないので飛ばない)。
  let sec = 0;
  const H = (title: string, marker: string) => {
    sec += 1;
    L.push(eng ? `## ${sec}. ${title}  ${marker}` : `## ${sec}. ${title}`);
  };

  // ========== ヘッダー + as-built 宣言 ==========
  L.push(`# ${appName} 実装仕様書(as-built)`);
  L.push("");
  L.push(`- 作成者: ${authorCell}`);
  L.push(`- 最終更新: ${nowIso}`);
  L.push(`- 版: ${audienceLabel}`);
  L.push("");
  if (eng) {
    L.push(
      "> **この仕様書について** — 完成したコードから AppMap が自動で起こした **実装仕様(as-built)** です。「これから作る計画(要件定義)」とは別物で、要件定義と見比べる / 納品物の実態を示す用途に使えます。",
    );
    L.push("> ");
    L.push(
      "> **記号**:**●** コードから確認できた事実 / **◐** AI がコードを読み取った内容(**実物と要照合**)/ **▲** コードからは分からない項目(**要記入**・要件定義から転記)",
    );
    L.push("> ");
    L.push(
      "> ◐ は AI の読み取りなので、提出・納品前に必ず実物と照合してください。",
    );
  } else {
    L.push(
      "> このアプリのコードから自動で作った「実際の中身」の説明です。要素やデータは AI が読み取ったものなので、念のため実物と見比べてください。",
    );
  }
  L.push("");
  L.push("---");
  L.push("");

  // ========== 1. 概要・目的(◐ + ▲) ==========
  H("概要・目的", MARK.ai);
  L.push("");
  const summary = screens.appSummary
    ? pickLocalized(screens.appSummary, language)
    : "";
  L.push(
    summary ||
      "（自動の要約は作れませんでした。このアプリが何をするものかを 1〜2 行で書いてください。）",
  );
  L.push("");
  if (eng) {
    L.push(`### 背景・目的  ${MARK.fill}`);
    L.push(
      "なぜ作ったか / 誰のためか。コードからは分からないので、要件定義から転記してください。",
    );
    L.push("");
  }
  L.push("---");
  L.push("");

  // ========== 2. 機能要件(要素と操作)(◐) ==========
  // 要素設計と機能要件は同じ「要素」情報なので 1 表にまとめる。
  H("機能要件(要素と操作)", MARK.ai);
  L.push("");
  L.push(
    eng
      ? "AI がコードから読み取った要素と、各要素でできることの一覧です(**実物と要照合**)。"
      : "アプリにある要素と、それぞれで何ができるかの一覧です。",
  );
  L.push("");
  L.push("| 要素 | 何をする要素か | 主な操作 | 遷移先 |");
  L.push("|---|---|---|---|");
  for (const n of sortedNodes) {
    const name = pickLocalized(n.label, language);
    const intent = pickLocalized(
      n.userIntent ?? n.detail.body ?? n.label,
      language,
    );
    const desc = escTable(intent).slice(0, 60);
    const acts = (n.subActions ?? [])
      .slice(0, 4)
      .map((a) => pickLocalized(a, language))
      .join(" / ");
    const outs = (outgoing.get(n.id) ?? [])
      .map((o) => pickLocalized(nodeById.get(o.to)?.label ?? "", language))
      .filter(Boolean)
      .join(" / ");
    L.push(
      `| ${escTable(name)} | ${desc || "-"} | ${escTable(acts) || "(表示中心の要素)"} | ${escTable(outs) || "-"} |`,
    );
  }
  L.push("");
  L.push("---");
  L.push("");

  // ========== 3. 要素遷移・主な流れ(◐) ==========
  H("要素遷移・主な流れ", MARK.ai);
  L.push("");
  if (screens.edges.length > 0) {
    L.push(
      eng
        ? "AI が読み取った要素のつながり(**実物と要照合**):"
        : "要素のつながり:",
    );
    L.push("");
    L.push("```mermaid");
    L.push("graph TD");
    for (const n of sortedNodes) {
      const label = pickLocalized(n.label, language)
        .replace(/"/g, "'")
        .slice(0, 20);
      L.push(`  N${n.id}["${label}"]`);
    }
    for (const e of screens.edges) {
      const arrow = e.bidirectional ? "<-->" : "-->";
      L.push(`  N${e.from} ${arrow} N${e.to}`);
    }
    L.push("```");
  } else {
    L.push(
      "要素のつながりは検出されませんでした(単一要素のアプリか、遷移が読み取れなかった可能性)。",
    );
  }
  L.push("");
  L.push("---");
  L.push("");

  // ========== 4. 扱うデータ / 情報(◐ + ▲) ==========
  H("扱うデータ / 情報", eng ? `${MARK.ai} / ${MARK.fill}` : MARK.ai);
  L.push("");
  const infoTerms = new Set<string>();
  for (const n of sortedNodes) {
    for (const d of n.detail.dataUsed ?? []) {
      const jp = pickLocalized(d, language).trim();
      if (jp) infoTerms.add(jp);
    }
  }
  if (infoTerms.size > 0) {
    L.push(
      eng
        ? "AI が読み取った、このアプリが扱う情報(**実物と要照合**):"
        : "このアプリが扱う情報:",
    );
    L.push("");
    for (const term of infoTerms) L.push(`- ${term}`);
  } else {
    L.push(
      "扱う情報は特定できませんでした。各要素で入力・表示・保存する情報をここに追記してください。",
    );
  }
  L.push("");
  if (eng) {
    // 内部データ構造の「名前」だけ参考掲載。型・主キー・暗号化などは推測せず出さない。
    const techNames = new Set<string>();
    for (const n of sortedNodes) {
      for (const rawT of n.detail.dataTech ?? []) {
        techNames.add(normalizeTechName(rawT));
      }
    }
    if (techNames.size > 0) {
      L.push("参考:アプリ内部で扱うデータ構造の名前(DB とは限りません):");
      L.push("");
      for (const t of techNames) L.push(`- \`${t}\``);
      L.push("");
    }
    L.push(
      `各データ項目の詳細(型・必須・制約)は ${MARK.fill} 要記入。DB を使う場合はスキーマを、使わない場合は扱う項目を記載してください。`,
    );
    L.push("");
  }
  L.push("---");
  L.push("");

  // ========== 5. 使用技術・構成(● + ▲) ==========
  H("使用技術・構成", eng ? `${MARK.confirmed} / ${MARK.fill}` : MARK.confirmed);
  L.push("");
  const allFiles = sortedNodes.flatMap((n) => n.detail.files ?? []);
  const stackDetected = detectStack(allFiles);
  const ctxStack = screens.context?.techStack;
  const frontendCell = ctxStack?.frontend || stackDetected.frontend;
  const backendCell = ctxStack?.backend || stackDetected.backend;
  const dbCell = ctxStack?.db || stackDetected.db;
  const externalList =
    ctxStack?.external && ctxStack.external.length > 0
      ? ctxStack.external
      : stackDetected.extra;
  const stackRows: string[] = [];
  if (isDetected(frontendCell))
    stackRows.push(`| フロントエンド / アプリ | ${frontendCell} |`);
  if (isDetected(backendCell))
    stackRows.push(`| バックエンド | ${backendCell} |`);
  if (isDetected(dbCell)) stackRows.push(`| データベース | ${dbCell} |`);
  if (externalList.length > 0)
    stackRows.push(`| 外部サービス | ${externalList.join(" / ")} |`);
  if (stackRows.length > 0) {
    L.push("コードから検出できた技術:");
    L.push("");
    L.push("| レイヤー | 技術 |");
    L.push("|---|---|");
    for (const r of stackRows) L.push(r);
    L.push("");
    L.push(
      "※ 上記に無い層はコードから検出されていません(ローカルで完結するアプリでは通常空です)。",
    );
  } else {
    L.push(
      "コードからは技術スタックを特定できませんでした。使っている言語・ツールを記入してください。",
    );
  }
  L.push("");
  if (eng) {
    L.push(`### インフラ・環境構成  ${MARK.fill}`);
    L.push(
      "サーバー / クラウドの有無、開発・本番の分け方、秘密情報(API キー等)の保管場所は、使う場合のみ記入。ローカルだけで動くアプリなら該当なしです。",
    );
    L.push("");
  }
  L.push("---");
  L.push("");

  // ========== 6. 外部連携(API 等)(●) ==========
  // 検出できたエンドポイントだけを出す。リクエスト例・OAuth 等はコードから断定できないので出さない。
  const endpoints = screens.context?.apiEndpoints ?? [];
  if (eng || endpoints.length > 0) {
    H("外部連携(API 等)", MARK.confirmed);
    L.push("");
    if (endpoints.length === 0) {
      L.push(
        "外部 API との連携はコードから検出されませんでした(アプリ内で完結、または API を使っていない)。使っている場合は連携先を追記してください。",
      );
    } else {
      L.push("コードから検出した外部 API:");
      L.push("");
      L.push("| メソッド | パス |");
      L.push("|---|---|");
      for (const ep of endpoints) {
        const m = ep.trim().match(/^([A-Z]+)\s+(\S+)$/);
        const method = m ? m[1] : "-";
        const path = m ? m[2] : ep.trim();
        L.push(`| ${method} | ${escTable(path)} |`);
      }
      L.push("");
      L.push(
        "※ 認証方式やリクエストの中身はコードからは断定できません。必要なら実装を確認して補記してください。",
      );
    }
    L.push("");
    L.push("---");
    L.push("");
  }

  // ========== 7. 非機能要件(▲・正式版のみ) ==========
  if (eng) {
    H("非機能要件(性能・セキュリティ)", MARK.fill);
    L.push("");
    L.push(
      "コードからは確認できない運用の観点です。**このアプリに当てはまるものだけ**値を決めて記入してください(要件定義から転記)。該当しない項目は削除。",
    );
    L.push("");
    L.push("- パフォーマンス: 主要操作の目標応答時間、扱うデータ量の目安");
    L.push("- 対応環境: 動作対象の OS / ブラウザ");
    L.push(
      "- セキュリティ: 秘密情報(API キー等)の保管方法、外部に送るデータの扱い。サーバー / ログイン / DB がある場合は通信の暗号化・認証・個人情報保護も",
    );
    L.push("- 可用性 / 保守性: 障害時の挙動、ログ、バックアップ(必要な場合のみ)");
    L.push("");
    L.push("---");
    L.push("");
  }

  // ========== 8. 異常系(◐ 検出時 / ▲ 観点) ==========
  const edgeCases = screens.context?.edgeCases ?? [];
  if (eng || edgeCases.length > 0) {
    H("異常系", edgeCases.length > 0 ? MARK.ai : MARK.fill);
    L.push("");
    if (edgeCases.length > 0) {
      L.push(
        eng
          ? "AI が読み取った異常系(**実物と要照合**):"
          : "気をつけたい場面:",
      );
      L.push("");
      for (const ec of edgeCases) L.push(`- ${ec.replace(/\n/g, " ")}`);
    } else {
      // ここに到達するのは eng のみ(noCode は edgeCases 無しなら §8 を出さない)。
      L.push(
        "コードからは読み取れませんでした。以下の観点で、このアプリに当てはめて記入してください:",
      );
      L.push("");
      L.push("- 入力を間違えたとき(空欄 / 長すぎ / 記号)、どう知らせるか");
      L.push("- データがまだ無い・見つからないとき、何を表示するか");
      L.push("- 動作が遅い・止まったとき、ユーザーにどう伝わるか");
      L.push("- 同じボタンの連打・「戻る」でおかしくならないか");
      L.push(
        "- (サーバー・ログイン・DB があるなら)権限外アクセス・同時編集の競合・通信断",
      );
    }
    L.push("");
    L.push("---");
    L.push("");
  }

  // ========== 9. テスト(● 有無 + ▲ 方針) ==========
  H("テスト", eng ? `${MARK.confirmed} / ${MARK.fill}` : MARK.confirmed);
  L.push("");
  const testing = screens.context?.testing;
  const hasTests = testing?.hasTests;
  const testState =
    hasTests === true ? "あり" : hasTests === false ? "なし" : "不明";
  L.push(
    `- 自動テスト: **${testState}**${testing?.framework ? `(${testing.framework})` : ""}`,
  );
  L.push("");
  if (eng) {
    L.push(`テストの方針(どこまで確認するか)は ${MARK.fill} 要記入。`);
    L.push("");
  } else if (hasTests !== true) {
    L.push(
      "※ 自動テストがあると、直したときに壊れていないか自動で確認できます。AI コーディングツールに「テストを 1 件書いて」と頼むのがおすすめです。",
    );
    L.push("");
  }
  L.push("---");
  L.push("");

  // ========== 10. 制約・前提・未確定 / 確認してほしいこと(◐ + ▲) ==========
  H(
    eng ? "制約・前提・未確定" : "確認してほしいこと",
    eng ? `${MARK.ai} / ${MARK.fill}` : MARK.ai,
  );
  L.push("");
  L.push(
    eng
      ? "◐(AI 解析)の項目は、提出前に実物と照合してください。特に:"
      : "この仕様書は AI がコードから作っています。次の点を実物と見比べてください:",
  );
  L.push("");
  L.push("- 要素名・機能名が、実際のアプリでの呼び方と合っているか");
  L.push("- 要素のつながり(遷移)が、実際の操作順と合っているか");
  L.push("- 「扱うデータ / 情報」に、抜け漏れや不要なものがないか");
  L.push("");
  if (eng) {
    L.push(
      `その他の制約・前提(対応環境の限定、法令・社内規定、運用上の決まり等)は ${MARK.fill} 要記入(要件定義から転記)。`,
    );
    L.push("");
  }
  L.push("---");
  L.push("");

  // ========== 変更履歴(正式版のみ・納品用) ==========
  if (eng) {
    L.push("## 変更履歴");
    L.push("");
    L.push("| 日付 | 版 | 変更内容 | 変更者 |");
    L.push("|---|---|---|---|");
    L.push(
      `| ${nowIso} | v0.1 | 初版(AppMap 自動生成 as-built) | ${authorCell} |`,
    );
    L.push("");
  }

  return L.join("\n");
}
