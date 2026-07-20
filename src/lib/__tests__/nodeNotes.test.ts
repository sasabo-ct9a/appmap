/**
 * v0.1.8:nodeNotes の localStorage IO を検証。
 * ノートが「保存 → 再読込」で欠落せず、空になったらキー掃除される挙動をカバー。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getNote,
  loadAllNotes,
  setNote,
  type NodeNote,
} from "../nodeNotes";

const FOLDER = "C:/fake/project";

beforeEach(() => {
  localStorage.clear();
});

describe("nodeNotes", () => {
  it("returns default empty note when nothing is saved", () => {
    const n = getNote(FOLDER, 1);
    expect(n).toEqual({ tag: null, memo: "" });
  });

  it("saves and reads back a note", () => {
    const note: NodeNote = { tag: "important", memo: "本番前に見直す" };
    setNote(FOLDER, 42, note);
    expect(getNote(FOLDER, 42)).toEqual(note);
  });

  it("keeps notes separated per folder", () => {
    setNote(FOLDER, 1, { tag: "important", memo: "a" });
    setNote("C:/other", 1, { tag: "question", memo: "b" });
    expect(getNote(FOLDER, 1).memo).toBe("a");
    expect(getNote("C:/other", 1).memo).toBe("b");
  });

  it("removes the storage key when all notes become empty", () => {
    setNote(FOLDER, 1, { tag: "important", memo: "x" });
    // 空に上書き → 掃除される
    setNote(FOLDER, 1, { tag: null, memo: "" });
    // 直接 localStorage を覗いてキーが消えていることを確認
    const key = `appmap:nodenotes:v1:${FOLDER}`;
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("loadAllNotes returns a Map keyed by nodeId (number)", () => {
    setNote(FOLDER, 1, { tag: "later", memo: "" });
    setNote(FOLDER, 3, { tag: null, memo: "気になる" });
    const map = loadAllNotes(FOLDER);
    expect(map.size).toBe(2);
    expect(map.get(1)?.tag).toBe("later");
    expect(map.get(3)?.memo).toBe("気になる");
  });

  it("uses the 'sample' bucket when folderPath is null", () => {
    setNote(null, 5, { tag: "reviewed", memo: "ok" });
    expect(getNote(null, 5)).toEqual({ tag: "reviewed", memo: "ok" });
    expect(localStorage.getItem("appmap:nodenotes:v1:sample")).not.toBeNull();
  });
});
