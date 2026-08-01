import { describe, expect, it } from "vitest";
import { buildSpecDoc } from "../specDoc";
import type { ScreenMapResult } from "../claudeCli";
import type { ScreenNode } from "../../types/screen";

/**
 * 仕様書(as-built)の回帰テスト(CLAUDE.md §6.6)。
 *
 * 目的:今日消した「嘘(存在しないシステムの作文)」が、将来の変更で静かに
 * 復活しないよう機械で見張る。以下が崩れたら即失敗する:
 *   1. 捏造ワードが出力に混入しない(両モード)
 *   2. as-built だと名乗っている
 *   3. 正式版は ◐ に「要照合」を伴い、●/◐/▲ 凡例がある
 *   4. やさしい版は ▲(要記入)を出さない / 正式版は出す
 *   5. ● 静的検出は事実に忠実(検出なしを捏造しない・検出は正しく出す)
 */

function node(
  id: number,
  label: string,
  extra: {
    body?: string;
    subActions?: string[];
    dataUsed?: string[];
    isEntryPoint?: boolean;
  } = {},
): ScreenNode {
  return {
    id,
    label,
    isEntryPoint: extra.isEntryPoint,
    subActions: extra.subActions,
    position: { x: 0, y: 0 },
    detail: {
      title: label,
      body: extra.body ?? "",
      bodyNoCode: "",
      dataUsed: extra.dataUsed,
    },
  };
}

// ローカルで完結するアプリ(サーバー・API・DB・テスト無し)。非エンジニアの典型例。
const localApp: ScreenMapResult = {
  nodes: [
    node(1, "ホーム", {
      isEntryPoint: true,
      body: "メニューを選ぶ画面",
      subActions: ["メニューを見る", "予約を始める"],
      dataUsed: ["メニュー", "予約情報"],
    }),
    node(2, "予約フォーム", {
      body: "日時を選んで予約する",
      subActions: ["日時を選ぶ", "送信する"],
      dataUsed: ["予約情報"],
    }),
    node(3, "完了", { body: "予約完了を表示する" }),
  ],
  edges: [
    { id: "1-2", from: 1, to: 2 },
    { id: "2-3", from: 2, to: 3 },
  ],
  appSummary: "これは予約受付アプリです。メニューを選び日時を指定して予約します。",
  // context 無し = API / DB / テスト未検出のローカルアプリ
};

// 技術・テスト・API が検出できたアプリ(● 静的検出パスの確認用)。
const withContext: ScreenMapResult = {
  nodes: [node(1, "ダッシュボード", { isEntryPoint: true, dataUsed: ["ユーザー情報"] })],
  edges: [],
  appSummary: "分析結果を表示するダッシュボードです。",
  context: {
    techStack: { frontend: "React + TypeScript", backend: "Rust" },
    testing: { framework: "vitest", hasTests: true },
    apiEndpoints: ["POST /api/analyze"],
    edgeCases: ["ネットワーク断時のリトライ"],
  },
};

// 撤去した作文にしか現れない語。実データからは絶対に出ない = 混入したら回帰。
const FABRICATION = [
  "運用担当者", // §2.1 管理者権限の作文
  "OAuth",
  "idempotency",
  "楽観ロック",
  "MoSCoW", // 優先度の作文
  "稼働率",
  "Secrets Manager",
  "指数バックオフ",
  "監視系へ通知", // §3.x エラー挙動の作文
  "ハッシュ化されたパスワード", // guessFieldSpec の作文
];

const build = (screens: ScreenMapResult, audience: "noCode" | "engineer") =>
  buildSpecDoc({ screens, audience, language: "ja", folderPath: null, authorName: "" });

describe("buildSpecDoc(as-built 回帰テスト)", () => {
  it("捏造ワードを一切出力しない(両モード・両サンプル)", () => {
    for (const screens of [localApp, withContext]) {
      for (const audience of ["noCode", "engineer"] as const) {
        const md = build(screens, audience);
        for (const bad of FABRICATION) {
          expect(md, `${audience} 版に捏造ワード「${bad}」が混入`).not.toContain(
            bad,
          );
        }
      }
    }
  });

  it("as-built(実装仕様)だと名乗る", () => {
    expect(build(localApp, "noCode")).toContain("as-built");
    expect(build(localApp, "engineer")).toContain("as-built");
  });

  it("正式版は ◐ に『要照合』を伴い、●/◐/▲ の凡例を持つ", () => {
    const md = build(localApp, "engineer");
    expect(md).toContain("◐");
    expect(md).toContain("要照合");
    expect(md).toContain("●");
    expect(md).toContain("▲");
  });

  it("やさしい版は ▲(要記入)を出さない / 正式版は出す", () => {
    const simple = build(localApp, "noCode");
    expect(simple).not.toContain("▲");
    expect(simple).not.toContain("要記入");

    const formal = build(localApp, "engineer");
    expect(formal).toContain("▲");
    expect(formal).toContain("要記入");
  });

  it("● 静的検出は事実に忠実(検出なしを捏造せず、検出は正しく出す)", () => {
    // API 無しのローカルアプリ → 「検出されませんでした」、テスト不明 → 「不明」
    const local = build(localApp, "engineer");
    expect(local).toContain("検出されませんでした");
    expect(local).toContain("自動テスト: **不明**");

    // 検出できたアプリ → テストあり・エンドポイントを正しく反映
    const ctx = build(withContext, "engineer");
    expect(ctx).toContain("自動テスト: **あり**");
    expect(ctx).toContain("/api/analyze");
  });
});
