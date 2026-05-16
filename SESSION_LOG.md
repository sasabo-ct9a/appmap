# AppMap Session Log

> 各セッションの達成事項・判断履歴・次回への引き継ぎを記録する。最新が上。

---

## 2026-05-10 — 方針転換: スライドショー → マップ製品(コードは未変更、ドキュメントのみ)

### 経緯と診断

旧 Phase 2 で「ヘッダー + 5 枚カード順送り + 進行ドット + 戻る/次へボタン」を実装中、Step 3(Card 表示)まで進んだ時点で **方針転換**。発見はユーザー側 — デザインシステム v1.0(添付 4 枚)を見直したところ、製品の本質が「マップ」であることが明確になった:

- ブランドコンセプト「A map that makes AI-built apps understandable」
- ウェブサイトのヒーロー「See the map. Understand the app.」
- アプリアイコン 4 案すべてマップ系
- Product UI Preview もマップ表示

ところが Phase 2 実装は「5 枚カード順送り」になっており、デザインシステムから外れた別製品を作りかけていた。

**根本原因:** CLAUDE.md §3.2「段階的開示」が `5 枚程度のカードに圧縮 → 順に開示` と書かれており、これを Claude Code(私)が「スライドショー」と解釈してしまった。本来は「マップ上で抽象レベルを下げて開示」と読むべきだった。これは Claude Code の責任ではなく、上流の方針(CLAUDE.md)の解釈余地が広すぎたことが原因(ユーザー本人がそう明言)。

### 達成(本日のドキュメント整備、コードは未変更)

CLAUDE.md を「マップ製品」前提に全面書き直し:

| セクション | 変更内容 |
|---|---|
| §1「解決アプローチ」項目 1 | 「5 枚程度のカードに圧縮」→「1 枚のマップに構造化(画面・データ・処理の関係を視覚的に見せる)」 |
| §3.2「段階的開示」 | 「これは分かった、次へ」→「俯瞰 → 個別ノード → 詳細」のマップ操作モデル |
| §5 ディレクトリ構成 | `cards/` 削除 → `canvas/` + `inspector/` 追加、`data/` 明示 |
| §6「MVP の範囲」 | 含めるもの 5 項目を Screens マップに全面差し替え、含めないもの 2 ブロック化、完成基準 3 項目に拡張 |
| §8 Phase 2/3 説明文 | 「カード」「次へボタン」「5 枚カード」を「マップキャンバス」「Inspector Panel」「マップ用 JSON」に置換 |
| §10.5 コンポーネント仕様 | 採用昇格 4(MapCanvas / NodeTile / Edge / Inspector Panel)、削除 1(Progress Dots)、改名 1(Card → Inspector Panel)、縮小 1(Button States 6→4)、維持 3(Button / Toggle / Tooltip) |
| §10.6 温存 | ノードグラフ系・Visual Canvas・Inspector Panel を採用昇格、新たに「マップ操作の高度化」群を追加 |

§2(ターゲットユーザー)・§3.1, §3.3, §3.4(コア方針 3 項)・§4(技術スタック)・§7(Claude Code 基本指示)・§9(ドキュメント更新)は **完全に不変**。コア思想は活きている。

最終裏取り(`grep`):
- ファイル全体に「5 枚カード」**0 件**
- 「ノードグラフ系」**0 件**(温存リストから消えて採用に格上げ済)
- 「canvas/」「inspector/」「MapCanvas」「Inspector Panel」「マップキャンバス」「マップ用の JSON」が期待 **8 箇所** で一貫登場

### 既存コード取捨選択リスト(明日の作業指示書)

#### 残す(無修正)
- `src/index.css`(`@theme` 8 色)
- `src/main.tsx`、`src/vite-env.d.ts`、`src/assets/`
- `src/components/layout/Header.tsx`(視覚そのまま、トグルの配線先のみ Inspector Panel に変わる)
- `package.json`、`index.html`、`tauri.conf.json`、`vite.config.ts`、`src-tauri/` 全体

#### 改修して残す
- `src/App.tsx` — 全面書き換え(スライドショー root → マップ root)

#### リネーム + 改修
- `src/components/cards/Card.tsx` → `src/components/inspector/InspectorPanel.tsx`
  - 見た目 DNA は **70% 流用**(タイトル/本文タイポ・色・パディング感)
  - 外側構図 **30% は新規実装**(右端固定 360px、左ボーダー、パネルヘッダー × ボタン、スクロール)
- `src/components/cards/` ディレクトリは空になり次第削除

#### 削除
- `src/types/card.ts`(`ScreenNode` 型に置換)
- `src/data/sampleCards.ts`(`sampleScreens.ts` に置換)

