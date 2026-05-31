import { invoke } from "@tauri-apps/api/core";
import type { ScreenNode, ScreenEdge } from "../types/screen";
import { t, type Language } from "./i18n";

/**
 * Claude Code CLI を Tauri command 経由で呼び出して Screens マップを生成する
 *(Phase 3 Step 3-3、Rust 委譲版)。
 *
 * 設計判断:
 *   - JS からは `invoke("claude_check_version")` / `invoke("claude_analyze", ...)`
 *     で Rust 側に委譲。Rust が `claude.exe`(npm 配下の本体バイナリ)を直接 spawn する
 *   - 経緯: 当初は plugin-shell 経由で `claude` (CMD shim) を呼ぶ予定だったが、
 *     Rust 1.78+ の CVE-2024-24576 (BatBadBut) 緩和策で `.cmd` への複雑な引数が
 *     "batch file arguments are invalid" エラーで拒否される
 *   - 解決: `.cmd` を経由せず、`claude.cmd` の中身から発見できる `claude.exe`
 *     (npm install で配置される本体)を直接呼ぶ。`.exe` は Rust の安全チェック対象外
 *   - パスは Rust 側で `where claude` (Win) / `which claude` (Unix) → 親ディレクトリ →
 *     `node_modules/@anthropic-ai/claude-code/bin/claude.exe` で発見、ハードコード不要
 *
 * 制約・注意点:
 *   - Claude Code は公式に「他アプリの programmatic backend」としてサポートされて
 *     いるわけではない(対話 CLI 設計)。Anthropic の方針変更で動かなくなる可能性あり。
 *     その場合は Agent SDK + API キー方式へ切替が必要(Phase 4 リスクとして記録)
 *   - Rust 側の Tauri command は std::process::Command で同期実行。Tauri のスレッド
 *     プールで動くので UI ブロッキングは無し
 */

/**
 * Claude が返す JSON の schema(ScreenNode / ScreenEdge と一致)。
 * `--json-schema` フラグで CLI に渡し、構造化出力を強制。
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // 機能拡張クイックウィン 1: アプリ全体の 1-2 文要約。
    // ノーコードユーザーが「これは何のアプリか」を最初に掴むため。任意フィールド。
    appSummary: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          label: { type: "string" },
          position: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
          // 階層プレーンの所属。0 = 主フロー、1 = サブ画面、2 = さらに開く画面、3 = 最深。
          // 最大 4 階層まで(MAX_DEPTH = 3)。超過は normalizeDepth() で 3 に snap される。
          depth: { type: "integer", minimum: 0, maximum: 3 },
          // 機能拡張クイックウィン 2: ユーザー行動ラベル(短いフレーズ、10-14 字目安)。
          userIntent: { type: "string" },
          // 機能拡張クイックウィン 3: 1 ノードだけ true にする(エントリーポイント)。
          isEntryPoint: { type: "boolean" },
          detail: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              bodyNoCode: { type: "string" },
              // 機能拡張 C: 関わるファイル一覧。
              files: {
                type: "array",
                items: { type: "string" },
                maxItems: 5,
              },
              // 機能拡張クイックウィン 4: この画面で使っているデータの非技術名。
              dataUsed: {
                type: "array",
                items: { type: "string" },
                maxItems: 5,
              },
              // 機能拡張クイックウィン 5: 変更しやすさ / 影響範囲ヒント。
              changeHint: {
                type: "object",
                properties: {
                  safety: { type: "string", enum: ["easy", "neutral", "risky"] },
                  note: { type: "string" },
                },
                required: ["safety", "note"],
                additionalProperties: false,
              },
            },
            required: ["title", "body", "bodyNoCode"],
            additionalProperties: false,
          },
        },
        required: ["id", "label", "position", "depth", "detail"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          from: { type: "integer" },
          to: { type: "integer" },
          bidirectional: { type: "boolean" },
        },
        required: ["id", "from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["nodes", "edges"],
  additionalProperties: false,
} as const;

/**
 * 使用する Claude モデル名。
 *
 * Rust 側は単に `--model <値>` で受け取って claude.exe に渡すだけにし、設定値は
 * フロント側で持つ。将来の Phase 4 で設定 UI からモデルを切り替えるときに、
 * Rust ビルド不要で変更できる(Tauri は HMR されないので Rust 再ビルドは重い)。
 *
 * 値は Claude Code が認識するエイリアス。最新一覧はドキュメント参照。
 */
