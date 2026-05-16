# PROJECT.md — AppMap

> このドキュメントは、Claude Code がこのプロジェクトを通して参照する憲法です。
> 開発中に迷ったら、ここに戻ってください。

---

## 1. プロジェクトの目的

**AI で作ったアプリを、非エンジニアが認知負荷少なく理解できるようにするデスクトップアプリ。**

### 解決する問題

非エンジニア(特にノーコード経験者)が AI コーディングツールでアプリを作ると、

- AI の説明が長すぎて頭に入らない
- 専門用語が多くて、何を聞けばいいか分からない
- 全体像が見えず、「自分のアプリ」という感覚が持てない

これらは AI モデルの進化では解決されない問題です。なぜなら**認知負荷の上限は人間側にあり**、AI が賢くなるほど出力は複雑・大量になるからです。

### 解くべき本質的な問い

「AI の出力を、人間が頭に入れられる形に変換する」

これは AI には代替できません。AI は説明する側で、認知負荷を下げる側ではないからです。

### 解決アプローチ

1. AI が長文で説明することを、**1 枚のマップに構造化**する(画面・データ・処理の関係を視覚的に見せる)
2. **段階的に開示**する(全部一度に見せない、理解の進み具合に合わせる)
3. 専門用語を、ユーザーがすでに知っている概念にだけ翻訳する
4. **触っていじれる形**にする(読むより試す方が認知負荷が低い)

---

## 2. ターゲットユーザー

ノーコード経験者(エンジニアと完全初心者の中間)。具体的には:

- Bubble / Glide / Notion などで一度はアプリを作った経験がある
- 概念(データベース・API・認証)は分かるが、コードは読みたくない
- いま AI コーディングツールに移行中、または検討中

**重要**: このユーザーは「概念は分かるが、コードを読みたくない」。だから UI もコードも、彼らの既存の概念地図に翻訳して見せる必要があります。

---

## 3. 重要な設計方針

開発中、以下に常に立ち返ってください。

### 3.1 認知負荷を下げる、が最優先

機能の豊かさより、**シンプルさと理解しやすさ**を優先。情報量で負けても、分かりやすさで勝つ。

### 3.2 段階的開示

最初の画面で見せるのは **マップ全体の俯瞰** だけ。ユーザーが気になるノードをクリックすると、そのノードの詳細パネルが開く。**俯瞰 → 個別ノード → 詳細** と段階的に深掘れる構造を保ち、最初から全情報を詰め込まない。

### 3.3 ノーコード経験者の言葉で話す

技術用語を使う時は、必ず Bubble / Notion / Glide などでの対応概念を併記する。

### 3.4 動くものを早く出す

完璧を目指さない。検証段階では「ユーザーに見せて反応を取れる」ことが最優先。

---

## 4. 技術スタック

| 領域 | 採用技術 | 理由 |
|------|---------|------|
| デスクトップフレームワーク | Tauri | 軽量、Mac/Windows 両対応、Web 知識が活きる |
| フロントエンド | React + TypeScript | 情報が多く、Claude Code が得意 |
| スタイリング | Tailwind CSS | 開発速度が速い、デザインシステムが組みやすい |
| AI API | Anthropic API (Claude) | コード分析と説明生成の中核 |
| バックエンド言語 | Rust (Tauri 標準) | 必要最小限のみ、ロジックはフロント側で完結させる |
| 状態管理 | React 標準 (useState / useContext) | 最初は Zustand 等を使わない、シンプルに保つ |
| データ永続化 | (まだ決めない) | MVP 段階では不要 |

### 採用しない技術と理由

- **Electron**: 重い、Tauri で同じことができる
- **Next.js**: Web ではなくデスクトップアプリなので不要
- **複雑な状態管理ライブラリ**: 検証段階ではオーバーエンジニアリング
- **データベース**: MVP では不要、必要になってから追加

---

## 5. ディレクトリ構成

