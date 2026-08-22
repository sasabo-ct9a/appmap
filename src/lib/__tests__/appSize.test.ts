import { describe, it, expect } from "vitest";
import { isLargeApp, LARGE_APP_FILE_THRESHOLD } from "../appSize";

describe("isLargeApp", () => {
  it("しきい値ちょうどは大きいアプリ扱い", () => {
    expect(isLargeApp(LARGE_APP_FILE_THRESHOLD)).toBe(true);
  });

  it("しきい値未満は小さいアプリ扱い", () => {
    expect(isLargeApp(LARGE_APP_FILE_THRESHOLD - 1)).toBe(false);
  });

  it("null / undefined は false(未取得時に注意書きを出さない)", () => {
    expect(isLargeApp(null)).toBe(false);
    expect(isLargeApp(undefined)).toBe(false);
  });
});
