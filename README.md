# AppMap

AI で作ったアプリを、非エンジニアが認知負荷少なく理解できるようにするデスクトップアプリ。

Cursor / Claude Code / v0 などで生成したコードを AppMap に読み込ませると、Claude API が

- どんな画面があるか
- 画面同士がどう繋がっているか
- どのデータをどこで読み書きしているか

を分析し、1 枚のマインドマップに描画します。ノーコード経験者(Bubble / Glide / Notion 出身)が
コードを読まずにアプリの全体像をつかめるのが狙いです。

---

## 主な機能

### 1. アプリ構造マップ(メイン機能)
- ローカルフォルダを選ぶと Claude Code CLI がコードを読んで、画面(ノード)と関係(エッジ)を JSON で返す
- 中央にマインドマップとして描画。ノードクリックで右パネル(Inspector)に詳細
- 「かんたん」/「詳細」モード切替(日常語 ↔ エンジニア寄り技術名)
- 各ノードに **メモ・タグ** を残せる。**AI に質問** も可能(関連ノード + 実コードをコンテキストに)

### 2. コードチェック
公開・共有前に「うっかり残し」がないかを確認するローカルスキャン。実 grep ベースで判定:

- **秘密情報の直書き**(sk- / AKIA / ghp_ / github_pat_ / connection string など)
- **`.env` が `.gitignore` で守られていないか**
- **テストフレームワーク / テストファイルの存在**(Node/Python/Rust/Go/Ruby/PHP 対応)
- **`console.log` の残置**(file:line 付きで表示)
- **未対応 TODO / FIXME**(`TODO(#123)` の tracked 形式は除外)

秘密情報・接続文字列は自動伏せ字化。スキャン失敗や未実行時は "Ready" ではなく **"unknown"** と表示して誤った安心を与えない設計。

保存を検知して自動再スキャン(Cursor / VS Code / vim / CLI どれでも)。

### 3. 仕様書 / 共有 HTML 書き出し
- クライアント・上司に渡せる **正式仕様書(PDF)**
- 相手が AppMap をインストール不要で見られる **1 ファイル共有 HTML**

### 4. ガイド付きツアー
初回向けの 8 ステップの機能案内。SVG スポットライトで対象をハイライトし、スクロール / リサイズにも追従。

### 5. AI エンジン切替
- **Claude(クラウド)**:高精度、Anthropic API 従量課金
- **ローカル AI**:PC 上で動く llama.cpp サーバー。無料・オフライン、精度は劣る

---

## 対応 OS

Windows 10/11、macOS 12+。CI ではどちらもインストーラーをビルドしています(タグ push で自動発火)。

---

## 開発

### 前提
- Node.js 18+ / npm
- Rust stable(Tauri 用)
- WebView2(Windows のみ、通常はプリインストール)

### セットアップ・起動
```bash
npm install
npm run tauri dev   # 開発モード起動(Vite + Rust コンパイル)
```

### ビルド
```bash
npm run build        # frontend のみ
npm run tauri build  # インストーラー生成
```

### テスト
```bash
npm run test:run     # Vitest
cargo test           # Rust ヘルパー
```

### リリース
1. `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` の 3 ファイルで version bump
2. `cargo check` で Cargo.lock 更新
3. `git commit -m "vX.Y.Z: <summary>"`
4. `git tag vX.Y.Z && git push origin main --follow-tags`
5. GitHub Actions が自動でインストーラーをビルドして Release に添付

---

## 既知の制約(コードチェックについて)

コードチェックは **バグ検出・セキュリティ監査・実行時挙動の検証は行いません**。以下の性質に注意:

- **表層 grep ベース**:意味理解はしない。`console.log(...)` は検出できるが、そのログが個人情報を含むかは判断しない
- **content スキャンは 200 ファイルまで**(ファイル名の走査は 10k まで)。超大規模 monorepo では対象外の部分が出る
- **秘密情報は既知プレフィックス + 名前ヒューリスティック**。未知の token 形式は取り逃す
- **AI 判定は使わない**:AppMap のマップは Claude が返すが、コードチェックはローカル完結

「ざっとした抜け漏れ確認」用途で、セキュリティ監査ソフトの代替ではありません。

---

## プロジェクト方針

詳細は [CLAUDE.md](./CLAUDE.md) 参照。要点:

- **ターゲット**:ノーコード経験者(Bubble/Glide 出身、AI コーディングツール移行中)
- **設計原則**:認知負荷 < 機能豊富さ。段階的開示(俯瞰 → 個別 → 詳細)
- **技術スタック**:Tauri + React + TypeScript + Rust。データベース無し(MVP)

---

## ライセンス

未設定。リポジトリオーナーに確認してください。