```
appmap/
├── src/                      # React (フロントエンド)
│   ├── components/           # UIコンポーネント
│   │   ├── canvas/           # マップ描画(MapCanvas / NodeTile / Edge)
│   │   ├── inspector/        # ノード詳細パネル(Inspector Panel)
│   │   ├── layout/           # ヘッダー、サイドバーなど
│   │   └── ui/               # ボタン、トグル、ツールチップなど汎用部品
│   ├── data/                 # ハードコードサンプルデータ(Phase 2 用)
│   ├── lib/                  # ロジック (API呼び出し、解析)
│   │   ├── anthropic.ts      # Claude API クライアント
│   │   └── analyzer.ts       # コード解析ロジック
│   ├── types/                # TypeScript 型定義
│   ├── App.tsx               # ルートコンポーネント
│   └── main.tsx              # エントリーポイント
├── src-tauri/                # Rust (Tauri 側)
│   ├── src/
│   │   └── main.rs           # Tauri のメイン
│   └── tauri.conf.json       # Tauri 設定
├── PROJECT.md                # このファイル
└── package.json
```

---

## 6. MVP の範囲(最初に作るもの)

### 含めるもの

1. **コードの読み込み**: ローカルのフォルダを選択して読み込む(Tauri のファイル API を使用)
2. **Screens 1 層マップ表示**: 読み込んだコードを Claude API に渡し、画面(Screens)を **ノード**、画面間の遷移を **関係線(エッジ)** としてマップに描画する
3. **段階的開示**: 最初は俯瞰のみ。ノードクリックで右側に詳細パネル(Inspector Panel)が開く(§3.2「俯瞰 → 個別 → 詳細」)
4. **詳細パネル**: 選択ノードのタイトル・説明・関連ノードを表示。閉じるボタンで俯瞰に戻る
5. **ノーコード語切替トグル**: 詳細パネル本文を Bubble / Notion / Glide の用語に翻訳するモード

### 含めないもの(後回し)

**マップ製品の発展形(Phase 4 以降)**

- Data 層・Workflows 層の表示(MVP は Screens 1 層のみ)
- 層切替(Layer Tabs)、Mini-map、Action Bar
- リスク・コスト分析、Risk Badges、Status Chips、Health チャート
- グラフ自動レイアウト最適化(配置アルゴリズム)
- ノードの追加・編集・削除(MVP は読込結果の表示のみ)
- ズーム・パン操作の高度化

**汎用的な後回し**

- ユーザー認証・アカウント管理
- 複数プロジェクト管理
- 履歴・差分表示
- リアルタイム同期
- 美麗なグラフィック・アニメーション(機能優先)

### 完成の基準

ノーコード経験者 1 人に「使ってみてください」と渡し、

- **5 分以内に、マップ俯瞰でアプリの全体像(画面とその関係)が把握できる**
- **気になるノードをクリックして詳細パネルを開き、何の画面かを理解できる**
- 「もっと知りたい」より先に「分かった」が来る

これを満たせば MVP は成立、次の検証フェーズへ進む。

---

## 7. Claude Code への基本指示

このプロジェクトで Claude Code に作業を依頼する時、以下を守ってください。

### 守るべきこと

- **小さく作って動かす**: 一度に大量のコードを書かない。1 ファイルずつ動作確認しながら進める
- **型を必ず書く**: TypeScript の型は省略しない。後で読む時の認知負荷を下げる
- **コメントは「なぜ」を書く**: 「何をするか」はコードを読めば分かる。「なぜそうしたか」を書く
- **新しい依存を入れる時は理由を説明**: package.json に追加する前に、なぜそれが必要かを説明する

### やってはいけないこと

- 勝手に大きなリファクタを始める
- 動作確認せずに次のタスクに進む
- このドキュメントの方針に反することを「便利だから」という理由で入れる

---

## 8. 開発の進め方

### Phase 1: 環境構築(初日)

1. Tauri プロジェクトを作る
2. React + TypeScript + Tailwind が動く状態にする
3. 「Hello AppMap」が表示されるまで確認する

### Phase 2: 骨組み(2〜4日目)

1. ヘッダー・マップキャンバス・Inspector Panel の基本レイアウト
2. ハードコードしたサンプルデータで Screens マップが描画され、ノードクリックで詳細パネルが開く動作

### Phase 3: AI 連携(5〜7日目)

1. Anthropic API を Tauri から呼ぶ
2. ローカルフォルダを選んで、ファイル一覧を Claude に渡す
3. Claude がマップ用の JSON(ノード + エッジ + 各ノードの詳細)を返してくる

### Phase 4: 試用・改善(8日目以降)

1. 実際のノーコード経験者 1 人に触ってもらう
2. 反応を見て次の改善方針を決める

---

## 9. このドキュメントの更新

この PROJECT.md は固定ではありません。

