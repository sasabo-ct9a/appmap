import {
  useRef,
  useState,
  useEffect,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import ScreenFlowEditor, {
  flowToText,
  type FlowData,
} from "./ScreenFlowEditor";
import { buildCreatePrompt, buildRefinePrompt } from "../../lib/createPrompt";
import { FlowView } from "./FlowView";
import { MatchView, parseMapping, type MatchPair } from "./MatchView";
import { analyzeFolder } from "../../lib/engineSelector";
import { pickLocalized } from "../../lib/i18n";
import type { ScreenMapResult } from "../../lib/claudeCli";

/**
 * 制作モード(Create Mode)。モックの構成に沿う:
 *   ① 起動直後 = 「どんなアプリを作りたい?」の1問だけ(段階的開示 §3.2)
 *   ② 作業中   = 3ペイン(左 プレビュー / 中央 意図+マップ / 右 Claude Code)
 *
 * 流れ:一言 → create_project(テンプレ複製)→ start_preview(dev 起動)→
 *       generate_app(Claude がコード実装)→ HMR で左プレビューが更新される。
 * 右ペインの入力で追加指示(refine)でき、そのたびに Claude が直してプレビューに反映。
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

const supaInput: CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 11,
  boxSizing: "border-box",
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
  // Supabase 接続(URL + anon key)。.env に書いて preview 再起動で反映する。
  const [supaUrl, setSupaUrl] = useState("");
  const [supaKey, setSupaKey] = useState("");
  const [supaConnected, setSupaConnected] = useState(false);
  const [supaOpen, setSupaOpen] = useState(false);
  // .env を反映させるため iframe を張り直すキー。
  const [previewNonce, setPreviewNonce] = useState(0);
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
  // 「指示」で選んだ画面名(右ペインの追加指示をこの画面にスコープする)。
  const [targetScreen, setTargetScreen] = useState<string | null>(null);

  // ペイン幅の重み。境界のドラッグ(gutter)で調整。pv=プレビュー / ca=キャンバス / cl=Claude。
  const [weights, setWeights] = useState({ pv: 30, ca: 42, cl: 28 });
  // キャンバスを別ウィンドウ(全画面)に出しているか。出している間、本ウィンドウはキャンバスを隠す。
  const [poppedOut, setPoppedOut] = useState(false);
  const canvasWin = useRef<WebviewWindow | null>(null);
  // モニタが2枚以上か。別画面ボタンはこの時だけ出す(1枚では別窓に出す意味がない)。
  const [multiMonitor, setMultiMonitor] = useState(false);
  // 戻せる世代数(生成のたびに増える)。-1=チェックポイント不可(git 無し)でボタンを隠す。
  const [undoCount, setUndoCount] = useState(-1);
  // 左ペインのタブ:プレビュー(動く実物)/ 構造マップ(出来た物を実コードから解析した実体)。
  const [leftTab, setLeftTab] = useState<"preview" | "map" | "match">("preview");
  // 「出来たアプリ」の実体マップ(見るの analyzeFolder で生成物を解析した結果)。null=未解析。
  const [asBuilt, setAsBuilt] = useState<ScreenMapResult | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapSelected, setMapSelected] = useState<number | null>(null);
  // 意図↔実体の対応(突き合わせ)。AI 推定なので確定ではない。null=未実行。
  const [mapping, setMapping] = useState<MatchPair[] | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);

  // 境界ドラッグ:leftKey と rightKey の重みを付け替える(合計は一定・各ペイン最低 8%)。
  const startResize = (
    leftKey: "pv" | "ca" | "cl",
    rightKey: "pv" | "ca" | "cl",
    e: ReactPointerEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const row = e.currentTarget.parentElement;
    if (!row) return;
    const totalPx = row.getBoundingClientRect().width;
    const startX = e.clientX;
    const start = { ...weights };
    const sum = start.pv + start.ca + start.cl;
    const min = sum * 0.08;
    const onMove = (ev: PointerEvent) => {
      const dW = ((ev.clientX - startX) / totalPx) * sum;
      let l = start[leftKey] + dW;
      let r = start[rightKey] - dW;
      if (l < min) {
        r -= min - l;
        l = min;
      }
      if (r < min) {
        l -= min - r;
        r = min;
      }
      setWeights({ ...start, [leftKey]: l, [rightKey]: r });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 「キャンバスを別画面で開く」:キャンバス専用ウィンドウ(#canvas)を開き、本ウィンドウは
  // キャンバスを隠してプレビュー+Claude を広く使う。フローはイベントで双方向に同期する。
  const openCanvasWindow = async () => {
    if (poppedOut) {
      try {
        await canvasWin.current?.setFocus();
      } catch {
        /* 無視 */
      }
      return;
    }
    try {
      canvasWin.current = new WebviewWindow("canvas", {
        url: `${window.location.origin}/#canvas`,
        title: "キャンバス — AppMap",
        width: 1280,
        height: 860,
      });
      setPoppedOut(true);
      setWeights({ pv: 42, ca: 16, cl: 42 });
    } catch (e) {
      alert("キャンバスウィンドウを開けませんでした: " + String(e));
    }
  };

  // 「本画面に戻す」:別ウィンドウを閉じ、本ウィンドウにキャンバスを戻す。
  const closeCanvasWindow = async () => {
    try {
      await canvasWin.current?.close();
    } catch {
      /* 既に閉じている等は無視 */
    }
    canvasWin.current = null;
    setPoppedOut(false);
    setWeights({ pv: 30, ca: 42, cl: 28 });
  };

  // 別ウィンドウ(キャンバス)との同期:ready で初期値(目的/出力/フロー)を送り、
  // 入力の変化(desc/output/flow/target)と「作る」(generate)を受け取る。
  // 別窓の「戻す」ボタンや × で送られる close を受けたら本ウィンドウを元に戻す。
  useEffect(() => {
    const uns: Array<() => void> = [];
    void (async () => {
      uns.push(
        await listen("canvas:ready", () => {
          void emit("canvas:init", {
            desc: descRef.current,
            output: outputRef.current,
            flow: flowRef.current,
          });
        }),
      );
      uns.push(await listen<string>("canvas:desc", (e) => setDesc(e.payload ?? "")));
      uns.push(await listen<string>("canvas:output", (e) => setOutput(e.payload ?? "")));
      uns.push(
        await listen<FlowData>("canvas:flow", (e) => {
          const f = e.payload ?? { screens: [], edges: [] };
          flowRef.current = f;
          setHasFlow(f.screens.length > 0);
        }),
      );
      uns.push(
        await listen<string | null>("canvas:target", (e) => {
          setTargetScreen(e.payload ?? null);
        }),
      );
      uns.push(
        await listen<{ desc: string; output: string; flow: FlowData }>(
          "canvas:generate",
          (e) => {
            const p = e.payload;
            if (p) runGenerateRef.current(p.desc, p.output, p.flow);
          },
        ),
      );
      uns.push(
        await listen("canvas:close", () => {
          canvasWin.current = null;
          setPoppedOut(false);
          setWeights({ pv: 30, ca: 42, cl: 28 });
        }),
      );
    })();
    return () => uns.forEach((u) => u());
  }, []);

  // 生成中フラグを別ウィンドウ(キャンバス窓)へ伝える(向こうの「作る」ボタンの二重押し防止)。
  useEffect(() => {
    if (poppedOut) void emit("canvas:busy", busy);
  }, [busy, poppedOut]);

  // モニタ枚数を検出(マウント時 + ウィンドウがフォーカスされた時=接続変更に追従)。
  useEffect(() => {
    const check = () => {
      void availableMonitors()
        .then((m) => setMultiMonitor(m.length >= 2))
        .catch(() => setMultiMonitor(false));
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

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

  // display = チャットに残す人向けの文。prompt = Claude に渡す完成プロンプト(基礎込み)。
  const build = async (display: string, prompt: string) => {
    setBusy(true);
    setLog((l) => [...l, { role: "you", text: display }]);
    try {
      const ws = await ensureWorkspace();
      // 既存プロジェクトを本番構成(Supabase)に追いつかせる(Codex P1)。
      // 不足テンプレ + 依存を補い、補ったら preview を再起動して反映する。
      try {
        setStatus("プロジェクトを整えています…");
        const changed = await invoke<boolean>("ensure_supabase_ready", {
          workspace: ws,
        });
        if (changed) {
          try {
            await invoke("stop_preview");
          } catch {
            // 停止失敗は無視
          }
          const p2 = await invoke<number>("start_preview", { workspace: ws });
          setPort(p2);
          setPreviewNonce((n) => n + 1);
        }
      } catch {
        // 移行に失敗しても生成は続行(Claude 側で対処できることもある)
      }
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
          prompt,
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
      void refreshUndo();
      // 生成でコードが変わった → 前の実体マップ・対応付けは古い。破棄して再解析を促す(偽を見せない)。
      setAsBuilt(null);
      setMapping(null);
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

  // 「元に戻す」用:戻せる世代数を取得する(git 未導入は -1 → ボタン非表示)。
  const refreshUndo = async () => {
    const ws = workspace.current;
    if (!ws) {
      setUndoCount(-1);
      return;
    }
    try {
      setUndoCount(await invoke<number>("undo_available", { workspace: ws }));
    } catch {
      setUndoCount(-1);
    }
  };

  // 直前の生成を取り消して1つ前の状態へ。プレビューを貼り直して反映する。
  const handleUndo = async () => {
    const ws = workspace.current;
    if (!ws || busy) return;
    try {
      const remaining = await invoke<number>("undo_generation", { workspace: ws });
      setUndoCount(remaining);
      setPreviewNonce((n) => n + 1);
      setStatus("1つ前の状態に戻しました");
      setLog((l) => [...l, { role: "ai", text: "1つ前の状態に戻しました。" }]);
      setAsBuilt(null); // 戻したらコードも変わる → 実体マップ・対応付けは再解析させる
      setMapping(null);
    } catch (e) {
      setStatus(String(e));
    }
  };

  // 「出来たアプリ」を実際のコードから解析して構造マップにする(=見るを作るの出力へ適用)。
  // Claude を使うのでオンデマンド(ボタン)。既存の analyzeFolder + MapCanvas を再利用する。
  // 実体マップは必ず"実コード解析"で作る(意図キャンバスの再表示にしない)。
  const analyzeAsBuilt = async () => {
    const ws = workspace.current;
    if (!ws || mapBusy || busy) return;
    setMapBusy(true);
    setStatus("出来たアプリを解析中…(Claude を使用)");
    try {
      const outcome = await analyzeFolder(ws, "ja", "claude");
      setAsBuilt(outcome.screens);
      setMapSelected(null);
      setMapping(null); // 実体が変わったら対応付けもやり直し
      setStatus("");
    } catch (e) {
      setStatus("解析に失敗: " + String(e));
    } finally {
      setMapBusy(false);
    }
  };

  // 意図(画面フロー)と実体(解析マップ)を Claude で対応付ける。結果は AI 推定(◐)で確定ではない。
  const runMatch = async () => {
    if (!asBuilt || mappingBusy || busy) return;
    const intentNames = flowRef.current.screens.map((s) => s.name.trim()).filter(Boolean);
    const builtNames = asBuilt.nodes.map((n) => pickLocalized(n.label, "ja"));
    const builtList = asBuilt.nodes.map((n) => {
      const name = pickLocalized(n.label, "ja");
      const it = n.userIntent ? pickLocalized(n.userIntent, "ja") : "";
      return it ? `${name}(${it})` : name;
    });
    const prompt = [
      "非エンジニアが「作りたい画面」として並べた名前(意図)と、AI が実際に生成したアプリの画面名(実体)です。",
      "各『実体の画面』が、どの『意図の画面』に対応するかを推測してください。名前が完全一致でなくても、意味・機能・目的が近ければ積極的に対応付けてください(例:「週間予報画面」↔「週間予報」、「アカウント画面」↔「アカウント」、「設定画面」↔「配信設定」は対応する)。意図の名前は曖昧・空(画面4 等)なこともあります。本当にどの意図にも当てはまらない時だけ intent を null(=AI が独自に追加)にしてください。",
      "",
      "意図の画面: " + (intentNames.length ? intentNames.join(" / ") : "(なし)"),
      "実体の画面: " + builtList.join(" / "),
      "",
      "出力は JSON 配列のみ(説明・コードフェンス不要)。built は実体の画面名を正確に:",
      '[{"built":"<実体の画面名>","intent":"<意図の画面名 または null>"}]',
    ].join("\n");
    setMappingBusy(true);
    setStatus("意図と実体を対応付け中…(Claude を使用)");
    try {
      const raw = await invoke<string>("claude_ask", { prompt });
      setMapping(parseMapping(raw, builtNames));
      setStatus("");
    } catch (e) {
      setStatus("対応付けに失敗: " + String(e));
    } finally {
      setMappingBusy(false);
    }
  };

  // 「この流れで作る」:目的 + 期待アウトプット + キャンバスの画面フローをまとめて Claude に渡す。
  // 目的 + 期待アウトプット + キャンバスのフローをまとめて本番プロンプトにして生成する。
  // 引数で受けるのは、別ウィンドウ(キャンバス窓)の canvas:generate からも同じ経路で呼ぶため。
  const runGenerate = (d: string, o: string, flow: FlowData) => {
    if (busy) return;
    const flowText = flowToText(flow);
    const parts: string[] = [];
    if (d.trim()) parts.push(`システムの目的:${d.trim()}`);
    if (o.trim()) {
      parts.push(`期待するユーザーへのアウトプット内容:${o.trim()}`);
    }
    if (flowText) parts.push(flowText);
    if (!parts.length) return; // 目的もフローも空なら何もしない
    const instruction = parts.join("\n");
    void build(instruction, buildCreatePrompt(instruction));
  };
  const handleFlowGenerate = () => runGenerate(desc, output, flowRef.current);
  // 一度だけ張るイベントリスナから最新の値/関数を使うための参照(stale closure 回避)。
  const descRef = useRef(desc);
  descRef.current = desc;
  const outputRef = useRef(output);
  outputRef.current = output;
  const runGenerateRef = useRef(runGenerate);
  runGenerateRef.current = runGenerate;

  const handleFollowup = async () => {
    if (!followup.trim() || busy) return;
    const f = followup.trim();
    // 「指示」で画面を選んでいれば、その画面にスコープした指示にする。
    const scoped = targetScreen ? `「${targetScreen}」画面について、${f}` : f;
    setFollowup("");
    // 追加指示:基礎は既にあるので軽い prompt(要点だけ念押し)。
    await build(scoped, buildRefinePrompt(scoped));
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
    // 保存済みの Supabase 接続情報(.env)を復元。
    try {
      const [u, k] = await invoke<[string, string]>("get_supabase_env", {
        workspace: p.workspace,
      });
      setSupaUrl(u);
      setSupaKey(k);
      setSupaConnected(Boolean(u && k));
    } catch {
      setSupaUrl("");
      setSupaKey("");
      setSupaConnected(false);
    }
    setLog([]);
    setPort(null);
    setAuthNeeded(false);
    setTargetScreen(null);
    void refreshUndo();
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

  // Supabase を接続:URL/キーを .env に書いて preview を再起動 → iframe を張り直す。
  const connectSupabase = async () => {
    if (!workspace.current || !supaUrl.trim() || !supaKey.trim()) return;
    setStatus("Supabase に接続中…");
    try {
      await invoke("set_supabase_env", {
        workspace: workspace.current,
        url: supaUrl.trim(),
        anonKey: supaKey.trim(),
      });
      try {
        await invoke("stop_preview");
      } catch {
        // 停止失敗は無視
      }
      await invoke<number>("start_preview", { workspace: workspace.current });
      setPreviewNonce((n) => n + 1);
      setSupaConnected(true);
      setSupaOpen(false);
      setStatus("Supabase 接続済み");
    } catch (e) {
      setStatus("接続に失敗: " + String(e));
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
    setSupaUrl("");
    setSupaKey("");
    setSupaConnected(false);
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
          <strong style={{ fontSize: 14 }}>クリエイトモード</strong>
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
  // 2画面モードは order で [キャンバス | プレビュー | Claude] に並べ替え、キャンバス列を左モニタ幅にする。
  // ペインの視覚順(2画面時はキャンバスを左端に)。幅は weights を flex-grow に、並びは order で。
  // gutter は order 1・3 に置くと、視覚的に隣り合う2ペインの境界に入る(DOM 位置は無関係)。
  const visualOrder = (
    poppedOut ? ["pv", "cl"] : ["pv", "ca", "cl"]
  ) as ("pv" | "ca" | "cl")[];
  const colFor = (k: "pv" | "ca" | "cl"): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    minWidth: 120,
    flex: `${weights[k]} 1 0`,
    order: visualOrder.indexOf(k) * 2,
  });
  const previewCol = colFor("pv");
  const canvasCol = colFor("ca");
  const claudeCol = colFor("cl");
  // 境界の仕切り(ドラッグで幅変更)。中央に細い線、カーソルは col-resize。
  const gutterStyle: CSSProperties = {
    flex: "0 0 8px",
    cursor: "col-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
  };
  // 左ペインのタブ(プレビュー / 構造マップ)のボタン見た目。
  const leftTabStyle = (active: boolean): CSSProperties => ({
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    color: active ? "#0f766e" : "#6b7280",
    background: active ? "#ccfbf1" : "transparent",
    border: "1px solid " + (active ? "#5eead4" : "#e5e7eb"),
    borderRadius: 7,
    padding: "4px 12px",
    cursor: "pointer",
  });
  // 構造マップで選択中のノード(実体詳細パネル用)。
  const selNode =
    asBuilt && mapSelected != null
      ? (asBuilt.nodes.find((n) => n.id === mapSelected) ?? null)
      : null;
  // 意図 vs 実体の粗い差分:意図キャンバスの画面数と実体マップの画面数を比べる(名前対応はしない)。
  const intentScreenCount = flowRef.current.screens.length;
  const detailLabel: CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    color: "#9ca3af",
    letterSpacing: "0.03em",
  };
  const dataChip: CSSProperties = {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    background: "#f0fdfa",
    color: "#0f766e",
    border: "1px solid #99f6e4",
  };
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
        <strong style={{ fontSize: 14 }}>クリエイトモード</strong>
        <span style={{ color: busy ? "#0f766e" : "#6b7280", fontSize: 12 }}>
          {status || (port ? "準備できました" : "")}
        </span>
        <div style={{ marginLeft: "auto" }} />
        {undoCount >= 0 && (
          <button
            onClick={handleUndo}
            disabled={undoCount === 0 || busy}
            style={{
              ...closeBtn,
              opacity: undoCount === 0 || busy ? 0.5 : 1,
              cursor: undoCount === 0 || busy ? "not-allowed" : "pointer",
            }}
            title="直前の生成を取り消して1つ前の状態に戻す"
          >
            元に戻す
          </button>
        )}
        {(multiMonitor || poppedOut) && (
          <button
            onClick={poppedOut ? closeCanvasWindow : openCanvasWindow}
            style={closeBtn}
            title="キャンバスを別ウィンドウ(全画面)で開く。モニタ1に置いて全画面にできる"
          >
            {poppedOut ? "キャンバスを本画面に戻す" : "キャンバスを別画面で開く"}
          </button>
        )}
        <button
          onClick={saveProject}
          style={{
            ...closeBtn,
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

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 0, padding: 8 }}>
        {/* 境界の gutter。視覚的に隣り合う2ペインの間(order 奇数)に入る。表示ペイン数−1 枚。 */}
        {visualOrder.slice(0, -1).map((k, i) => (
          <div
            key={`gutter-${k}`}
            style={{ ...gutterStyle, order: i * 2 + 1 }}
            onPointerDown={(e) => startResize(visualOrder[i], visualOrder[i + 1], e)}
            title="ドラッグで幅を変更"
          >
            <div style={{ width: 2, height: "100%", background: "#e5e7eb" }} />
          </div>
        ))}
        {/* 左:プレビュー(実物) */}
        <div style={previewCol}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <button onClick={() => setLeftTab("preview")} style={leftTabStyle(leftTab === "preview")}>
              プレビュー
            </button>
            <button onClick={() => setLeftTab("map")} style={leftTabStyle(leftTab === "map")}>
              構造マップ
            </button>
            <button onClick={() => setLeftTab("match")} style={leftTabStyle(leftTab === "match")}>
              突き合わせ
            </button>
          </div>
          <div style={{ ...paneBody, display: "flex", flexDirection: "column" }}>
            {/* Supabase 接続バー */}
            <div style={{ padding: 8, borderBottom: "1px solid #eee" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: supaConnected ? "#0f766e" : "#9ca3af",
                  }}
                >
                  {supaConnected ? "● Supabase 接続済み" : "○ Supabase 未接続"}
                </span>
                <button
                  onClick={() => setSupaOpen((o) => !o)}
                  style={{
                    fontSize: 11,
                    color: "#2563eb",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {supaOpen ? "閉じる" : "接続設定"}
                </button>
              </div>
              {supaOpen ? (
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  <input
                    value={supaUrl}
                    onChange={(e) => setSupaUrl(e.target.value)}
                    placeholder="Project URL(https://xxxx.supabase.co)"
                    style={supaInput}
                  />
                  <input
                    value={supaKey}
                    onChange={(e) => setSupaKey(e.target.value)}
                    placeholder="anon public key"
                    style={supaInput}
                  />
                  <button
                    onClick={connectSupabase}
                    disabled={!workspace.current || !supaUrl.trim() || !supaKey.trim()}
                    style={{ ...primaryBtn, padding: "6px 10px", fontSize: 11 }}
                  >
                    接続する
                  </button>
                  <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.5 }}>
                    Supabase の Project Settings → API から取得(anon public key)。
                    接続後、プレビューを読み直します。
                  </div>
                </div>
              ) : null}
            </div>
            {/* プレビュー(動く実物)。タブ切替でも iframe は残す(display 切替=再読込を避ける)。 */}
            <div style={{ flex: 1, minHeight: 0, display: leftTab === "preview" ? "block" : "none" }}>
              {port ? (
                <iframe
                  key={previewNonce}
                  src={`http://127.0.0.1:${port}`}
                  style={{ width: "100%", height: "100%", border: "none" }}
                  title="preview"
                />
              ) : (
                <div style={{ padding: 20, color: "#9ca3af", fontSize: 13 }}>
                  準備中…
                </div>
              )}
            </div>
            {/* 構造マップ(出来た物を実コードから解析した実体)。オンデマンド解析。 */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: leftTab === "map" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              {mapBusy ? (
                <div style={{ padding: 20, color: "#0f766e", fontSize: 13 }}>
                  出来たアプリを解析中…(Claude を使用)
                </div>
              ) : asBuilt ? (
                <>
                  <div style={{ padding: "6px 8px", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>
                      実際のコードから解析した構造
                    </span>
                    <button
                      onClick={analyzeAsBuilt}
                      style={{ ...closeBtn, marginLeft: "auto", padding: "3px 10px", fontSize: 11 }}
                    >
                      再解析
                    </button>
                  </div>
                  {asBuilt.appSummary ? (
                    <div
                      style={{
                        padding: "0 8px 6px",
                        fontSize: 12,
                        color: "#374151",
                        lineHeight: 1.6,
                      }}
                    >
                      {pickLocalized(asBuilt.appSummary, "ja")}
                    </div>
                  ) : null}
                  <div
                    style={{
                      padding: "0 8px 8px",
                      display: "flex",
                      gap: 10,
                      alignItems: "baseline",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "#374151" }}>
                      意図 <b>{intentScreenCount}</b> 画面 → 実体 <b>{asBuilt.nodes.length}</b> 画面
                    </span>
                    {(() => {
                      const d = asBuilt.nodes.length - intentScreenCount;
                      if (d > 0)
                        return (
                          <span style={{ fontSize: 11, color: "#0f766e" }}>
                            AI が {d} 画面ぶん具体化・追加
                          </span>
                        );
                      if (d < 0)
                        return (
                          <span style={{ fontSize: 11, color: "#b45309" }}>
                            意図より {-d} 画面少ない ― 未実装がないか確認を
                          </span>
                        );
                      return (
                        <span style={{ fontSize: 11, color: "#9ca3af" }}>画面数は一致</span>
                      );
                    })()}
                  </div>
                  <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                    <FlowView
                      screens={asBuilt}
                      language="ja"
                      selectedId={mapSelected}
                      onSelect={setMapSelected}
                    />
                    {selNode ? (
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          maxHeight: "60%",
                          overflowY: "auto",
                          background: "#fff",
                          borderTop: "1px solid #e5e7eb",
                          boxShadow: "0 -4px 12px rgba(0,0,0,0.08)",
                          padding: "10px 12px 14px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                          <strong style={{ fontSize: 13 }}>
                            {pickLocalized(selNode.label, "ja")}
                          </strong>
                          {selNode.userIntent ? (
                            <span style={{ fontSize: 11, color: "#6b7280" }}>
                              {pickLocalized(selNode.userIntent, "ja")}
                            </span>
                          ) : null}
                          <button
                            onClick={() => setMapSelected(null)}
                            style={{ ...closeBtn, marginLeft: "auto", padding: "2px 8px", fontSize: 11 }}
                          >
                            閉じる
                          </button>
                        </div>
                        {selNode.detail?.body ? (
                          <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, marginBottom: 8 }}>
                            {pickLocalized(selNode.detail.body, "ja")}
                          </div>
                        ) : null}
                        {selNode.subActions?.length ? (
                          <div style={{ marginBottom: 8 }}>
                            <div style={detailLabel}>できること</div>
                            <ul style={{ margin: "2px 0 0", paddingLeft: 16, fontSize: 12, color: "#374151", lineHeight: 1.6 }}>
                              {selNode.subActions.map((a, i) => (
                                <li key={i}>{pickLocalized(a, "ja")}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {selNode.detail?.dataUsed?.length ? (
                          <div style={{ marginBottom: 8 }}>
                            <div style={detailLabel}>使うデータ</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
                              {selNode.detail.dataUsed.map((d, i) => (
                                <span key={i} style={dataChip}>
                                  {pickLocalized(d, "ja")}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {selNode.detail?.files?.length ? (
                          <div>
                            <div style={detailLabel}>関連ファイル</div>
                            <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace", marginTop: 3, lineHeight: 1.7 }}>
                              {selNode.detail.files.map((f, i) => (
                                <div key={i}>{f}</div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 12,
                    padding: 24,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>
                    出来たアプリの構造を、<b>実際のコードから</b>解析して地図にします。
                    <br />
                    「作ったつもり」でなく「実際に何が出来たか」が見えます。
                  </div>
                  <button
                    onClick={analyzeAsBuilt}
                    disabled={busy || mapBusy}
                    style={{ ...primaryBtn, padding: "9px 18px", fontSize: 13 }}
                  >
                    出来たアプリの構造を見る
                  </button>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>※ 解析に Claude を使います</div>
                </div>
              )}
            </div>
            {/* 突き合わせ(意図 vs 実体・AI 推定の対応) */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: leftTab === "match" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              {mappingBusy ? (
                <div style={{ padding: 20, color: "#0f766e", fontSize: 13 }}>
                  意図と実体を対応付け中…(Claude を使用)
                </div>
              ) : !asBuilt ? (
                <div style={{ padding: 24, color: "#9ca3af", fontSize: 13, textAlign: "center" }}>
                  先に「構造マップ」で実体を解析してください。
                </div>
              ) : mapping ? (
                <>
                  <div style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#b45309" }}>
                      ※ 対応は AI の推定(確定ではありません)
                    </span>
                    <button
                      onClick={runMatch}
                      style={{ ...closeBtn, marginLeft: "auto", padding: "3px 10px", fontSize: 11 }}
                    >
                      再対応付け
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <MatchView
                      intent={flowRef.current.screens.map((s) => s.name.trim()).filter(Boolean)}
                      built={asBuilt.nodes.map((n) => pickLocalized(n.label, "ja"))}
                      mapping={mapping}
                    />
                  </div>
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 12,
                    padding: 24,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>
                    あなたの意図(画面フロー)と、実際に出来た画面を AI が対応付けます。
                    <br />
                    「頼んだ画面がどうなったか / AI が足した・作らなかった画面」が見えます。
                  </div>
                  <button
                    onClick={runMatch}
                    disabled={busy || mappingBusy}
                    style={{ ...primaryBtn, padding: "9px 18px", fontSize: 13 }}
                  >
                    意図と実体を対応付ける
                  </button>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>
                    ※ Claude を使います・対応は推定です
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 中央:意図 + マップ。キャンバスを別画面に出している間は丸ごと隠す(2枚表示にする)。 */}
        {!poppedOut && (
          <div style={canvasCol}>
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
        )}

        {/* 右:Claude Code */}
        <div style={claudeCol}>
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
