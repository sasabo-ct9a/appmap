/**
 * v0.1.8 追加:ノード単位の付箋(タグ + メモ)を localStorage で管理。
 *
 * 設計:
 *   - フォルダパス(分析対象)× ノード ID をキー
 *   - タグは 4 択(later / important / question / reviewed)+ null
 *   - メモは自由記述
 *   - どちらも空(タグ null かつ memo 空)ならエントリを消す(掃除)
 *
 * 保存キー:`appmap:nodenotes:v1:{folderPath}` → `{ [nodeId]: {tag, memo} }`
 * フォルダなし(サンプル)は `appmap:nodenotes:v1:sample`
 */

export type NodeTag = "later" | "important" | "question" | "reviewed";
export type NodeNote = {
  /** null = タグなし */
  tag: NodeTag | null;
  /** 自由記述、trim せずそのまま保存 */
  memo: string;
};

/** キー生成の一箇所化。folderPath が null ならサンプル用の固定キー */
function keyFor(folderPath: string | null): string {
  return folderPath
    ? `appmap:nodenotes:v1:${folderPath}`
    : "appmap:nodenotes:v1:sample";
}

/** 保存形式:`{ "3": {tag: "important", memo: "..."} }` */
type StoredNotes = Record<string, NodeNote>;

function readAll(folderPath: string | null): StoredNotes {
  try {
    const raw = localStorage.getItem(keyFor(folderPath));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as StoredNotes;
    return {};
  } catch {
    return {};
  }
}

function writeAll(folderPath: string | null, notes: StoredNotes): void {
  try {
    // 空エントリは掃除する
    const cleaned: StoredNotes = {};
    for (const [id, note] of Object.entries(notes)) {
      if (note.tag === null && !note.memo) continue;
      cleaned[id] = note;
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(keyFor(folderPath));
      return;
    }
    localStorage.setItem(keyFor(folderPath), JSON.stringify(cleaned));
  } catch {
    // storage full 時は諦める
  }
}

/** 1 ノードの付箋を取得。無ければ空のデフォルトを返す(null 判定を呼び出し側に強いない)*/
export function getNote(
  folderPath: string | null,
  nodeId: number,
): NodeNote {
  const all = readAll(folderPath);
  return all[String(nodeId)] ?? { tag: null, memo: "" };
}

/** 1 ノードの付箋を上書き。空なら削除。*/
export function setNote(
  folderPath: string | null,
  nodeId: number,
  note: NodeNote,
): void {
  const all = readAll(folderPath);
  all[String(nodeId)] = note;
  writeAll(folderPath, all);
}

/** 特定フォルダの全付箋を Map で返す(MapCanvas 側の一括バッジ判定用)*/
export function loadAllNotes(
  folderPath: string | null,
): Map<number, NodeNote> {
  const all = readAll(folderPath);
  const map = new Map<number, NodeNote>();
  for (const [id, note] of Object.entries(all)) {
    const n = Number(id);
    if (Number.isFinite(n)) map.set(n, note);
  }
  return map;
}