- 設計方針が変わった
- 技術スタックを変えた
- MVP の範囲を見直した

時には、必ずこのファイルを更新してください。**ドキュメントとコードがズレることが、認知負荷の最大の敵**です。

---

## 10. デザインシステム抜粋(5枚カードUI 用)

> AppMap には完成形を見据えた包括的なデザインシステム(v1.0)が別途存在する。本セクションはそのうち **Phase 2(5枚カードUI)に直接必要な部分だけ** を抜粋したもの。3層ダッシュボード・ノードグラフ・運用監視系などは **§10.6「温存」** に列挙し、本セクションの実装対象には含めない。

### 10.1 デザイン原則(操作判断のコンパス)

5枚カードUI の判断に迷ったら、以下に立ち戻る:

- **Show structure before detail** — 構造を先に見せ、詳細は後から開示する
- **Make relationships visible** — 要素同士の関係性を視覚化する
- **Highlight risk without overwhelming** — リスクは目立たせるが、ノイズにしない
- **Translate complexity into understandable layers** — 複雑さを理解可能な層に変換する

加えて、Design Playbook の 6 原則(全体方針として):

- Lead with structure, then reveal detail. — **§3.2「段階的開示」と同義**
- Make patterns recognizable.
- Surface what matters. Context on demand.
- Keep it calm, consistent, and confident.
- Build for trust. Clarity drives action.
- If in doubt, simplify. If still in doubt, ask.

### 10.2 カラーパレット

8 色を CSS 変数として定義する。**製品 UI は DARK モード基調 / マーケティングページは LIGHT モード基調** の二系統で運用する(デザインシステム v1.0 の Doc 1〜4 製品モックアップは全て DARK、Doc 1 Website Hero と Doc 2 Section Mockups のみ LIGHT)。**Phase 2 では DARK モードの製品 UI のみ実装する。**

| 役割名 | HEX | DARK(製品)用途 | LIGHT(マーケ)用途 |
|---|---|---|---|
| Charcoal | `#111827` | **ページ背景(最暗)** / サーフェイス内サブ仕切り線 | 本文テキスト(主) |
| Slate | `#1F2937` | **サーフェイス背景**(ヘッダー・パネル等) | 二次テキスト・濃色アクセント |
| Soft Grid | `#E5E7EB` | 暗面の二次テキスト・補助ラベル | ボーダー・区切り |
| Off White | `#F9FAFB` | **暗面の本文テキスト(主)** | ページ背景 |
| Electric Teal | `#14B8A6` | プライマリアクション・フォーカスリング・選択ノード強調(両モード共通) | 同左 |
| Muted Amber | `#D4A373` | (Phase 4 以降:Caution リスク表示) | 同左 |
| Alert Red | `#EF4444` | (Phase 4 以降:High Risk) | 同左 |
| Cool Blue | `#60A5FA` | (Phase 4 以降:Info) | 同左 |

**DARK モードのボーダー運用:**
- ページ(Charcoal)とサーフェイス(Slate)の境界 → bg 色差で十分、明示ボーダー不要
- サーフェイス内の仕切り(Inspector Panel のヘッダー下など) → **Charcoal**(暗い線で軽く凹ませる)
- フォーカスリング → **Electric Teal 2px**(§10.4 と一致、両モード共通)

**色の実装方式(2026-05-10 確定): 案 A — Tailwind v4 `@theme` ブロックで 8 色全部を CSS 変数化。** 判断根拠は 3 案(@theme / 任意値 / ハイブリッド)を実物比較した結果、ユーザーから見える結果は同一で、違いはコードの書き方のみ。後で Claude Code・人間どちらが読み返しても意味が一目で分かる @theme 方式が長期保守上合理的と判断。実装は `src/index.css` の `@theme` ブロックで 8 色とも CSS 変数として定義済み(`--color-electric-teal` 等)。JSX からは `bg-electric-teal` などの意味的なクラス名で参照する。HEX を JSX に直接書かないことを原則とする。

### 10.3 タイポグラフィ

**フォントスタック:**

- 英語: **Inter**
- 日本語: **Noto Sans JP**
- コード(将来用、Phase 2 では未読込): **JetBrains Mono**

**見出しスケール:**