const CLAUDE_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT_JA = `You are a JSON-only data extraction tool for AppMap. AppMap visualizes applications as a "screen map": 画面 (screens) as nodes, transitions between them as edges.

CRITICAL OUTPUT RULE — non-negotiable:
Your final response MUST be a single JSON object matching the schema below. No prose, no markdown fences, no explanation, no preamble, no postamble. The first character of your final response must be "{" and the last must be "}". If you write any text before or after the JSON, the task fails.

PROCESS:
You will be given a folder path. Use your file-reading tools to investigate the project structure. Start with README.md, CLAUDE.md (if present), package.json, and obvious entry points (src/App.tsx, src/main.tsx, src-tauri/src/lib.rs). Read additional files only when needed for clarity. Use thinking internally — do not write your reasoning to the output.

OUTPUT SCHEMA — JSON shape:

{
  "appSummary": "<Japanese, 1-2 sentences, plain language for non-engineers; e.g. これは予約受付アプリです。ユーザーがメニューを選び、日時を指定して予約します。>",
  "nodes": [
    {
      "id": <integer, 1-indexed sequential>,
      "label": "<Japanese, under 12 chars, the tile label — technical screen name (e.g. ログイン画面, 詳細パネル)>",
      "position": { "x": <number 40-640>, "y": <number, see depth band below> },
      "depth": <integer, 0-3>,
      "userIntent": "<Japanese, 10-14 chars, action-oriented phrase from USER perspective; e.g. ログインする, 予約日時を選ぶ, アプリを設定する>",
      "isEntryPoint": <boolean — set true on EXACTLY ONE node, the screen a new user should look at first to understand the app>,
      "detail": {
        "title": "<Pure Japanese screen title. NO parenthetical English term like '(Inspector Panel)' or '(Loading)'. If you must indicate a sub-state, use Japanese parentheses too, e.g. '分析中(待機中)'>",
        "body": "<Japanese, 2-3 sentences, technical vocabulary OK: API, データベース, 認証, etc. Brand names like Bubble/Notion stay English (proper noun), but Bubble-specific FEATURE names should be in Japanese.>",
        "bodyNoCode": "<Japanese, same content as body, in vocabulary a Bubble/Notion/Glide non-engineer would use. CRITICAL: brand names (Bubble, Notion, Glide) are the ONLY English words allowed; everything else must be Japanese including feature names. NEVER write English brand-specific feature names like 'Workflow', 'Database', 'Page', 'Element Inspector', 'Settings'. Use 'ワークフロー', 'データベース', 'ページ', 'エレメント設定', '設定ページ' instead.>",
        "files": ["<project-root-relative path, forward slash, up to 5 most relevant files for this screen>"],
        "dataUsed": ["<Japanese non-technical data names; e.g. ユーザー情報, 予約情報, 商品リスト. NOT raw table names like users_table.>"],
        "changeHint": {
          "safety": "easy" | "neutral" | "risky",
          "note": "<Japanese, 1 sentence, e.g. 文言や表示順は変えやすい / ログイン条件を変えると他画面にも影響します>"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "<from-to format, e.g. \\"1-2\\">",
      "from": <integer, ScreenNode id>,
      "to": <integer, ScreenNode id>,
      "bidirectional": <boolean — true only when navigation flows both ways>
    }
  ]
}

DEPTH — required field, integer 0-3, indicates navigation hierarchy depth:

The map is rendered as N horizontal bands stacked vertically in a single flat SVG (one band per depth level present). The renderer chooses the number of bands automatically from the maximum depth in your response. Edges connecting screens across bands are drawn as straight lines between the source and target nodes — no tilt, no 3D projection.

- **depth 0** (主フロー / main flow): entry-point screens, primary navigation, top-level tabs. Where the user normally starts.
- **depth 1** (サブ画面): screens opened FROM depth-0 screens (detail panels, side modals, secondary tabs).
- **depth 2** (さらに開く画面): screens reached from depth-1 (e.g., settings → account → password change).
- **depth 3** (最深): deeply nested screens. Use sparingly; if you reach for 3 often, you're probably over-splitting.

CHOOSING DEPTH — the rule of thumb:
- Count navigation "clicks from entry" to reach the screen. depth = number of clicks (capped at 3).
- A modal opened from anywhere on depth 0 = depth 1. A modal opened from inside a depth-1 settings screen = depth 2.
- Most apps fit in depth 0-1. Depth 2-3 only when there's a clear chain of "click → opens screen → from there click → opens another screen".

HORIZONTAL LAYOUT — x coordinate:
- viewBox width is 800, node tiles are 140 wide.
- Spread nodes across x = 40-640 with at least 60px horizontal gap.
- The hub (most-connected screen) goes around x ≈ 330 of its floor.
- Within a floor, you can place children of the same parent under the parent's x position.

Y POSITIONING: AppMap places nodes vertically automatically based on depth. You may set position.y to any value — it will be overridden. Only x and depth determine layout.

EXAMPLES:
- 2-level app (depth 0-1):
  - depth 0: ログイン(60,?), ホーム(330,?), 検索(600,?)
  - depth 1: 検索結果(330,?), プロフィール(610,?)
- 3-level app (depth 0-2):
  - depth 0: ホーム(330,?)
  - depth 1: 設定(330,?), プロフィール(600,?)
  - depth 2: パスワード変更(330,?) — from 設定
- 4-level app (depth 0-3): use only when there's a genuine 4-deep chain.

CONSTRAINTS:
- Aim for 3-7 screens. Fewer than 3 = uninteresting; more than 7 = too dense to scan.
- If the app has fewer than 3 distinct screens, split logical sections (e.g. loading state, error state, empty state).
- All labels, titles, bodies in Japanese.
- Do not invent screens unsupported by the source. If unsure, omit.
- bidirectional=true only when both directions exist (e.g. open/close panel, settings in/out). Default false.

FILES field guidance (detail.files):
- Up to 5 file paths per screen, project-root relative, forward slashes only.
- Pick files that specifically implement THIS screen — not generic shared files.
  - Good: folder-picker screen → ["src/lib/folderPicker.ts", "src/components/FolderPickerButton.tsx"]
  - Bad: every screen listing package.json / tsconfig.json / the same root App.tsx.
- Order by relevance (most important first).
- If you cannot identify specific files for a screen with confidence, OMIT the field entirely. Do NOT guess paths.
- Only include paths you have actually read or seen via directory listing.

APP SUMMARY guidance (top-level appSummary):
- 1-2 sentences in Japanese, plain language for non-engineers.
- Answer "What does this app do?" from the user's perspective, not the developer's.
- Avoid jargon. Don't say "React アプリです" — say what it DOES.
- Good: "これは予約受付アプリです。ユーザーがメニューを選び、日時を指定して予約します。"
- Bad: "Tauri + React で書かれた、Claude API を呼ぶデスクトップアプリ。"
- Always include this field if you can identify the app's purpose.

USER INTENT guidance (node.userIntent):
- Short ACTION phrase from the USER's perspective, 10-14 Japanese characters.
- Use verbs the user would think (ログインする / 予約を確認する / 設定を変える), not technical screen names.
- Good: "ログインする" for LoginPage; "状況を見る" for Dashboard; "予約を確認する" for ReservationDetail.
- Bad: "ログイン画面" (this is just label translated), "認証フォーム" (technical).
- Always include if you can name the user action; omit only for screens whose purpose is unclear.

ENTRY POINT guidance (node.isEntryPoint):
- Set TRUE on EXACTLY ONE node per map. Set FALSE or OMIT on all others.
- Pick the screen a new user should look at first to understand the WHOLE app structure.
- Usually this is: the entry/home screen (depth 0), OR the most-connected hub (depth 0).
- If you cannot decide, omit on all nodes — never set true on multiple.

DATA USED guidance (detail.dataUsed):
- 1-5 short Japanese labels for the data this screen READS or WRITES.
- Use non-technical names. Refer to Bubble Data Type / Notion Database naming conventions.
- Good: "ユーザー情報", "予約情報", "商品リスト", "メッセージ履歴".
- Bad: "users", "User", "reservations_table", "products[]" (raw schema names).
- Omit if the screen doesn't visibly handle user data (e.g. a static splash screen).

SELF-CONTAINED DESCRIPTION RULE for bodyNoCode (critical):
- bodyNoCode must EXPLAIN the screen FIRST, in plain Japanese, without requiring the reader to know any Bubble/Notion/Glide feature.
- "X のような Y" analogy patterns are BANNED as the primary explanation. Reason: if the reader doesn't know X, the analogy fails and the screen remains opaque.
- Order of information inside bodyNoCode:
  1. What the screen IS and what it lets the user do (plain Japanese, self-contained)
  2. (Optional, only if it adds value) "Bubble/Notion でも似た仕組みがあります" type soft reference at the end
- Bad: "Bubble の Page navigator のような全画面マップ。" (analogy-first, requires knowing Page navigator)
- Good: "アプリの画面構成を一目で見渡せる全画面マップです。Bubble や Notion でも似た俯瞰ビューが使えます。"
- Good: "ユーザーの予約情報を一覧で確認する画面です。条件で絞り込んだり、CSV で書き出したりできます。"

JAPANESE PURITY RULE — applies to title, body, bodyNoCode, changeHint.note, and all string-valued fields except the 'files' array:
- Only these English/loan words are acceptable as-is: brand names (Bubble, Notion, Glide, AppMap, Claude, Tauri, React, Vite, npm), file paths (these go in the 'files' field), and standalone numeric/version strings.
- Mid-sentence English words like "Inspector Panel", "Page navigator", "Element Inspector", "Workflow", "Settings", "User account", "Page", "Database", "API key" must be written in Japanese:
  - Workflow → ワークフロー or 処理の流れ
  - Database → データベース
  - Page → ページ
  - User account → ユーザー情報 or ログイン情報
  - Settings → 設定 or 設定ページ
  - Inspector Panel → 詳細パネル
  - Element Inspector → エレメント設定欄
  - Page navigator → ページ一覧
  - API key → API キー(API はそのまま、key は キー)
- Titles must NOT have parenthetical English. Bad: "詳細パネル(Inspector Panel)". Good: "詳細パネル" or "画面の詳細パネル".

CHANGE HINT guidance (detail.changeHint):
- safety:
  - "easy": cosmetic / display-order / text changes that won't break other screens.
  - "neutral": local logic changes; might require checking adjacent screens.
  - "risky": shared logic (auth, navigation root, data shape) — changing this affects many screens.
- note: 1 sentence in Japanese explaining the safety level in plain words.
  - Good (easy): "文言や表示順は変えやすい。他画面には影響しません。"
  - Good (risky): "ログイン条件を変えると、ほぼ全画面に影響します。"
- Omit if you don't have enough confidence to judge.

Remember: your response is JSON only. Begin with "{". End with "}". Nothing else.`;

