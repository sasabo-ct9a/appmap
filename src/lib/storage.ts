import type { ScreenMapResult } from "./claudeCli";
import type { Language } from "./i18n";
import { asLanguage } from "./i18n";

/**
 * 分析結果の localStorage 永続化(Phase 3 Step 機能拡張 A)。
 *
 * 目的:
 *   - 再起動で AI 結果が消えないようにする(再分析の $ がかからない)
 *   - 複数フォルダの履歴を持って切り替えられるようにする
 *   - 直前に見ていたものを次回起動で復元
 *
 * 設計:
 *   - 単一キー `appmap.v1` に全部 JSON で保存(シンプル、フォーマット変更時は
 *     version をインクリメント)
 *   - 履歴は最大 MAX_HISTORY 件、新しいものを先頭に
 *   - currentFolderPath は「次回起動時に復元するフォルダ」を指す。null なら
 *     サンプルマップで起動
 *
 * Tauri デスクトップアプリなので localStorage はユーザーごとに分離されており、
 * 5MB 程度の容量制限内に収まる(1 件 ~5KB × 20 件 = 100KB 程度)。
 */

const STORAGE_KEY = "appmap.v1";
const MAX_HISTORY = 20;

export type StoredAnalysis = {
  folderPath: string;
  fileCount: number | null;
  screens: ScreenMapResult;
  costUsd: number | null;
  durationMs: number | null;
  analyzedAt: number; // Date.now()
  /**
   * v0.1.2 機能拡張:ユーザーがドラッグで調整した X 軸オフセット。
   *   - キーはノード id(文字列化)、値は元の position.x からの差分(px、viewBox 単位)
   *   - 同 depth プレーン内での横並び順を直す用途
   *   - 新規 AI 分析(同じ folder の再分析)で上書き保存される際にもクリア
   */
  dragOffsetsX?: Record<string, number>;
  /**
   * v0.1.6 追加(必須化):このエントリを分析したときの UI 言語。
   * EN モード時は JA エントリを履歴・タブ・現在表示から完全に除外し、
   * 英語圏ユーザーが日本語データを目にしないようにする。
   * 旧 v0.1.5 以前のデータは load 時に "ja" でバックフィルされる。
   */
  language: Language;
};

type AppMapStore = {
  version: 1;
  history: StoredAnalysis[]; // 新しい順
  currentFolderPath: string | null;
  /**
   * `claude login` を最後に完走したタイムスタンプ(Option A セットアップウィザード用)。
   * claude code CLI には「認証済みか?」を確実に取る API が無いので、ユーザーが
   * 一度ログイン完走したことだけ覚えておく。再起動を跨いで wizard を黙らせる用。
   */
  loginCompletedAt?: number;
  /**
   * v0.1.4 タブ機能:今開いているタブの folderPath 一覧(順序保持)。
   * history はアーカイブ、これは「今ワークスペースに広げてるもの」を表す。
   * 履歴に存在しないパスは load 時に弾く。
   */
  openTabFolderPaths?: string[];
  /**
   * v0.1.6 UI 言語(英日切替トグル、ノーコード語の左)。
   * 不正値や未保存時は asLanguage() で "ja" に fallback。
   * AI プロンプトもこの設定に従って JA / EN を切替える。
   */
  language?: Language;
};

const EMPTY: AppMapStore = {
  version: 1,
  history: [],
  currentFolderPath: null,
};

/** localStorage から読み出し、壊れていれば空状態を返す。
 *
 *  v0.1.6 改修:旧 v0.1.5 以前のエントリ(language 欠落)を "ja" でバックフィル。
 *  これで上位レイヤーは StoredAnalysis.language が常に存在する前提で書ける。 */
export function loadStore(): AppMapStore {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as AppMapStore).version === 1 &&
      Array.isArray((parsed as AppMapStore).history)
    ) {
      const store = parsed as AppMapStore;
      // 旧データには language が無い。"ja" 固定で埋める(v0.1.5 以前は JA プロンプトのみ)
      const backfilledHistory = store.history.map((e) => ({
        ...e,
        language: asLanguage(e.language),
      }));
      return { ...store, history: backfilledHistory };
    }
  } catch (err) {
    console.warn("[AppMap] localStorage load failed:", err);
  }
  return EMPTY;
}

function saveStore(store: AppMapStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("[AppMap] localStorage save failed:", err);
  }
}

/**
 * 分析結果を保存。同じ folderPath が既にあれば置き換え、先頭に持ってくる。
 * 自動的に currentFolderPath をこの folder にセットする(次回起動でこれが復元される)。
 */
export function saveAnalysis(entry: StoredAnalysis): void {
  const store = loadStore();
  const filtered = store.history.filter((e) => e.folderPath !== entry.folderPath);
  const newHistory = [entry, ...filtered].slice(0, MAX_HISTORY);
  saveStore({
    ...store,
    history: newHistory,
    currentFolderPath: entry.folderPath,
  });
}

/** 次回起動時に復元するフォルダを変更。null ならサンプル起動。 */
export function setCurrent(folderPath: string | null): void {
  const store = loadStore();
  saveStore({ ...store, currentFolderPath: folderPath });
}

/** 履歴から 1 件削除。それが current だったら current は null になる。 */
export function removeAnalysis(folderPath: string): void {
  const store = loadStore();
  saveStore({
    ...store,
    history: store.history.filter((e) => e.folderPath !== folderPath),
    currentFolderPath:
      store.currentFolderPath === folderPath ? null : store.currentFolderPath,
  });
}

/** `claude login` 完走の事実を記録。setup wizard を黙らせる用。 */
export function markLoginCompleted(): void {
  const store = loadStore();
  saveStore({ ...store, loginCompletedAt: Date.now() });
}

/** v0.1.6 UI 言語を永続化。次回起動時 loadLanguage() で復元される。 */
export function saveLanguage(language: Language): void {
  const store = loadStore();
  saveStore({ ...store, language });
}

/** v0.1.6 保存済み UI 言語を取り出す。未保存・不正値はすべて "ja" になる。 */
export function loadLanguage(): Language {
  const store = loadStore();
  return asLanguage(store.language);
}

/**
 * v0.1.4 タブ機能:開いているタブの folderPath 一覧を保存。
 * 履歴に存在しないパスは弾く(整合性維持)。
 */
export function saveOpenTabs(paths: string[]): void {
  const store = loadStore();
  const validIds = new Set(store.history.map((e) => e.folderPath));
  const filtered = paths.filter((p) => validIds.has(p));
  saveStore({ ...store, openTabFolderPaths: filtered });
}

/**
 * 特定のフォルダのドラッグオフセット(X 軸)を保存(v0.1.2)。
 *   - folderPath が history に存在しないなら何もしない(サンプル分析時等は呼ばれない想定)
 *   - 値が空 {} のときは dragOffsetsX を削除して綺麗にする
 */
export function saveDragOffsets(
  folderPath: string,
  offsets: Record<string, number>,
): void {
  const store = loadStore();
  const idx = store.history.findIndex((e) => e.folderPath === folderPath);
  if (idx === -1) return;
  const updated: StoredAnalysis = { ...store.history[idx] };
  if (Object.keys(offsets).length === 0) {
    delete updated.dragOffsetsX;
  } else {
    updated.dragOffsetsX = offsets;
  }
  const newHistory = [...store.history];
  newHistory[idx] = updated;
  saveStore({ ...store, history: newHistory });
}