| レベル | サイズ/行高 | ウェイト | 用途 |
|---|---|---|---|
| H1 | 48 / 56 | Bold | ページタイトル |
| H2 | 28 / 36 | Semi Bold | セクションタイトル(カードタイトル) |
| H3 | 18 / 24 | Semi Bold | サブセクション |
| H4 | 16 / 24 | Medium | カード内見出し |
| H5 | 14 / 20 | Medium | 小見出し・ラベル |

**本文スケール:**

| レベル | サイズ/行高 | ウェイト | 用途 |
|---|---|---|---|
| Body 1 | 14 / 20 | Regular | 主要本文 |
| Body 2 | 13 / 18 | Regular | 二次本文・注記・進行カウンタ |
| Caption | 12 / 16 | Regular | 補助テキスト |

**コピールール:**

- 短いラベルと明確な名詞を使う
- ボタンは動詞ベース(例:「View Details」「次へ」「分かった」)
- UI コピーは sentence case
- 数字には文脈を併記(例:「Requests (24h)」)
- 専門用語は避ける — どうしても必要なら **hover ツールチップか詳細パネルで説明**(これがノーコード語切替トグルの根拠)

### 10.4 レイアウト

**スペーシング(8px ベース):**

`0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 96`

**ボーダー:**

- デフォルト: 1px(明面は Soft Grid、暗面は Slate)
- フォーカス: 2px Brand Teal

**半径:**

- **主役カード(5枚カードUI のメインコンテンツ): 14px**
- 小要素(チップ、小ボタン、内部要素): 8〜12px

**シャドウ:**

多層・控えめ。Tailwind の `shadow-sm` / `shadow` / `shadow-md` をそれぞれ XS / S / M に対応させる暫定運用。

**グリッド・ガター:**

- ページ層レイアウト: ガター **24px**(中央寄せの 1 カラム想定でも、レスポンシブの基準として保持)
- コンポーネント内パッキング: ガター **8px**
- Container: max-width 1440px

### 10.5 コンポーネント仕様(Phase 2 で使うものだけ)

#### 10.5.1 MapCanvas(Visual Canvas)

マップ全体を描画する SVG ルート要素。デザインシステム v1.0 で「温存」だったものを Phase 2 で **採用に昇格**(Screens 1 層のみ)。

- SVG ベース。ノードとエッジを `<g>` でグループ化
- `viewBox` で座標系を定義、子要素は絶対座標で配置
- 背景は **Slate**(中央サーフェイス)。ページ Charcoal 上に乗る面として bg 色差で分離する(明示ボーダー不要、§10.2 DARK モード運用準拠)
- props: `nodes: ScreenNode[]`、`edges: ScreenEdge[]`、`selectedNodeId: number | null`、`onNodeClick: (id: number) => void`
- **Phase 2 ではズーム・パン無し**。ノード位置はサンプルデータにハードコード(Phase 3 で AI が決める想定)

#### 10.5.2 Node Tile(Graph Nodes)

ノード 1 個分の描画。デザインシステム v1.0 の Graph Nodes を採用に昇格。

- 形: 矩形(幅 120px・高さ 48px、Phase 2 暫定値)
- 背景: **Charcoal**(Slate サーフェイスの上で「持ち上がった台」として読める階層感)、ボーダー 1px **Soft Grid**(暗面の上で見える明色ボーダー)、半径 12px(小要素扱い)
- 中央にラベル(画面名、Body 1 サイズ、文字色 **Off White**)
- 状態:
  - Default: 上記の通り
  - Hover: ボーダー Off White(暗面上で薄く明るく強調)
  - Selected(クリック後): ボーダー 2px Electric Teal(§10.4 フォーカス規則と一致)
- クリックで親に通知(`onClick`)

#### 10.5.3 Edge(Relation Lines)

ノード間の関係線。デザインシステム v1.0 の Connection Lines / Relation Lines 仕様を採用に昇格。

- SVG `<line>` または `<path>`
- ストローク 2px、色は Soft Grid
- 向きを示す矢印付き(SVG `<marker>`)
- 双方向(`bidirectional: true`)の場合は両端に矢印
- Phase 2 では重なりは配置で回避(自動回避ロジックは §10.6 温存)

#### 10.5.4 Inspector Panel

ノードクリック時に右端に開く詳細パネル。旧 §10.5.1「Card」の **見た目 DNA を流用**しつつ、外側構図は右パネル化(流用度およそ 70%、残り 30% はパネル特有の構造)。