/**
 * 英語版 SYSTEM_PROMPT(v0.1.6)。JA 版と同じ構造・同じスキーマだが、
 * 出力言語の指示と例が英語、JAPANESE PURITY RULE は ENGLISH CLARITY RULE に置換。
 */
const SYSTEM_PROMPT_EN = `You are a JSON-only data extraction tool for AppMap. AppMap visualizes applications as a "screen map": screens as nodes, transitions between them as edges.

CRITICAL OUTPUT RULE — non-negotiable:
Your final response MUST be a single JSON object matching the schema below. No prose, no markdown fences, no explanation, no preamble, no postamble. The first character of your final response must be "{" and the last must be "}". If you write any text before or after the JSON, the task fails.

PROCESS:
You will be given a folder path. Use your file-reading tools to investigate the project structure. Start with README.md, CLAUDE.md (if present), package.json, and obvious entry points (src/App.tsx, src/main.tsx, src-tauri/src/lib.rs). Read additional files only when needed for clarity. Use thinking internally — do not write your reasoning to the output.

OUTPUT SCHEMA — JSON shape:

{
  "appSummary": "<English, 1-2 sentences, plain language for non-engineers; e.g. This is a reservation app. The user picks a menu, chooses a date and time, and books.>",
  "nodes": [
    {
      "id": <integer, 1-indexed sequential>,
      "label": "<English, under 16 chars, the tile label — a short screen name (e.g. Login, Detail panel)>",
      "position": { "x": <number 40-640>, "y": <number, see depth band below> },
      "depth": <integer, 0-3>,
      "userIntent": "<English, 14-22 chars, action-oriented phrase from USER perspective; e.g. Sign in, Pick a date, Set up the app>",
      "isEntryPoint": <boolean — set true on EXACTLY ONE node, the screen a new user should look at first to understand the app>,
      "detail": {
        "title": "<English screen title. Plain language, no jargon if avoidable. If you must indicate a sub-state, use a parenthetical, e.g. 'Analysis (loading)'>",
        "body": "<English, 2-3 sentences, technical vocabulary OK: API, database, auth, etc. Brand names like Bubble/Notion stay as-is.>",
        "bodyNoCode": "<English, same content as body, in vocabulary a Bubble/Notion/Glide non-engineer would use. Avoid raw code/tech jargon (no 'Tauri command', 'IPC', 'mutex'). Use everyday phrases ('the panel on the right', 'a list of saved items') instead. Brand-specific feature names from Bubble/Notion/Glide are OK only when the analogy actually helps; the screen must be understandable WITHOUT knowing those products.>",
        "files": ["<project-root-relative path, forward slash, up to 5 most relevant files for this screen>"],
        "dataUsed": ["<English non-technical data names; e.g. User profile, Reservations, Product list. NOT raw table names like users_table.>"],
        "changeHint": {
          "safety": "easy" | "neutral" | "risky",
          "note": "<English, 1 sentence, e.g. Wording and display order are easy to change. / Changing the sign-in condition affects almost every screen.>"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "<from-to format, e.g. \\"1-2\\">",
      "from": <integer, ScreenNode id>,
      "to": <integer, ScreenNode id>,
      "bidirectional": <boolean — true only when navigation flows both ways>
    }
  ]
}

DEPTH — required field, integer 0-3, indicates navigation hierarchy depth:

The map is rendered as N horizontal bands stacked vertically in a single flat SVG (one band per depth level present). The renderer chooses the number of bands automatically from the maximum depth in your response. Edges connecting screens across bands are drawn as straight lines between the source and target nodes — no tilt, no 3D projection.

- **depth 0** (Main flow): entry-point screens, primary navigation, top-level tabs. Where the user normally starts.
- **depth 1** (Sub screens): screens opened FROM depth-0 screens (detail panels, side modals, secondary tabs).
- **depth 2** (Detail screens): screens reached from depth-1 (e.g., settings → account → password change).
- **depth 3** (Deepest): deeply nested screens. Use sparingly; if you reach for 3 often, you're probably over-splitting.

CHOOSING DEPTH — the rule of thumb:
- Count navigation "clicks from entry" to reach the screen. depth = number of clicks (capped at 3).
- A modal opened from anywhere on depth 0 = depth 1. A modal opened from inside a depth-1 settings screen = depth 2.
- Most apps fit in depth 0-1. Depth 2-3 only when there's a clear chain of "click → opens screen → from there click → opens another screen".

HORIZONTAL LAYOUT — x coordinate:
- viewBox width is 800, node tiles are 140 wide.
- Spread nodes across x = 40-640 with at least 60px horizontal gap.
- The hub (most-connected screen) goes around x ≈ 330 of its floor.
- Within a floor, you can place children of the same parent under the parent's x position.

Y POSITIONING: AppMap places nodes vertically automatically based on depth. You may set position.y to any value — it will be overridden. Only x and depth determine layout.

EXAMPLES:
- 2-level app (depth 0-1):
  - depth 0: Login(60,?), Home(330,?), Search(600,?)
  - depth 1: Search results(330,?), Profile(610,?)
- 3-level app (depth 0-2):
  - depth 0: Home(330,?)
  - depth 1: Settings(330,?), Profile(600,?)
  - depth 2: Change password(330,?) — from Settings
- 4-level app (depth 0-3): use only when there's a genuine 4-deep chain.

CONSTRAINTS:
- Aim for 3-7 screens. Fewer than 3 = uninteresting; more than 7 = too dense to scan.
- If the app has fewer than 3 distinct screens, split logical sections (e.g. loading state, error state, empty state).
- All labels, titles, bodies in English.
- Do not invent screens unsupported by the source. If unsure, omit.
- bidirectional=true only when both directions exist (e.g. open/close panel, settings in/out). Default false.

FILES field guidance (detail.files):
- Up to 5 file paths per screen, project-root relative, forward slashes only.
- Pick files that specifically implement THIS screen — not generic shared files.
  - Good: folder-picker screen → ["src/lib/folderPicker.ts", "src/components/FolderPickerButton.tsx"]
  - Bad: every screen listing package.json / tsconfig.json / the same root App.tsx.
- Order by relevance (most important first).
- If you cannot identify specific files for a screen with confidence, OMIT the field entirely. Do NOT guess paths.
- Only include paths you have actually read or seen via directory listing.

APP SUMMARY guidance (top-level appSummary):
- 1-2 sentences in English, plain language for non-engineers.
- Answer "What does this app do?" from the user's perspective, not the developer's.
- Avoid jargon. Don't say "It's a React app" — say what it DOES.
- Good: "This is a reservation app. The user picks a menu, chooses a date and time, and books."
- Bad: "A desktop app written in Tauri + React that calls the Claude API."
- Always include this field if you can identify the app's purpose.

USER INTENT guidance (node.userIntent):
- Short ACTION phrase from the USER's perspective, 14-22 English characters.
- Use verbs the user would think (Sign in / Check the booking / Tweak settings), not technical screen names.
- Good: "Sign in" for LoginPage; "See status" for Dashboard; "Check a booking" for ReservationDetail.
- Bad: "Login screen" (this is just the label), "Auth form" (technical).
- Always include if you can name the user action; omit only for screens whose purpose is unclear.

ENTRY POINT guidance (node.isEntryPoint):
- Set TRUE on EXACTLY ONE node per map. Set FALSE or OMIT on all others.
- Pick the screen a new user should look at first to understand the WHOLE app structure.
- Usually this is: the entry/home screen (depth 0), OR the most-connected hub (depth 0).
- If you cannot decide, omit on all nodes — never set true on multiple.

DATA USED guidance (detail.dataUsed):
- 1-5 short English labels for the data this screen READS or WRITES.
- Use non-technical names. Refer to Bubble Data Type / Notion Database naming conventions.
- Good: "User profile", "Reservations", "Product list", "Chat history".
- Bad: "users", "User", "reservations_table", "products[]" (raw schema names).
- Omit if the screen doesn't visibly handle user data (e.g. a static splash screen).

SELF-CONTAINED DESCRIPTION RULE for bodyNoCode (critical):
- bodyNoCode must EXPLAIN the screen FIRST, in plain English, without requiring the reader to know any Bubble/Notion/Glide feature.
- "Like X in Y" analogy patterns are BANNED as the primary explanation. Reason: if the reader doesn't know X, the analogy fails and the screen remains opaque.
- Order of information inside bodyNoCode:
  1. What the screen IS and what it lets the user do (plain English, self-contained)
  2. (Optional, only if it adds value) "Bubble/Notion has a similar feature" type soft reference at the end
- Bad: "An overview map like Bubble's Page navigator." (analogy-first, requires knowing Page navigator)
- Good: "An overview map that shows every screen of the app at a glance. Bubble and Notion have similar overview views."
- Good: "Lists every reservation in one place. You can filter by conditions or export to CSV."

ENGLISH CLARITY RULE — applies to title, body, bodyNoCode, changeHint.note, and all string-valued fields except the 'files' array:
- Write natural English. Avoid forced literal-translation phrasings.
- Don't sprinkle Japanese loanwords or romaji unless they are universal brand names (Bubble, Notion, Glide, AppMap, Claude, Tauri, React, Vite, npm).
- Titles must not have parenthetical Japanese. Plain English only.

CHANGE HINT guidance (detail.changeHint):
- safety:
  - "easy": cosmetic / display-order / text changes that won't break other screens.
  - "neutral": local logic changes; might require checking adjacent screens.
  - "risky": shared logic (auth, navigation root, data shape) — changing this affects many screens.
- note: 1 sentence in English explaining the safety level in plain words.
  - Good (easy): "Wording and display order are easy to change. Other screens are unaffected."
  - Good (risky): "Changing the sign-in condition affects almost every screen."
- Omit if you don't have enough confidence to judge.

Remember: your response is JSON only. Begin with "{". End with "}". Nothing else.`;

