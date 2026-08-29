import { describe, expect, it } from "vitest";
import {
  buildAppContext,
  buildElementContext,
  buildGeneratePrompt,
} from "../createContext";
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
  it("要素・入口・つながり・データを 1 行ずつ並べ、◐ 但し書きを付ける", () => {
    const m = map(
      [
        node(1, "天気表示", { entry: true, data: ["天気", "地域"] }),
        node(2, "設定", { data: ["地域"] }),
      ],
      [edge(1, 2)],
    );
    const out = buildAppContext(m, "ja");
    // ◐(AI 解析なので誤り得る)を確定情報に見せないための但し書きは必須。
    expect(out).toContain("実物のコードを正として");
    expect(out).toContain("- 天気表示【最初に見る画面】 → つながり: 設定");
    expect(out).toContain("扱うデータ: 天気, 地域");
    // 入口でない要素に入口マークは付かない。
    expect(out).toContain("- 設定 → つながり: なし");
  });

  it("双方向エッジは両側から辿れる", () => {
    const m = map(
      [node(1, "一覧"), node(2, "詳細")],
      [edge(1, 2, true)],
    );
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
});

describe("buildElementContext", () => {
  it("指した要素の役割・データ・つながり・ファイルと「まずここを」を出す", () => {
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
    expect(out).toContain("いま指している部分:「天気表示」");
    expect(out).toContain("ここでの操作: 天気を見る");
    expect(out).toContain("役割(参考): 現在地の天気");
    expect(out).toContain("扱うデータ: 天気");
    expect(out).toContain("つながり: 設定");
    expect(out).toContain("関係ファイル(参考): src/App.tsx");
    expect(out).toContain("まずここを対象に直してください");
  });

  it("長い役割本文は丸める(プロンプトを膨らませない)", () => {
    const long = "あ".repeat(400);
    const m = map([node(1, "画面", { body: long })], []);
    const out = buildElementContext(m.nodes[0], m, "ja");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(long.length);
  });
});

describe("buildGeneratePrompt", () => {
  it("文脈なしなら従来と同じ本文だけを返す(初回の挙動を変えない)", () => {
    const out = buildGeneratePrompt({ instruction: "天気アプリ" });
    expect(out).toBe(
      "この Vite + React アプリを、次の要望に沿って作ってください:「天気アプリ」。" +
        "src/App.tsx を中心に実装し、日本語 UI、シンプルで見やすいインラインスタイルに。" +
        "React の useState だけで動く範囲で作る。Vite+React の構成は変えない。" +
        "npm パッケージは追加しない。",
    );
  });

  it("要素文脈を本文の直後、全体像を後ろに置く", () => {
    const out = buildGeneratePrompt({
      instruction: "色を変えて",
      appContext: "APP_CONTEXT",
      elementContext: "ELEMENT_CONTEXT",
    });
    const iInstr = out.indexOf("色を変えて");
    const iElem = out.indexOf("ELEMENT_CONTEXT");
    const iApp = out.indexOf("APP_CONTEXT");
    expect(iInstr).toBeGreaterThanOrEqual(0);
    expect(iElem).toBeGreaterThan(iInstr);
    expect(iApp).toBeGreaterThan(iElem);
  });
});
