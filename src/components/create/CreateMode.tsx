import { useRef, useState, useEffect, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import MapCanvas from "../canvas/MapCanvas";
import { analyzeFolder } from "../../lib/engineSelector";
import type { ScreenMapResult } from "../../lib/claudeCli";
import type { Language } from "../../lib/i18n";
import { pickLocalized } from "../../lib/i18n";
import type { Engine } from "../../lib/storage";

/**
 * 制作モード(Create Mode)。モックの構成に沿う:
 *   ① 起動直後 = 「どんなアプリを作りたい?」の1問だけ(段階的開示 §3.2)
 *   ② 作業中   = 3ペイン(左 プレビュー / 中央 意図+マップ / 右 Claude Code)
 *
 * 流れ:一言 → create_project(テンプレ複製)→ start_preview(dev 起動)→
 *       generate_app(Claude がコード実装)→ HMR で左プレビューが更新される。
 * 右ペインの入力で追撃(refine)でき、そのたびに Claude が直してプレビューに反映。
 */

// 作りかけプロジェクトの一覧を覚える(複数の掛け持ちに対応)。localStorage に保存し、
// 各エントリは workspace パス・目的・最終更新時刻を持つ。生成コード自体はフォルダにある。
const PROJECTS_KEY = "appmap-create-projects";
type ProjectEntry = { workspace: string; desc: string; updatedAt: number };

function loadProjects(): ProjectEntry[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const list = raw ? (JSON.parse(raw) as ProjectEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function persistProjects(list: ProjectEntry[]) {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  } catch {
    // localStorage が使えなくても致命的ではない
  }
}
// 同じ workspace は 1 つに畳んで先頭(最新)へ。
function upsertProject(entry: ProjectEntry): ProjectEntry[] {
  const rest = loadProjects().filter((p) => p.workspace !== entry.workspace);
  const list = [entry, ...rest];
  persistProjects(list);
  return list;
}

const closeBtn: CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid #d1d5db",
  borderRadius: 7,
  fontSize: 13,
  cursor: "pointer",
};
const primaryBtn: CSSProperties = {
  background: "#14b8a6",
  color: "#fff",
  border: "none",
  borderRadius: 7,
  fontWeight: 600,
  cursor: "pointer",
};
const paneLabel: CSSProperties = {
  fontSize: 11,
  color: "#6b7280",
  marginBottom: 6,
};
const paneBody: CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  overflow: "hidden",
};
const paneCol = (basis: string, grow = 0): CSSProperties => ({
  flex: `${grow} 0 ${basis}`,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
});