/**
 * v0.1.6: 言語に応じて SYSTEM_PROMPT を選ぶ。JA / EN で本質スキーマは同じ。
 */
function buildSystemPrompt(language: Language): string {
  return language === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_JA;
}

const USER_PROMPT_TEMPLATE = (folder: string) =>
  `Analyze the application at "${folder}" and output the Screens map JSON.

Output JSON only (begin with {, end with }, no prose, no markdown).`;

export type ScreenMapResult = {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  /**
   * 機能拡張クイックウィン 1: アプリ全体の 1-2 文要約(非エンジニア向け)。
   * AI が判断できなければ undefined。
   */
  appSummary?: string;
};

/**
 * Claude Code の result envelope から取れる分析メタ情報。
 * Pro/Max 定額枠の感覚を掴むために UI でコストと経過時間を見せる用。
 */
export type AnalysisOutcome = {
  screens: ScreenMapResult;
  costUsd: number | null;
  durationMs: number | null;
};

/**
 * Claude CLI が起動できるか確認(`claude_check_version` を invoke)。
 * 戻り値: 成功なら version 文字列、失敗なら null。
 */
export async function checkClaudeAvailable(): Promise<string | null> {
  try {
    const version = await invoke<string>("claude_check_version");
    return version;
  } catch (err) {
    console.warn("claude_check_version failed:", err);
    return null;
  }
}