- 配置: `fixed right-0 top-16 bottom-0`(top はヘッダー高さ 64px 分下げる)
- 幅: 360px
- 背景: **Slate**。左ボーダーは bg 色差で表現(明示ボーダー不要、§10.2 DARK モード運用準拠)
- 上部にパネルヘッダー(タイトル小 + 閉じる × アイコンボタン、上端 sticky)
- 本文エリア: `overflow-y-auto`(長文スクロール対応)
- 内側パディング: 24px(8px スケール)
- タイトル: H3 18/24 SemiBold、本文: Body 1 14/20 Regular
- props: `node: ScreenNode | null`(null なら閉じる)、`onClose: () => void`、`noCodeMode: boolean`

#### 10.5.5 Button(Primary / Secondary / Tertiary / Danger)

| 種類 | 塗り | 文字 | 用途 |
|---|---|---|---|
| Primary | Electric Teal | 白 | 主要進行アクション(Phase 3 のフォルダ選択など)。両モード共通 |
| Secondary | 透明 + 1px Soft Grid outline | DARK: Off White / LIGHT: Charcoal | キャンセル・補助 |
| Tertiary | なし(テキストのみ) | DARK: Off White / LIGHT: Charcoal | ヘッダー内補助 |
| Danger | Alert Red | 白 | Phase 2 では出番なし、両モード共通(将来の) |

すべて半径 14px(主役級操作のため)。Icon Button のみ 8〜12px(Inspector Panel の閉じる × など)。

**States は Phase 2 では 4 状態で十分**: `Default / Hover / Active(押下中) / Disabled`。`Selected / Success / Warning / High Risk` は定義のみ、将来用。

#### 10.5.6 Toggle

- 「ノーコード語切替トグル」(§6 含めるもの 5)で使用
- ヘッダー右端に配置
- 標準的なスイッチ表現、ON 時 Electric Teal、OFF 時 Soft Grid
- 半径はピル形状(`rounded-full`)

#### 10.5.7 Tooltip

- 専門用語に hover した時に Bubble / Notion / Glide の対応概念を表示
- **Phase 2 では未配線**。Phase 3 で AI 生成テキストに具体用語が出てから埋め込む
- §3.3「ノーコード経験者の言葉で話す」の補助手段

### 10.6 温存(Phase 2 では触らない、Phase 4 以降の地図)

将来必要になるが、いま実装すると認知負荷が上がるため **意図的に触らない** もの。「いつかやる」ではなく **「今はやらない理由が明確」** のための備忘録:

- **3 層化機能**(MVP は Screens 1 層のみ): Data 層・Workflows 層、Layer Tabs(層切替)、Mini-map / Legend / Action Bar、Cross-layer Detail Panel、Layer Panel Widths(72 / 280)
- **マップ操作の高度化**: ズーム・パン、ノード追加/編集/削除、グラフ自動レイアウト最適化、ドラッグ移動、エッジ重なり自動回避
- **運用監視系**: Status Chips(Healthy / Warning / Error / Unknown)、Alerts(High Risk / Caution / Info)、Risk Badges(カウント付き)、Health Over Time チャート
- **データ密度の高い UI**: Data Tables、Search Bars(Default / Focused / With Filter)、Segmented Control、Dense Information Layout
- **マーケティング・ブランディング**: Website Hero、Section Mockups、Real Device Mockups、Social Banners(X / LinkedIn / Product Hunt / Email)、Mockup Applications(Landing / Presentation Cover / Favicon 確定版)
- **アプリアイコン最終選定**: 4 案(Map Window / Grid+Nodes / Layered Map / Outline Grid)からの選定は出荷時に確定
- **マップの視覚密度緩和**(Codex review 2026-05-11 Low #1 と続報を反映): 機能拡張で 3D 回転は廃止して単一 SVG 内に複数フロアを縦積みする方式に切り替え済み。cross-depth エッジは clipping せず直線で繋がる。7 nodes + N 階層が増えると dot grid + drop-shadow + Teal accent + 直線エッジが同時に出るため情報量が増える点は依然残課題。**§3.2 段階的開示** の観点で、深い階層プレーンを薄くする / 折りたたみ可能にする / 選択時だけ関連エッジを強調する、などのアイデアを Phase 4 試用後の反応を見て判断する。

Phase 2 で「便利そうだから入れる」の温度になったら、本リストに戻って踏みとどまる。