export function CreateMode({
  onExit,
  language,
  engine,
}: {
  onExit: () => void;
  language: Language;
  engine: Engine;
}) {
  const [desc, setDesc] = useState("");
  // 画面:list=プロジェクト一覧 / form=新規の1問 / work=3ペイン作業
  const [screen, setScreen] = useState<"list" | "form" | "work">("form");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [followup, setFollowup] = useState("");
  const [log, setLog] = useState<{ role: "you" | "ai"; text: string }[]>([]);
  const workspace = useRef<string | null>(null);
  // 各セッションで一意の workspace 名(Codex P3:定数だと前のアプリを引き継ぐ)
  const projectName = useRef("app-" + Date.now());
  // 中央マップ:生成後に「構造を見る」で AppMap の解析を走らせて表示(on-demand=枠節約)
  const [mapResult, setMapResult] = useState<ScreenMapResult | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapErr, setMapErr] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  // 右ペインのタグで選んだ「変更対象の要素」。指示をこの要素にスコープする。
  const [targetNodeId, setTargetNodeId] = useState<number | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<
    Map<number, { x: number; y: number }>
  >(new Map());

  // マウント時:作りかけプロジェクトの一覧を読む。あれば一覧画面から始める(掛け持ち対応)。
  useEffect(() => {
    let list = loadProjects();
    // 旧「直近1つ」形式(appmap-create-last)で保存されていたら一覧へ移行(取りこぼし防止)。
    try {
      const rawOld = localStorage.getItem("appmap-create-last");
      if (rawOld) {
        const old = JSON.parse(rawOld) as { workspace?: string; desc?: string };
        if (old?.workspace && !list.some((p) => p.workspace === old.workspace)) {
          list = upsertProject({
            workspace: old.workspace,
            desc: old.desc ?? "",
            updatedAt: Date.now(),
          });
        }
        localStorage.removeItem("appmap-create-last");
      }
    } catch {
      // 移行に失敗しても致命的でない
    }
    setProjects(list);
    setScreen(list.length > 0 ? "list" : "form");
  }, []);

  const showMap = async () => {
    if (!workspace.current || mapBusy) return;
    setMapBusy(true);
    setMapErr("");
    try {
      const outcome = await analyzeFolder(workspace.current, language, engine);
      setMapResult(outcome.screens);
    } catch (e) {
      setMapErr("マップ生成に失敗: " + String(e));
    } finally {
      setMapBusy(false);
    }
  };

  const ensureWorkspace = async (): Promise<string> => {
    if (!workspace.current) {
      setStatus("土台を用意中…");
      workspace.current = await invoke<string>("create_project", {
        name: projectName.current,
      });
    }
    // プレビューがまだ立っていなければ起動。前回失敗しても再試行できるよう、
    // workspace の有無ではなく port の有無で判断する(Codex P3)。
    if (port === null) {
      setStatus("プレビューを起動中…");
      setPort(
        await invoke<number>("start_preview", { workspace: workspace.current }),
      );
    }
    return workspace.current;
  };

  const build = async (instruction: string) => {
    setBusy(true);
    setLog((l) => [...l, { role: "you", text: instruction }]);
    try {
      const ws = await ensureWorkspace();
      // 実測で数分かかることがあるので「1〜2分」と嘘をつかず、経過秒数を出す。
      let sec = 0;
      setStatus("Claude Code が実装中…");
      const timer = setInterval(() => {
        sec += 1;
        setStatus(`Claude Code が実装中…(経過 ${sec} 秒)`);
      }, 1000);
      let result: string;
      try {
        result = await invoke<string>("generate_app", {
          workspace: ws,
          instruction,
        });
      } finally {
        clearInterval(timer);
      }
      // Claude の実際の応答(何をしたか)をそのまま見せる。正直に、かつ普段は
      // やさしい要約で(§6.6)。長すぎる時だけ末尾を省く。
      const summary = result.trim();
      setLog((l) => [
        ...l,
        {
          role: "ai",
          text: summary
            ? summary.length > 1200
              ? summary.slice(0, 1200) + "…"
              : summary
            : "実装しました。プレビューを更新しました。",
        },
      ]);
      setStatus("");
      // 自動保存:プロジェクト一覧に反映(次に開いた時、一覧から続きを開ける)。
      setProjects(upsertProject({ workspace: ws, desc, updatedAt: Date.now() }));
    } catch (e) {
      const raw = String(e);
      // 認証切れ(OAuth 期限)は「バグ」でなく「再ログインで直る」ので、やさしく案内する。
      const authLike = /authenticate|401|oauth|expired|unauthorized/i.test(raw);
      setAuthNeeded(authLike);
      const msg = authLike
        ? "Claude の再ログインが必要です(ログインの期限切れ)。右下の「再ログイン」を押してサインインし直してから、もう一度お試しください。"
        : "エラー: " + raw;
      setLog((l) => [...l, { role: "ai", text: msg }]);
      setStatus(authLike ? "要ログイン" : msg);
    } finally {
      setBusy(false);
    }
  };

  // タグで選んだ変更対象の要素(あれば)。指示のスコープ + 入力欄の表示に使う。
  const targetNode =
    targetNodeId != null && mapResult
      ? mapResult.nodes.find((n) => n.id === targetNodeId) ?? null
      : null;
  const targetText = targetNode ? pickLocalized(targetNode.label, language) : null;

  const handleStart = async () => {
    if (!desc.trim() || busy) return;
    setScreen("work");
    await build(desc.trim());
  };

  const handleFollowup = async () => {
    if (!followup.trim() || busy) return;
    const f = followup.trim();
    // タグで要素を選んでいれば、その要素にスコープした指示にする(優先的にその要素を変更)。
    const scoped = targetText ? `「${targetText}」の部分について、${f}` : f;
    setFollowup("");
    await build(scoped);
  };

  // 閉じる時に dev サーバも止める(Codex P2:放置すると裏で走り続け 5199 を占有)
  const handleClose = async () => {
    try {
      await invoke("stop_preview");
    } catch {
      // 停止失敗は無視(閉じるを優先)
    }
    onExit();
  };

  // 認証切れ時のワンクリック再ログイン(claude auth login のブラウザフロー)。
  const relogin = async () => {
    setBusy(true);
    setStatus("ブラウザでサインイン中…(完了までお待ちください)");
    try {
      await invoke("claude_login");
      setAuthNeeded(false);
      setLog((l) => [
        ...l,
        { role: "ai", text: "ログインしました。もう一度お試しください。" },
      ]);
      setStatus("");
    } catch (e) {
      setStatus("ログイン失敗: " + String(e));
    } finally {
      setBusy(false);
    }
  };

  // 現在のプロジェクトを明示的に保存(次に開いた時に戻れる)。生成時にも自動保存されるが、
  // 「保存した」と分かる押せるボタンが欲しい、という要望に応えるもの。
  const saveProject = () => {
    if (!workspace.current) {
      setStatus("まだ保存するアプリがありません");
      return;
    }
    setProjects(
      upsertProject({ workspace: workspace.current, desc, updatedAt: Date.now() }),
    );
    setLog((l) => [
      ...l,
      { role: "ai", text: "保存しました。一覧からいつでも開けます。" },
    ]);
    setStatus("保存しました");
  };

  // 一覧から既存プロジェクトを開いて続きから開発する(掛け持ちの切替)。
  const openProject = async (p: ProjectEntry) => {
    workspace.current = p.workspace;
    setDesc(p.desc);
    setLog([]);
    setMapResult(null);
    setPort(null);
    setAuthNeeded(false);
    setSelectedNodeId(null);
    setScreen("work");
    setStatus("プロジェクトを開いています…");
    try {
      const port2 = await invoke<number>("start_preview", {
        workspace: p.workspace,
      });
      setPort(port2);
      setStatus("");
    } catch (e) {
      setStatus("開けませんでした: " + String(e));
    }
  };

  // 新しいアプリを一から作る(別プロジェクト)。
  const startNew = () => {
    projectName.current = "app-" + Date.now();
    workspace.current = null;
    setDesc("");
    setLog([]);
    setMapResult(null);
    setPort(null);
    setAuthNeeded(false);
    setScreen("form");
  };

  // 作業中から一覧へ戻る。現在のプレビュー(dev サーバ)は止めてから。
  const backToList = async () => {
    try {
      await invoke("stop_preview");
    } catch {
      // 無視
    }
    setPort(null);
    setProjects(loadProjects());
    setScreen("list");
  };

  const overlayBase: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "#f9fafb",
    display: "flex",
    flexDirection: "column",
    zIndex: 50,
  };

  // 一覧画面:作りかけプロジェクトから選ぶ(掛け持ち対応)
  if (screen === "list") {
    return (
      <div style={overlayBase}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            background: "#fff",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          <strong style={{ fontSize: 14 }}>作る(実験)</strong>
          <span style={{ fontSize: 12, color: "#6b7280" }}>あなたのプロジェクト</span>
          <button onClick={handleClose} style={{ ...closeBtn, marginLeft: "auto" }}>
            閉じる
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <button
            onClick={startNew}
            style={{ ...primaryBtn, padding: "10px 18px", fontSize: 14, marginBottom: 16 }}
          >
            ＋ 新しいアプリを作る
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
            {projects.map((p) => (
              <button
                key={p.workspace}
                onClick={() => openProject(p)}
                style={{
                  textAlign: "left",
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "14px 16px",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, color: "#111827" }}>
                  {p.desc || "(無題のアプリ)"}
                </div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                  最終更新: {new Date(p.updatedAt).toLocaleString()}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ① 新規作成:まず1問だけ
  if (screen === "form") {
    return (
      <div style={overlayBase}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px" }}>
          {projects.length > 0 ? (
            <button onClick={() => setScreen("list")} style={closeBtn}>
              一覧へ
            </button>
          ) : null}
          <button onClick={handleClose} style={closeBtn}>
            閉じる
          </button>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>
            どんなアプリを作りたい?
          </div>
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleStart();
            }}
            placeholder="例:予約管理アプリ"
            style={{
              width: "min(420px, 80%)",
              padding: "12px 16px",
              border: "1px solid #d1d5db",
              borderRadius: 10,
              fontSize: 16,
            }}
          />
          <button
            onClick={handleStart}
            disabled={busy}
            style={{ ...primaryBtn, padding: "10px 22px", fontSize: 15 }}
          >
            作りはじめる
          </button>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            マップもプレビューも、作り始めてから開きます
          </div>
        </div>
      </div>
    );
  }

  // ② 作業中/完了:3ペイン
  return (
    <div style={overlayBase}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <strong style={{ fontSize: 14 }}>作る(実験)</strong>
        <span style={{ color: busy ? "#0f766e" : "#6b7280", fontSize: 12 }}>
          {status || (port ? "準備できました" : "")}
        </span>
        <button
          onClick={saveProject}
          style={{
            ...closeBtn,
            marginLeft: "auto",
            background: "#14b8a6",
            color: "#fff",
            border: "none",
          }}
        >
          保存する
        </button>
        <button onClick={backToList} style={closeBtn}>
          一覧
        </button>
        <button onClick={handleClose} style={closeBtn}>
          閉じる
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: 8 }}>
        {/* 左:プレビュー(実物) */}
        <div style={paneCol("30%")}>
          <div style={paneLabel}>プレビュー(実物)</div>
          <div style={paneBody}>
            {port ? (
              <iframe
                src={`http://127.0.0.1:${port}`}
                style={{ width: "100%", height: "100%", border: "none" }}
                title="preview"
              />
            ) : (
              <div style={{ padding: 20, color: "#9ca3af", fontSize: 13 }}>準備中…</div>
            )}
          </div>
        </div>

        {/* 中央:意図 + マップ */}
        <div style={paneCol("0", 1)}>
          <div style={paneLabel}>このアプリ</div>
          <div
            style={{
              ...paneBody,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>目的</div>
            <div style={{ fontSize: 14, color: "#111827", marginBottom: 12 }}>{desc}</div>
            {mapResult ? (
              <div style={{ flex: 1, minHeight: 0 }}>
                <MapCanvas
                  nodes={mapResult.nodes}
                  edges={mapResult.edges}
                  selectedNodeId={selectedNodeId}
                  onNodeClick={setSelectedNodeId}
                  language={language}
                  appSummary={mapResult.appSummary}
                  appName={desc}
                  nodeOffsets={nodeOffsets}
                  onNodeOffsetsChange={setNodeOffsets}
                  folderPath={workspace.current}
                  autoFit
                  fillHeight
                />
              </div>
            ) : (
              <div
                style={{
                  border: "1px dashed #d1d5db",
                  borderRadius: 8,
                  padding: 24,
                  textAlign: "center",
                  color: "#6b7280",
                  fontSize: 13,
                  lineHeight: 1.8,
                }}
              >
                このアプリの構造(画面・データ・流れ)をマップにできます。
                <br />
                <button
                  onClick={showMap}
                  disabled={mapBusy || !workspace.current}
                  style={{ ...primaryBtn, padding: "8px 16px", fontSize: 13, marginTop: 12 }}
                >
                  {mapBusy ? "解析中…" : "構造マップを出す"}
                </button>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>
                  ※ AI でコードを読むので少し時間と枠を使います
                </div>
                {mapErr ? (
                  <div style={{ fontSize: 11, color: "#dc2626", marginTop: 8 }}>
                    {mapErr}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* 右:Claude Code */}
        <div style={paneCol("28%")}>
          <div style={paneLabel}>Claude Code</div>
          <div style={{ ...paneBody, display: "flex", flexDirection: "column" }}>
            {mapResult ? (
              <div style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 4 }}>
                  要素を選んで指示(クリックでその要素を優先的に変更)
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    maxHeight: 100,
                    overflowY: "auto",
                  }}
                >
                  {mapResult.nodes.map((n) => {
                    const active = targetNodeId === n.id;
                    return (
                      <button
                        key={n.id}
                        onClick={() => {
                          const next = active ? null : n.id;
                          setTargetNodeId(next);
                          setSelectedNodeId(next);
                        }}
                        style={{
                          fontSize: 10,
                          padding: "3px 8px",
                          borderRadius: 999,
                          border: active
                            ? "1px solid #0f766e"
                            : "1px solid #d1d5db",
                          background: active ? "#14b8a6" : "#fff",
                          color: active ? "#fff" : "#374151",
                          cursor: "pointer",
                        }}
                      >
                        {pickLocalized(n.label, language)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {log.map((m, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: m.role === "you" ? "#e0f2fe" : "#f3f4f6",
                    color: m.role === "you" ? "#075985" : "#374151",
                  }}
                >
                  {m.text}
                </div>
              ))}
              {busy ? (
                <div style={{ fontSize: 11, color: "#0f766e", padding: "6px 8px" }}>
                  {status}
                </div>
              ) : null}
            </div>
            {authNeeded ? (
              <div style={{ padding: 8, borderTop: "1px solid #eee" }}>
                <button
                  onClick={relogin}
                  disabled={busy}
                  style={{ ...primaryBtn, width: "100%", padding: "8px 0", fontSize: 12 }}
                >
                  再ログイン(ブラウザでサインイン)
                </button>
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 5, padding: 8, borderTop: "1px solid #eee" }}>
              <input
                value={followup}
                onChange={(e) => setFollowup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleFollowup();
                }}
                placeholder={
                  busy
                    ? "実装中…"
                    : targetText
                      ? `「${targetText}」を変更(例:色を青に)`
                      : "AI に頼む(例:色を青に)"
                }
                disabled={busy}
                style={{
                  flex: 1,
                  height: 30,
                  fontSize: 11,
                  padding: "0 8px",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                }}
              />
              <button
                onClick={handleFollowup}
                disabled={busy}
                style={{ ...primaryBtn, padding: "6px 10px", fontSize: 11 }}
              >
                送る
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