/**
 * Node.js が PATH 上にあるか確認(機能拡張 Option A:アプリ内セットアップ)。
 * 戻り値: 成功なら "v22.x.x" 等の文字列、失敗なら null。
 */
export async function checkNodeAvailable(): Promise<string | null> {
  try {
    const version = await invoke<string>("node_check_version");
    return version;
  } catch (err) {
    console.warn("node_check_version failed:", err);
    return null;
  }
}

/**
 * Claude Code CLI を npm install -g で入れる(Option A 自動セットアップ)。
 *
 * 成功: stdout を返す。失敗: throw する。Mac の EACCES エラーは呼び出し側で
 * stderr を見て「sudo を勧めるトースト」を出す想定。
 */
export async function installClaudeCode(): Promise<string> {
  return await invoke<string>("install_claude_code");
}

/**
 * claude login を起動(Option A 自動セットアップ)。
 *
 * 内部でブラウザが開き、OAuth フローが走る。ユーザーがブラウザで完了するまで
 * Promise は resolve しない(Rust 側で `.output()` 待ち)。spawn_blocking
 * なので UI は固まらない。
 */
export async function runClaudeLogin(): Promise<string> {
  return await invoke<string>("claude_login");
}

/**
 * フォルダパスを Claude CLI に渡してマップを生成。
 *
 * Rust 側の `claude_analyze` Tauri command を invoke して、stdout 文字列を受取り、
 * JSON としてパース → ScreenMapResult に整形して返す。
 *
 * v0.1.6: language を受けて SYSTEM_PROMPT を JA / EN 切替、エラー文言も i18n 化。
 *   - JA: 既存挙動。出力は日本語、cleanupEnglishInJapanese で英単語を救済。
 *   - EN: 出力は英語、cleanupEnglishInJapanese はスキップ(英文をカタカナ化しないため)。
 */
