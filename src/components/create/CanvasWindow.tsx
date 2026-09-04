/**
 * キャンバス専用ウィンドウ(制作モードの「別画面で全画面」表示)。
 *
 * 方針(案1 + 追加要望):キャンバスだけでなく「目的 / 期待アウトプット入力 + この流れで作る」も
 * この独立ウィンドウにまとめて全画面表示する。状態の本体は本ウィンドウ(プレビュー+Claude)が
 * 持つので、ここでは Tauri イベントで同期する:
 *   - mount:canvas:ready を送る → 本ウィンドウが canvas:init(目的/出力/フロー)を返す。
 *   - 入力:desc/output/flow/target の変化を canvas:* で送る。
 *   - 「この流れで作る」:canvas:generate(目的/出力/フロー)を送り、本ウィンドウが生成する。
 *   - busy:本ウィンドウから canvas:busy を受け、二重押しを防ぐ。
 *   - 「本画面に戻す」:canvas:close を送って自ウィンドウを閉じる。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ScreenFlowEditor, { type FlowData } from "./ScreenFlowEditor";

const EMPTY: FlowData = { screens: [], edges: [] };

type InitPayload = { desc: string; output: string; flow: FlowData };

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 13,
  color: "#111827",
  background: "#fff",
  outline: "none",
  boxSizing: "border-box",
};
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "#6b7280",
  marginBottom: 4,
};

export function CanvasWindow() {
  const [initial, setInitial] = useState<FlowData>(EMPTY);
  const [ready, setReady] = useState(false);
  const [desc, setDesc] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasFlow, setHasFlow] = useState(false);
  const flowRef = useRef<FlowData>(EMPTY);

  useEffect(() => {
    const uns: Array<() => void> = [];
    let alive = true;
    void (async () => {
      uns.push(
        await listen<InitPayload>("canvas:init", (e) => {
          const p = e.payload;
          if (!p) return;
          setDesc(p.desc ?? "");
          setOutput(p.output ?? "");
          const f = p.flow ?? EMPTY;
          setInitial(f);
          flowRef.current = f;
          setHasFlow(f.screens.length > 0);
          setReady(true);
        }),
      );
      uns.push(await listen<boolean>("canvas:busy", (e) => setBusy(!!e.payload)));
      if (!alive) {
        uns.forEach((u) => u());
        return;
      }
      await emit("canvas:ready");
    })();
    return () => {
      alive = false;
      uns.forEach((u) => u());
    };
  }, []);

  const goBack = async () => {
    await emit("canvas:close");
    await getCurrentWindow().close();
  };

  const canGenerate = !busy && (desc.trim().length > 0 || hasFlow);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#f9fafb" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
        }}
      >
        <strong style={{ fontSize: 13 }}>キャンバス(全画面)</strong>
        <span style={{ fontSize: 11, color: busy ? "#0f766e" : "#9ca3af" }}>
          {busy ? "本ウィンドウで生成中…" : "編集は本ウィンドウ(プレビュー / Claude)に同期されます"}
        </span>
        <button
          onClick={goBack}
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 7,
            fontSize: 13,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          本画面に戻す
        </button>
      </div>

      {ready ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 12, gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <label style={{ flex: 1 }}>
              <span style={labelStyle}>システムの目的</span>
              <input
                value={desc}
                onChange={(e) => {
                  setDesc(e.target.value);
                  void emit("canvas:desc", e.target.value);
                }}
                placeholder="例:登録した人に天気を定時でメールする"
                style={inputStyle}
              />
            </label>
            <button
              onClick={() =>
                void emit("canvas:generate", { desc, output, flow: flowRef.current })
              }
              disabled={!canGenerate}
              style={{
                background: canGenerate ? "#14b8a6" : "#9ae6d8",
                color: "#fff",
                border: "none",
                borderRadius: 7,
                fontWeight: 600,
                fontSize: 13,
                padding: "9px 16px",
                whiteSpace: "nowrap",
                cursor: canGenerate ? "pointer" : "not-allowed",
              }}
            >
              {busy ? "作成中…" : "この流れで作る"}
            </button>
          </div>
          <label>
            <span style={labelStyle}>期待するユーザーへのアウトプット内容</span>
            <input
              value={output}
              onChange={(e) => {
                setOutput(e.target.value);
                void emit("canvas:output", e.target.value);
              }}
              placeholder="例:毎朝、その日の天気がメールで届く"
              style={inputStyle}
            />
          </label>
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <ScreenFlowEditor
              key="canvas-window"
              initial={initial}
              onTargetChange={(t) => {
                void emit("canvas:target", t);
              }}
              onChange={(f) => {
                flowRef.current = f;
                setHasFlow(f.screens.length > 0);
                void emit("canvas:flow", f);
              }}
            />
          </div>
        </div>
      ) : (
        <div style={{ padding: 20, color: "#9ca3af", fontSize: 13 }}>読み込み中…</div>
      )}
    </div>
  );
}