#### 新規作成
- `src/types/screen.ts` — `ScreenNode`(id, label, position{x,y}, detail{title, body, bodyNoCode})、`ScreenEdge`(id, from, to, bidirectional?)
- `src/data/sampleScreens.ts` — AppMap 自身の 5 画面 + エッジ
- `src/components/canvas/MapCanvas.tsx`
- `src/components/canvas/NodeTile.tsx`
- `src/components/canvas/Edge.tsx`
- `src/components/inspector/InspectorPanel.tsx`(上記リネーム結果)

#### 作らずに済んだ
- `src/components/ui/Button.tsx`、`ProgressDots.tsx`、`Toggle.tsx` — 旧 Phase 2 Step 4-5 の予定品。Step 3 で方針転換できたため作成前に廃案。**Step 4 まで進んでいたら廃棄が増えていた**

### 新 Phase 2 実装計画(明日朝、これを見て即着手)

**サンプルデータ仕様(AppMap 自身の Screens マップ):**

```
ノード: 1=フォルダ選択 / 2=分析中 / 3=マップ俯瞰 / 4=詳細パネル / 5=設定
エッジ: 1→2→3(順次)、3↔4(双方向: 詳細を開く/閉じる)、3↔5(双方向: 設定の出入り)
```

| 新 Step | 内容 | 検証 |
|---|---|---|
| 新 1 | `screen.ts` + `sampleScreens.ts` 作成、UI 未反映 | `npm run build` 通過 |
| 新 2 | `Card.tsx` → `InspectorPanel.tsx` リネーム + パネル化、App.tsx に固定表示で目視 | 画面右に 360px パネル |
| 新 3 | `MapCanvas` + `NodeTile` + `Edge` 実装、App.tsx に中央配置、Inspector は一旦撤去 | SVG で 5 ノード + 4 エッジ描画 |
| 新 4 | ノードクリック → InspectorPanel 動的表示(`selectedNodeId` 状態)、× で閉じる | クリック動作 |
| 新 5 | Header の opacity-50 トグル実機能化、`noCodeMode` で InspectorPanel 本文切替。Toggle 切り出しは Step 5 開始時判断 | トグル ON/OFF 切替 |

### 主要な判断履歴(本日)

1. **§1 まで補正範囲を広げた判断** — ユーザー指示は §3/§6/§10 だけだったが、§1「解決アプローチ」項目 1 にも「5 枚カード」が残っていることに気づき、提案 → 承認を得た上で同時更新
2. **「採用 → 温存 / 温存 → 採用」の双方向修正** — 単純な加減算ではなく部品の組み替えで対応。削除 1(Progress Dots)+ 採用昇格 4(MapCanvas / NodeTile / Edge / Inspector Panel)
3. **InspectorPanel 流用度 70% の正直な認識** — リネーム = 全部使える、ではない。30% は新規実装
4. **新 Step 2 でリネーム先行する順序** — マップ先行だと App.tsx を 2 回書き直すことになる。既存資産の処理を先にやる順序が技術的に正しい

### 次セッション(明日朝)への引き継ぎメモ

- **CLAUDE.md は §1〜§10 すべてマップ製品前提で揃っている**(2026-05-10 改訂完了、grep で裏取り済)。「5 枚カード」「順送り」「進行ドット」の語彙は完全に消滅
- **明日の最初の一手:** 上記「新 Step 1」から着手。ユーザー承認済みなのでいきなり実装に入って良い
- **削除対象ファイル**(`src/types/card.ts`、`src/data/sampleCards.ts`、`src/components/cards/Card.tsx` ディレクトリごと)は明日の実装時にまとめて削除。今日は触っていない
- **dev サーバ停止済み**(タスク `bpbaf403t` 終了)。明日 `npm run tauri dev` で再起動
- 旧 Phase 2 の進捗(2026-05-09 〜 2026-05-10)で書いた Step 1-3 のコードは、**部分的にリネーム流用** か **削除** で扱う(上記取捨選択リスト参照)

### 学び(プロセス改善)

- **コア方針が抽象的だと上流ドキュメントの解釈余地が実装段階で爆発する** — 今回 §3.2「段階的開示」が「カード順送り」と解釈された。今後は §3.2 のように複数解釈が可能な原則は、§6/§8 の段階で実装の絵を併記することで防ぐ
- **「動くものを早く出す」(§3.4)が今回の方針転換コストを最小化した** — 旧 Step 3 までしか進んでいなかったため廃棄量が小さく済んだ。Step 4-5 まで進んでいたら廃棄が倍増していた

---

## 2026-05-09 — Phase 1 完了 + デザインシステム統合

### 達成

