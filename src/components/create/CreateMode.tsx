import { useRef, useState, useEffect, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import ScreenFlowEditor, {
  flowToText,
  type FlowData,
} from "./ScreenFlowEditor";

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
type ProjectEntry = {
  workspace: string;
  desc: string;
  /** 期待するユーザーへのアウトプット内容(2 欄目)。旧データには無いので optional。 */
  output?: string;
  /** 画面フロー(キャンバスの画面・矢印)。旧データには無いので optional。 */
  flow?: FlowData;
  updatedAt: number;
};

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

const intentInput: CSSProperties = {
  width: "100%",
  marginTop: 4,
  padding: "10px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 400,
};

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "#6b7280",
  fontWeight: 600,
};

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
}: {
  onExit: () => void;
}) {
  const [desc, setDesc] = useState("");
  // 期待するユーザーへのアウトプット内容(2 欄目)。目的と合わせて Claude への指示にする。
  const [output, setOutput] = useState("");
  // 画面:list=プロジェクト一覧 / form=新規の1問 / work=3ペイン作業
  const [screen, setScreen] = useState<"list" | "work">("work");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  // 削除の確認モーダル対象(window.confirm は Tauri webview で機能しないため自前モーダルにする)。
  const [confirmDelete, setConfirmDelete] = useState<ProjectEntry | null>(null);
  // 画面フローの最新値(保存用)。ドラッグ中の毎フレーム再描画を避けるため state でなく ref。
  const flowRef = useRef<FlowData>({ screens: [], edges: [] });
  // 開いたプロジェクトの保存済みフロー(ScreenFlowEditor の初期値)。
  const [flowInitial, setFlowInitial] = useState<FlowData>({
    screens: [],
    edges: [],
  });
  // キャンバスに画面が 1 つでもあるか(「この流れで作る」の活性判定。0↔1 でのみ再描画)。
  const [hasFlow, setHasFlow] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [followup, setFollowup] = useState("");
  const [log, setLog] = useState<{ role: "you" | "ai"; text: string }[]>([]);
  const workspace = useRef<string | null>(null);
  // 各セッションで一意の workspace 名(Codex P3:定数だと前のアプリを引き継ぐ)
  const projectName = useRef("app-" + Date.now());
  // 中央は画面フロー・エディタ(ScreenFlowEditor)が自前の state を持つ。
  // 旧「コード解析マップ + 要素タグ + 流れ再生」は撤去した。
  // 「指示」で選んだ画面名(右ペインの追撃をこの画面にスコープする)。
  const [targetScreen, setTargetScreen] = useState<string | null>(null);

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
    setScreen(list.length > 0 ? "list" : "work");
  }, []);


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
      setProjects(
        upsertProject({
          workspace: ws,
          desc,
          output,
          flow: flowRef.current,
          updatedAt: Date.now(),
        }),
      );
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

  // 「この流れで作る」:目的 + 期待アウトプット + キャンバスの画面フローをまとめて Claude に渡す。
  const handleFlowGenerate = () => {
    if (busy) return;
    const flowText = flowToText(flowRef.current);
    const parts: string[] = [];
    if (desc.trim()) parts.push(`システムの目的:${desc.trim()}`);
    if (output.trim()) {
      parts.push(`期待するユーザーへのアウトプット内容:${output.trim()}`);
    }
    if (flowText) parts.push(flowText);
    if (!parts.length) return; // 目的もフローも空なら何もしない
    void build(parts.join("\n"));
  };

  const handleFollowup = async () => {
    if (!followup.trim() || busy) return;
    const f = followup.trim();
    // 「指示」で画面を選んでいれば、その画面にスコープした指示にする。
    const scoped = targetScreen ? `「${targetScreen}」画面について、${f}` : f;
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
      upsertProject({
        workspace: workspace.current,
        desc,
        output,
        flow: flowRef.current,
        updatedAt: Date.now(),
      }),
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
    setOutput(p.output ?? "");
    const loadedFlow: FlowData = p.flow ?? { screens: [], edges: [] };
    flowRef.current = loadedFlow;
    setFlowInitial(loadedFlow);
    setLog([]);
    setPort(null);
    setAuthNeeded(false);
    setTargetScreen(null);
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
    setOutput("");
    flowRef.current = { screens: [], edges: [] };
    setFlowInitial({ screens: [], edges: [] });
    setHasFlow(false);
    setLog([]);
    setPort(null);
    setAuthNeeded(false);
    setTargetScreen(null);
    setScreen("work");
  };

  // 実際の削除(確認モーダルの「削除する」から呼ぶ)。ディスクのフォルダも消す(best-effort)→ 一覧から除去。
  const doRemoveProject = async (p: ProjectEntry) => {
    setConfirmDelete(null);
    try {
      await invoke("delete_project", { workspace: p.workspace });
    } catch {
      // 古い Rust で未対応でも一覧からの削除は続行(フォルダ削除は次回のアプリ再起動で有効に)。
    }
    const rest = loadProjects().filter((x) => x.workspace !== p.workspace);
    persistProjects(rest);
    setProjects(rest);
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
              <div
                key={p.workspace}
                style={{
                  position: "relative",
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                }}
              >
                <button
                  onClick={() => openProject(p)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    borderRadius: 10,
                    padding: "14px 16px",
                    paddingRight: 72,
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
                <button
                  onClick={() => setConfirmDelete(p)}
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    fontSize: 11,
                    padding: "4px 10px",
                    border: "1px solid #fecaca",
                    borderRadius: 8,
                    background: "#fff",
                    color: "#dc2626",
                    cursor: "pointer",
                  }}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        </div>
        {confirmDelete ? (
          <div
            onClick={() => setConfirmDelete(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 60,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "#fff",
                borderRadius: 12,
                padding: 24,
                width: "min(420px, 90%)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 8 }}>
                本当に削除しますか?
              </div>
              <div style={{ fontSize: 13, color: "#374151", marginBottom: 4 }}>
                「{confirmDelete.desc || "無題のアプリ"}」を削除します。
              </div>
              <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 20 }}>
                この操作は取り消せません。
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setConfirmDelete(null)} style={closeBtn}>
                  キャンセル
                </button>
                <button
                  onClick={() => doRemoveProject(confirmDelete)}
                  style={{ ...closeBtn, background: "#dc2626", color: "#fff", border: "none" }}
                >
                  削除する
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // 作業画面:3ペイン(左 プレビュー / 中央 目的+キャンバス / 右 Claude)。
  // 旧「まず1問だけ」の form 画面は廃止し、中央上部の入力欄に統合した。
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
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <label style={{ ...fieldLabel, flex: 1 }}>
                  システムの目的
                  <input
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    placeholder="例:登録した人に天気を定時でメールする"
                    style={intentInput}
                  />
                </label>
                <button
                  onClick={handleFlowGenerate}
                  disabled={busy || (!desc.trim() && !hasFlow)}
                  style={{
                    ...primaryBtn,
                    padding: "9px 16px",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                  }}
                >
                  この流れで作る
                </button>
              </div>
              <label style={{ ...fieldLabel, marginTop: 6 }}>
                期待するユーザーへのアウトプット内容
                <input
                  value={output}
                  onChange={(e) => setOutput(e.target.value)}
                  placeholder="例:毎朝、その日の天気がメールで届く"
                  style={intentInput}
                />
              </label>
            </div>
            <ScreenFlowEditor
              key={workspace.current ?? "new"}
              initial={flowInitial}
              onTargetChange={setTargetScreen}
              onChange={(f) => {
                flowRef.current = f;
                setHasFlow(f.screens.length > 0);
              }}
            />
          </div>
        </div>

        {/* 右:Claude Code */}
        <div style={paneCol("28%")}>
          <div style={paneLabel}>Claude Code</div>
          <div style={{ ...paneBody, display: "flex", flexDirection: "column" }}>
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
                    : targetScreen
                      ? `「${targetScreen}」を変更(例:色を青に)`
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
