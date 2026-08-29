import { describe, expect, it } from "vitest";
import {
  buildAppContext,
  buildElementContext,
  buildHandoffPrompt,
} from "../claudeHandoff";
import type { ScreenMapResult } from "../claudeCli";
import type { ScreenNode, ScreenEdge } from "../../types/screen";

function node(
  id: number,
  label: string,
  opts: {
    entry?: boolean;
    intent?: string;
    body?: string;
    data?: string[];
    files?: string[];
  } = {},
): ScreenNode {
  return {
    id,
    label,
    isEntryPoint: opts.entry,
    userIntent: opts.intent,
    position: { x: 0, y: 0 },
    detail: {
      title: label,
      body: opts.body ?? "",
      bodyNoCode: "",
      dataUsed: opts.data,
      files: opts.files,
    },
  };
}
function edge(from: number, to: number, bidi = false): ScreenEdge {
  return { id: `${from}-${to}`, from, to, bidirectional: bidi };
}
function map(nodes: ScreenNode[], edges: ScreenEdge[]): ScreenMapResult {
  return { nodes, edges };
}

describe("buildAppContext", () => {
  it("要素・入口・つながり・データを 1 行ずつ並べる", () => {
    const m = map(
      [
        node(1, "天気表示", { entry: true, data: ["天気", "地域"] }),
        node(2, "設定", { data: ["地域"] }),
      ],
      [edge(1, 2)],
    );
    const out = buildAppContext(m, "ja");
    expect(out).toContain("- 天気表示【最初に見る画面】 → つながり: 設定");
    expect(out).toContain("扱うデータ: 天気, 地域");
    expect(out).toContain("- 設定 → つながり: なし");
  });

  it("双方向エッジは両側から辿れる", () => {
    const m = map([node(1, "一覧"), node(2, "詳細")], [edge(1, 2, true)]);
    const out = buildAppContext(m, "ja");
    expect(out).toContain("- 一覧 → つながり: 詳細");
    expect(out).toContain("- 詳細 → つながり: 一覧");
  });

  it("appSummary があれば概要を含める", () => {
    const m: ScreenMapResult = {
      nodes: [node(1, "天気表示", { entry: true })],
      edges: [],
      appSummary: "天気を見るアプリ",
    };
    expect(buildAppContext(m, "ja")).toContain("概要: 天気を見るアプリ");
  });

  it("構造要約は事実だけ持ち、注意書き(◐)は付けない", () => {
    // 注意書きは buildHandoffPrompt が 1 回だけ付ける。ここで重複させない。
    const m = map([node(1, "画面")], []);
    expect(buildAppContext(m, "ja")).not.toContain("実物のコードを正として");
  });
});

describe("buildElementContext", () => {
  it("対象要素の役割・データ・つながり・ファイルを出す", () => {
    const m = map(
      [
        node(1, "天気表示", {
          intent: "天気を見る",
          body: "現在地の天気を API から取得して表示する画面。",
          data: ["天気"],
          files: ["src/App.tsx"],
        }),
        node(2, "設定"),
      ],
      [edge(1, 2)],
    );
    const out = buildElementContext(m.nodes[0], m, "ja");
    expect(out).toContain("対象の要素:「天気表示」");
    expect(out).toContain("ここでの操作: 天気を見る");
    expect(out).toContain("役割: 現在地の天気");
    expect(out).toContain("扱うデータ: 天気");
    expect(out).toContain("つながり: 設定");
    expect(out).toContain("関係ファイル: src/App.tsx");
  });

  it("長い役割本文は丸める(貼り付けを膨らませない)", () => {
    const long = "あ".repeat(400);
    const m = map([node(1, "画面", { body: long })], []);
    const out = buildElementContext(m.nodes[0], m, "ja");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(long.length);
  });
});

describe("buildHandoffPrompt", () => {
  it("やりたいこと(指示)を主役に置き、参考に注意書きを 1 回付ける", () => {
    const out = buildHandoffPrompt({
      instruction: "ボタンの色を青にして",
      elementContext: "ELEMENT",
      appContext: "APP",
    });
    expect(out).toContain("【やりたいこと】");
    expect(out).toContain("ボタンの色を青にして");
    // ◐ の注意書きは 1 回だけ。
    expect(out.split("実物のコードを正として").length - 1).toBe(1);
    const iInstr = out.indexOf("ボタンの色を青にして");
    const iRef = out.indexOf("【参考");
    expect(iRef).toBeGreaterThan(iInstr);
    expect(out.indexOf("ELEMENT")).toBeGreaterThan(iRef);
  });

  it("指示だけでも成立し、参考が無ければ注意書きも出さない", () => {
    const out = buildHandoffPrompt({ instruction: "全体を明るい配色に" });
    expect(out).toContain("全体を明るい配色に");
    expect(out).not.toContain("【参考");
    expect(out).not.toContain("実物のコードを正として");
  });
});
