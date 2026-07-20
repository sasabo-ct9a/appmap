/**
 * v0.1.8:テスト基盤の疎通確認。
 * これが失敗する時は vitest / jsdom / setup 全体が壊れているサイン。
 */
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs vitest at all", () => {
    expect(true).toBe(true);
  });

  it("has jsdom document available", () => {
    expect(typeof document).toBe("object");
    const div = document.createElement("div");
    div.textContent = "hello";
    expect(div.textContent).toBe("hello");
  });

  it("has localStorage available (jsdom)", () => {
    localStorage.setItem("smoke-key", "value");
    expect(localStorage.getItem("smoke-key")).toBe("value");
    localStorage.removeItem("smoke-key");
  });
});