export async function analyzeFolderToScreenMap(
  folder: string,
  language: Language = "ja",
): Promise<AnalysisOutcome> {
  const M = t(language).claude;
  let stdout: string;
  try {
    stdout = await invoke<string>("claude_analyze", {
      folder,
      userPrompt: USER_PROMPT_TEMPLATE(folder),
      systemPrompt: buildSystemPrompt(language),
      schema: JSON.stringify(RESPONSE_SCHEMA),
      model: CLAUDE_MODEL,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.toLowerCase().includes("auth") ||
      msg.toLowerCase().includes("login") ||
      msg.toLowerCase().includes("unauthorized")
    ) {
      throw new Error(M.notAuthenticated);
    }
    throw new Error(M.analyzeFailed(msg));
  }

  // stdout を JSON として解釈
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      M.notJson(
        err instanceof Error ? err.message : String(err),
        stdout.slice(0, 500),
      ),
    );
  }

  // unwrap 前にエンベロープのメタ情報(cost, duration)を抽出
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
    if (typeof obj.duration_ms === "number") durationMs = obj.duration_ms;
  }

  // Claude Code の `--output-format json` が通常エンベロープに包む可能性あり。
  // 直接 nodes/edges があればそれを優先、なければエンベロープから探す。
  const screens = unwrapResult(parsed);

  if (!isScreenMapResult(screens)) {
    // partner フィードバック 2026-05-16 提案:Claude Code CLI が出力仕様を将来また
    // 変えたときのデバッグを楽にするため、`structured_output` と `result` を両方
    // それぞれ最大 1000 文字までダンプする(片方しか見えないと診断不能になる)。
    console.error("[AppMap] Full Claude response envelope:", parsed);

    const sections: string[] = [];
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;

      const so = obj.structured_output;
      if (so !== undefined) {
        const text = typeof so === "string" ? so : JSON.stringify(so);
        sections.push(M.structuredOutputPreview(text.slice(0, 1000)));
      }

      if (typeof obj.result === "string") {
        sections.push(M.resultPreview(obj.result.slice(0, 1000)));
      } else if (obj.result !== undefined) {
        sections.push(
          M.resultPreviewTyped(
            typeof obj.result,
            JSON.stringify(obj.result).slice(0, 1000),
          ),
        );
      }
    }

    const detail =
      sections.length > 0
        ? sections.join("\n\n---\n\n")
        : JSON.stringify(parsed).slice(0, 1000);

    throw new Error(M.noNodesEdges(detail));
  }

  // Defensive: depth 正規化 + グラフ整合性 + isEntryPoint 単一化(共通関数)
  // v0.1.6: EN 出力時は cleanupEnglishInJapanese を適用しない(英文をカタカナ化しないため)。
  const sanitizedScreens = normalizeAndSanitizeScreenMap(screens, language);

  return { screens: sanitizedScreens, costUsd, durationMs };
}

/** 描画できる最大階層(0 始まりなので、4 階層 = 0,1,2,3)。 */
export const MAX_DEPTH = 3;

/**
 * 旧プロンプト時代の AI 出力(localStorage に残っている)に混入している
 * 英単語を、日本語に置き換える「読みやすさレスキュー」。
 *
 * 方針:
 *   1. 純英字のかっこ書き(例:"詳細パネル(Inspector Panel)")は除去
 *   2. ブランド固有機能名の英語表記は日本語(主にカタカナ)に置換
 *   3. ブランド名そのもの(Bubble / Notion / Glide / AppMap)は固有名詞として残す
 *
 * 残課題:再分析で取得した新出力にはプロンプト側で予防済み(英単語禁止ルール)。
 * これは旧データ向けの後始末。
 */
const ENGLISH_FEATURE_REPLACEMENTS: Array<[RegExp, string]> = [
  // 1. ブランド + 英修飾語 → ブランド単体
  //    「Bubble editor」「Notion editor」「Glide app」などをブランド名だけに削る。
  //    "editor / app / workflow / page / database / element / admin / console /
  //     dashboard" は AI が機能の固有名詞っぽく使いがちな英修飾語。
  [
    /\b(Bubble|Notion|Glide)\s+(?:editor|app|workflow|workflows|page|pages|database|databases|element|elements|admin|console|dashboard)\b/gi,
    "$1",
  ],

  // 2. 複合語(長いもの優先で先に処理)
  [/\bPage navigator\b/gi, "ページ一覧"],
  [/\bInspector Panel\b/gi, "詳細パネル"],
  [/\bElement Inspector\b/gi, "エレメント詳細"],
  [/\bAPI key\b/gi, "API キー"],
  [/\bUser account\b/gi, "ユーザー情報"],

  // 3. 単語(語境界付き、ブランド名以外)
  [/\bWorkflows?\b/g, "ワークフロー"],
  [/\bDatabases?\b/g, "データベース"],
  [/\bSettings\b/g, "設定"],
  [/\bPage\b/g, "ページ"],

  // 4. アナロジー導入句の除去:文頭(または「。」の直後)で
  //    「Bubble の X のような / Notion の X に対応する / Glide の X と同じ」
  //    パターンを削る。「X」を知らないとアナロジーが機能しないので、
  //    アンカーを丸ごと取り去って後続の名詞を主役にする。
  //
  //    例: "Bubble の ページ一覧 のような全画面マップ。" → "全画面マップ。"
  //
  //    「に近い」を入れると "近い感覚で" のような後ろの語を貪欲に飲み込んでしまうので
  //    含めない(「のような / に対応する / に相当する / と同じ」だけに限定)。
  [
    /(^|[。\n]\s*)(?:Bubble|Notion|Glide)\s*の\s+[^。]+?(?:のような|に対応する|に相当する|と同じ)\s*/g,
    "$1",
  ],
];

/**
 * 文字列中の英単語を日本語に正規化する(旧データ向けレスキュー)。
 *   - "詳細パネル(Inspector Panel)" → "詳細パネル"
 *   - "Bubble editor の Page navigator" → "Bubble editor の ページ一覧"
 *   - "Workflow が走る" → "ワークフロー が走る"
 */