- **Phase 1 完了**: Tauri + React + TypeScript + Tailwind CSS v4 が動くデスクトップアプリ
  - `npm run tauri dev` でデスクトップウィンドウ起動を確認(Rust ビルド初回 1m10s)
  - `tauri-app.exe` の `MainWindowTitle = "AppMap"`、Vite 1420 ポートで `<title>AppMap</title>` 配信を裏取り済み
  - 「Hello AppMap」が Tailwind スタイル(slate 背景・中央寄せ・大見出し)で表示される状態
- **ブランディング統一**: `package.json` name=appmap、`index.html` <title>=AppMap、`tauri.conf.json` productName + window title=AppMap
- **デザインシステムを CLAUDE.md §10 に統合**: 添付されたデザインシステム v1.0(4 枚)から「5枚カードUI に直接必要な部分」のみを抽出。3層ダッシュボード・ノードグラフ・運用監視系などは §10.6 に「温存」として明示

### 主要な判断履歴

1. **デザインシステムは「全面採用」ではなく「目的に合う部分の抽出」方針**
   - 理由: デザインシステム v1.0 には AppMap の将来像(3層ダッシュボード等)も含まれるが、Phase 2 の目的は「認知負荷を下げ、5枚カードで段階的に見せる」こと。完成形の部品をいま導入すると認知負荷が逆に上がる
2. **Phase 2 では 8 色のうち前半 5 色のみ使用**
   - 採用: Charcoal / Slate / Soft Grid / Off White / Electric Teal
   - 定義のみで未使用: Muted Amber / Alert Red / Cool Blue(Phase 4 以降のリスク表示等で使用)
3. **C-1〜C-4 の不整合は「使い分けルール」として整理**
   - C-1 (Card radius 14px vs 12px): 主役カード 14px、小要素 8〜12px
   - C-2 (Grid gutter 8px vs 24px): ページ層 24px、コンポーネント内 8px
   - C-3 (進行表示): Progress Dots を **新設**。累積表現(`●●○○○` → `●●●○○`)で「残りいくつか」を一目で見せる(§3.1 認知負荷を下げる方針と直結)
   - C-4 (JetBrains Mono): 定義のみ、Phase 2 では未読込
4. **`src-tauri/src/lib.rs` の template `greet` コマンド**: Phase 3(AI 連携)で書き換え予定のため、Phase 1 では触らず温存
5. **Cargo.toml の crate name は `tauri-app` のまま温存**: 内部用でユーザー非可視。プロセス名 `tauri-app.exe` に残るのみ。Rust 側のリネームはリスクの割に得るものが少ない

### 明日(Phase 2 開始時)に最初にやること

1. **色の実装方式を決定** — CLAUDE.md §10.2 末尾の TODO
   - 候補: Tailwind v4 `@theme` ブロックで CSS 変数化 / 任意値で都度指定 / ハイブリッド
   - 決定したら §10.2 の TODO 行を更新。`src/index.css` への追記が想定される
2. **ヘッダー実装** — CLAUDE.md §10 のデザインシステムを適用
3. **カード表示エリアの枠** — 主役カード仕様(§10.5.1)に沿って 14px radius・1px Soft Grid border・soft elevation
4. **「次へ」ボタン** — Primary Button(§10.5.2、Electric Teal 塗り)
5. **Progress Dots 実装** — 累積表現ルール(§10.5.6)に従う

### 今日の工程・反省

- Monitor で `npm run tauri dev` のビルド完了シグナルを 25 分間検知できなかった。原因は cargo 出力の ANSI カラーコードが grep パターンを邪魔したこと(`Finished\x1b[0m \`dev\`` の reset コードが間に挟まる)。実ビルドは 1m10s で成功していた。教訓は `memory/tooling_cargo_monitor.md` に記録済み — 次回以降は `sed 's/\x1b\[[0-9;]*[mGKH]//g'` で ANSI ストリップを噛ませる、または `Get-Process` で裏取りする
- 「計画 → 承認 → 実行」のワークフローが本日も機能。デザインシステム抽出のような **裁量幅の大きい作業** ほど、項目単位リストでの事前承認が効いた

### 次セッションへの引き継ぎメモ

- **CLAUDE.md §10「デザインシステム抜粋(5枚カードUI 用)」が 2026-05-09 に追加された**。Phase 2 実装はこのセクションを正とする
- **色の実装方式は未確定**(§10.2 末尾の TODO)。Phase 2 実装に入る最初のステップとしてユーザーと判断する。`@theme` / 任意値 / ハイブリッドの 3 案
- Phase 1 で `App.css` 削除済み・`index.css` には `@import "tailwindcss";` のみ。Tailwind v4 で `@theme` を書く場合はこのファイルに追記する
- メモリの `project_appmap_status.md` にも「デザインシステム統合済み + 次の一歩は色の実装方式の決定」を 1 行追記済み

---
