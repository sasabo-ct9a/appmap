/**
 * 「突き合わせ」ビュー:意図(左)と実体(右)の画面を並べ、AI が推測した対応を点線で結ぶ。
 *
 * 重要(§6.6):対応は AI の推定(◐)であって確定ではない。特に意図の名前が空/曖昧(画面4 等)だと
 * 当て推量になる。だから線は点線(=推定)にし、呼び出し側で「AI 推定」と明示する。
 *   - 実体にしか無い画面 = AI が独自に追加(緑)
 *   - 意図にしか無い画面 = 未実装かも(橙)
 */
import { type CSSProperties } from "react";

export type MatchPair = { built: string; intent: string | null };

const BOX_W = 150;
const BOX_H = 46;
const PITCH = 64;
const LEFT_X = 10;
const RIGHT_X = 250;
const PAD = 12;

/** Claude の応答テキストから対応表 JSON を頑健に取り出す。壊れていれば全て「AI追加」に倒す。 */
export function parseMapping(raw: string, builtNames: string[]): MatchPair[] {
  const fallback = () => builtNames.map((b) => ({ built: b, intent: null }));
  try {
    const m = raw.match(/\[[\s\S]*\]/); // フェンスや前後テキストがあっても最初の配列を拾う
    const arr: unknown = JSON.parse(m ? m[0] : raw);
    if (!Array.isArray(arr)) return fallback();
    const out: MatchPair[] = [];
    for (const item of arr) {
      const o = item as { built?: unknown; intent?: unknown };
      if (o && typeof o.built === "string") {
        out.push({ built: o.built, intent: typeof o.intent === "string" ? o.intent : null });
      }
    }
    // 応答に抜けた実体画面は intent=null(=AI追加扱い)で補完。
    const covered = new Set(out.map((o) => o.built));
    builtNames.forEach((b) => {
      if (!covered.has(b)) out.push({ built: b, intent: null });
    });
    return out.length ? out : fallback();
  } catch {
    return fallback();
  }
}

const box = (tint?: "add" | "miss"): CSSProperties => ({
  position: "absolute",
  width: BOX_W,
  boxSizing: "border-box",
  padding: "6px 8px",
  borderRadius: 8,
  fontSize: 12,
  background: tint === "add" ? "#ecfdf5" : tint === "miss" ? "#fffbeb" : "#fff",
  border:
    "1px solid " + (tint === "add" ? "#6ee7b7" : tint === "miss" ? "#fcd34d" : "#cbd5e1"),
  color: "#111827",
  lineHeight: 1.3,
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
});

export function MatchView({
  intent,
  built,
  mapping,
}: {
  intent: string[];
  built: string[];
  mapping: MatchPair[];
}) {
  const builtToIntent = new Map<string, string | null>();
  mapping.forEach((m) => builtToIntent.set(m.built, m.intent));
  const matchedIntents = new Set(
    mapping.map((m) => m.intent).filter((x): x is string => !!x),
  );
  const intentIndex = new Map(intent.map((n, i) => [n, i] as const));
  const height = Math.max(intent.length, built.length, 1) * PITCH + PAD * 2;

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", background: "#fff" }}>
      <div
        style={{
          display: "flex",
          padding: "4px 10px 2px",
          fontSize: 11,
          color: "#6b7280",
        }}
      >
        <div style={{ width: RIGHT_X - LEFT_X }}>意図(あなたが描いた)</div>
        <div>実体(実際に出来た)</div>
      </div>
      <div style={{ position: "relative", width: RIGHT_X + BOX_W + 20, height }}>
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height, pointerEvents: "none" }}
        >
          {built.map((b, bi) => {
            const it = builtToIntent.get(b);
            if (!it) return null;
            const ii = intentIndex.get(it);
            if (ii === undefined) return null;
            const y1 = PAD + ii * PITCH + BOX_H / 2;
            const y2 = PAD + bi * PITCH + BOX_H / 2;
            return (
              <line
                key={bi}
                x1={LEFT_X + BOX_W}
                y1={y1}
                x2={RIGHT_X}
                y2={y2}
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            );
          })}
        </svg>
        {intent.map((n, i) => {
          const miss = !matchedIntents.has(n);
          return (
            <div key={"i" + i} style={{ ...box(miss ? "miss" : undefined), left: LEFT_X, top: PAD + i * PITCH }}>
              <div
                style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {n}
              </div>
              {miss ? <div style={{ fontSize: 10, color: "#b45309" }}>未実装かも</div> : null}
            </div>
          );
        })}
        {built.map((b, i) => {
          const added = !builtToIntent.get(b);
          return (
            <div key={"b" + i} style={{ ...box(added ? "add" : undefined), left: RIGHT_X, top: PAD + i * PITCH }}>
              <div
                style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {b}
              </div>
              {added ? <div style={{ fontSize: 10, color: "#0f766e" }}>＋AIが追加</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