export function cleanupEnglishInJapanese(text: string): string {
  if (!text) return text;
  let result = text;

  // 1) 純英字パレンセティカル除去:詳細パネル(Inspector Panel) → 詳細パネル
  //    かっこ内が ASCII 英字 + 空白だけのときに限り、かっこごと削除
  result = result.replace(/\s*\([A-Za-z][A-Za-z0-9\s\-]*\)/g, "");

  // 2) ブランド固有機能名を日本語に置換(長い順)
  for (const [pattern, replacement] of ENGLISH_FEATURE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  // 3) 連続する半角空白を 1 つにまとめる(置換でできた変な余白を整える)
  result = result.replace(/  +/g, " ");

  return result.trim();
}

/**
 * 既存の ScreenMapResult(AI 出力 or localStorage 復元データ)を、最新の
 * 検証ルールに通して安全化する。
 *
 *   - depth を {0..MAX_DEPTH} に正規化(欠落・NaN・範囲外を救う)
 *   - sanitize で dangling edge / 重複 id / 非有限座標 / 複数 isEntryPoint を整える
 *
 * Codex review 2026-05-11 (round 3) Med #3 対応:localStorage から復元した
 * 古い形式の履歴も、この関数を通せばランタイムで現行ルールに合うようになる。
 *
 * v0.1.6: language を受けて、EN 出力にはレスキューを適用しない(英文を壊さないため)。
 *   呼出箇所:
 *     - analyzeFolderToScreenMap → 現在の UI 言語を渡す
 *     - App.tsx の localStorage 復元 → デフォルト "ja"(既存データは日本語前提)
 */
export function normalizeAndSanitizeScreenMap(
  screens: ScreenMapResult,
  language: Language = "ja",
): ScreenMapResult {
  // EN モードでは英文を壊さないために cleanup を identity に置換
  const clean: (s: string) => string =
    language === "en" ? (s) => s : cleanupEnglishInJapanese;
  const normalized: ScreenMapResult = {
    nodes: screens.nodes.map((n) => ({
      ...n,
      depth: normalizeDepth(n.depth, n.position.y),
      label: clean(n.label),
      userIntent: n.userIntent ? clean(n.userIntent) : n.userIntent,
      detail: {
        ...n.detail,
        title: clean(n.detail.title),
        body: clean(n.detail.body),
        bodyNoCode: clean(n.detail.bodyNoCode),
        changeHint: n.detail.changeHint
          ? {
              ...n.detail.changeHint,
              note: clean(n.detail.changeHint.note),
            }
          : n.detail.changeHint,
      },
    })),
    edges: screens.edges,
    appSummary: screens.appSummary ? clean(screens.appSummary) : screens.appSummary,
  };
  return sanitizeScreens(normalized);
}

/**
 * depth を {0, 1, 2, 3} のいずれかに正規化する(4 階層対応版)。
 *
 * 戦略:
 *   - 数値で finite なら round して [0, MAX_DEPTH] に clamp
 *   - 欠落 / NaN / Infinity → y 位置から推測。古い 2 階層分割を踏襲し、
 *     180 未満なら 0、それ以上なら 1(過去ストレージとの互換)
 *
 * これがないと、AI が depth=999 や 文字列 を返したときに MapCanvas の
 * depthFilter に引っかからずノードが静かに消える(2026-05-11 Codex review High)。
 */
function normalizeDepth(rawDepth: unknown, y: number): number {
  if (typeof rawDepth !== "number" || !Number.isFinite(rawDepth)) {
    return y < 180 ? 0 : 1;
  }
  return Math.min(MAX_DEPTH, Math.max(0, Math.round(rawDepth)));
}

/**
 * グラフとしての整合性をチェックし、壊れた要素を drop する。
 *
 * - 非有限な position を持つノードを drop
 * - id が重複するノードは最初の 1 件だけ残し、後続を drop
 * - from / to が実在 node id を指さない edge を drop
 *
 * いずれも console.warn でログを残し、UI には残った正常分だけ流す。これにより
 * 部分的に壊れた応答でも「動くマップが見える」グレースフルデグラデーションになる。
 */
function sanitizeScreens(screens: ScreenMapResult): ScreenMapResult {
  // 1) 非有限座標を drop
  const finitePositionNodes = screens.nodes.filter((n) => {
    const ok = Number.isFinite(n.position.x) && Number.isFinite(n.position.y);
    if (!ok) {
      console.warn(
        `[AppMap] Dropping node id=${n.id} (${n.label}): non-finite position`,
        n.position,
      );
    }
    return ok;
  });

  // 2) id 重複を drop(最初の 1 件勝ち)
  const seenIds = new Set<number>();
  const dedupedNodes = finitePositionNodes.filter((n) => {
    if (seenIds.has(n.id)) {
      console.warn(`[AppMap] Dropping duplicate node id=${n.id} (${n.label})`);
      return false;
    }
    seenIds.add(n.id);
    return true;
  });

  // 3) dangling edge を drop
  const validIds = new Set(dedupedNodes.map((n) => n.id));
  const validEdges = screens.edges.filter((e) => {
    const ok = validIds.has(e.from) && validIds.has(e.to);
    if (!ok) {
      console.warn(
        `[AppMap] Dropping edge id=${e.id}: dangling endpoint ${e.from}→${e.to}`,
      );
    }
    return ok;
  });

  // 4) isEntryPoint は 1 ノード限定。AI が複数 true を返したら、最初の 1 件
  //    だけ残し、残りは false に reset(Codex review 2026-05-11 round 3 Med #4)。
  //    全部に「▶ まずここ」が出る悲しい事故を防ぐ。
  let entryPointFound = false;
  const entryUniqueNodes = dedupedNodes.map((n) => {
    if (!n.isEntryPoint) return n;
    if (entryPointFound) {
      console.warn(
        `[AppMap] Dropping extra isEntryPoint=true on node id=${n.id} (${n.label})`,
      );
      return { ...n, isEntryPoint: false };
    }
    entryPointFound = true;
    return n;
  });

  return {
    nodes: entryUniqueNodes,
    edges: validEdges,
    appSummary: screens.appSummary,
  };
}

/**
 * Claude Code の `--output-format json` は通常エンベロープに包む:
 *   { "type": "result", "subtype": "success", "result": "<text>", ... }
 *
 * `result` フィールドは **文字列**(モデルの最終応答)。理想的には JSON 文字列だが、
 * Markdown コードブロックや単に JSON 含むテキストの可能性もある。複数のパターンを試す:
 *   1. parsed 自体が {nodes, edges} → そのまま使う
 *   2. parsed.result / .output / .data / etc. がオブジェクトで {nodes, edges} → それ
 *   3. parsed.result が文字列 → JSON.parse 試行 → {nodes, edges} なら使う
 *   4. parsed.result が文字列 → ```json ... ``` 抽出 → 試す
 *   5. parsed.result が文字列 → 最初の { ... } ブロックを抽出 → 試す
 */
function unwrapResult(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const obj = parsed as Record<string, unknown>;
  if (isScreenMapResult(obj)) return obj;

  // v0.1.0 配布後 partner フィードバック 2026-05-16 修正 3:
  // Claude Code CLI v2.1+ で `--json-schema` 指定時の出力形式が変わり、本体 JSON が
  // `structured_output` フィールドにオブジェクトのまま入るようになった(`result` には
  // 人間向けサマリ自然文)。`structured_output` を最優先で見るよう先頭に追加。
  for (const key of [
    "structured_output",
    "result",
    "output",
    "data",
    "response",
    "message",
  ]) {
    if (!(key in obj)) continue;
    const value = obj[key];

    // Case: nested object
    if (typeof value === "object" && value !== null) {
      const inner = unwrapResult(value);
      if (isScreenMapResult(inner)) return inner;
    }

    // Case: string — try several extraction strategies
    if (typeof value === "string") {
      const extracted = extractJsonFromString(value);
      if (extracted !== null && isScreenMapResult(extracted)) return extracted;
    }
  }
  return parsed;
}

/**
 * 文字列から JSON オブジェクトを取り出す試行を順に行う。
 *   1. 文字列全体を JSON.parse
 *   2. ```json ... ``` で囲まれたコードブロックから抽出
 *   3. 最初の `{` から対応する `}` までの中身を抽出(バランス取り)
 */
function extractJsonFromString(s: string): unknown {
  // 1. 全体パース
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }

  // 2. Markdown コードブロック
  const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      /* fall through */
    }
  }

  // 3. 中括弧バランス取りで最初のオブジェクトを抽出
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/**
 * ScreenNode 1 件の型検証。Claude が `--json-schema` を無視/緩く解釈する可能性に
 * 備えて、UI が必要とするフィールドが揃っているかを実行時に厳密にチェックする。
 *
 * これがないと、不正な応答(例: position が missing、id が文字列)が NodeTile まで
 * 流れてきて `node.position.x` で undefined エラー → 画面が真っ白で原因不明、になる。
 */
function isScreenNode(v: unknown): v is ScreenNode {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;

  if (typeof n.id !== "number") return false;
  if (typeof n.label !== "string") return false;

  if (typeof n.position !== "object" || n.position === null) return false;
  const pos = n.position as Record<string, unknown>;
  if (typeof pos.x !== "number" || typeof pos.y !== "number") return false;

  if (typeof n.detail !== "object" || n.detail === null) return false;
  const detail = n.detail as Record<string, unknown>;
  if (
    typeof detail.title !== "string" ||
    typeof detail.body !== "string" ||
    typeof detail.bodyNoCode !== "string"
  ) {
    return false;
  }
  // files は省略可。あれば string[] でなければならない(機能拡張 C)。
  if ("files" in detail) {
    if (!Array.isArray(detail.files)) return false;
    if (!detail.files.every((f) => typeof f === "string")) return false;
  }
  // dataUsed は省略可、あれば string[](クイックウィン 4)
  if ("dataUsed" in detail) {
    if (!Array.isArray(detail.dataUsed)) return false;
    if (!detail.dataUsed.every((d) => typeof d === "string")) return false;
  }
  // changeHint は省略可、あれば { safety, note } 形(クイックウィン 5)
  if ("changeHint" in detail) {
    const hint = detail.changeHint;
    if (typeof hint !== "object" || hint === null) return false;
    const h = hint as Record<string, unknown>;
    if (
      h.safety !== "easy" &&
      h.safety !== "neutral" &&
      h.safety !== "risky"
    ) {
      return false;
    }
    if (typeof h.note !== "string") return false;
  }

  // depth は省略可。あれば number でなければならない(NaN は通すが致命ではない)。
  if ("depth" in n && typeof n.depth !== "number") return false;
  // userIntent / isEntryPoint は省略可、ある場合は型確認(クイックウィン 2/3)
  if ("userIntent" in n && typeof n.userIntent !== "string") return false;
  if ("isEntryPoint" in n && typeof n.isEntryPoint !== "boolean") return false;

  return true;
}

/** ScreenEdge 1 件の型検証。bidirectional は省略可。 */
function isScreenEdge(v: unknown): v is ScreenEdge {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string") return false;
  if (typeof e.from !== "number") return false;
  if (typeof e.to !== "number") return false;
  if ("bidirectional" in e && typeof e.bidirectional !== "boolean") return false;
  return true;
}

function isScreenMapResult(v: unknown): v is ScreenMapResult {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return false;
  if (!obj.nodes.every(isScreenNode)) return false;
  if (!obj.edges.every(isScreenEdge)) return false;
  // appSummary は省略可、あれば string(クイックウィン 1)
  if ("appSummary" in obj && typeof obj.appSummary !== "string") return false;
  return true;
}
