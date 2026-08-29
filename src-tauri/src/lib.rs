use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::io::{Read, Write};

use futures_util::StreamExt;
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// スキャン・コンテキスト収集で走査対象から外すディレクトリ名か(大文字小文字無視)。
///
/// 依存・生成物・キャッシュ・IDE メタなど「ユーザーが書いたコードではない」もの。
/// 特に Unity(`Library` / `Temp` / `Logs`)や .NET(`obj` / `bin`)の巨大キャッシュを
/// 外さないと、3GB 級・2 万ファイルの `Library` を全 stat してスキャンがタイムアウトする
/// (実際に Unity プロジェクトで発生)。名前は OS ごとに大小が違うため lowercase で比較。
fn is_skippable_dir(name: &str) -> bool {
    const SKIP: &[&str] = &[
        // JS / 汎用ビルド出力・キャッシュ
        "node_modules", "dist", "build", "out", "coverage",
        ".next", ".nuxt", ".svelte-kit", ".turbo", ".vite", ".parcel-cache", ".angular", ".cache",
        // VCS / IDE / OS
        ".git", ".hg", ".svn", ".idea", ".vscode", ".vs",
        // Python
        "venv", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox",
        // Rust / mobile / その他パッケージキャッシュ
        "target", "pods", ".gradle", ".dart_tool",
        // Unity / .NET の巨大キャッシュ・生成物のみ。
        // temp/logs/bin は通常プロジェクトで実コードを含みうる(src/temp/, tools/bin/ 等)ため
        // 外した。誤って未走査のまま Ready に至るのを防ぐ。Unity の Temp/Logs は小さいので
        // 走査コストも問題ない。library/obj/builds は生成物専用なので残す(Codex round 15 Medium)。
        "library", "obj", "builds", "memorycaptures",
    ];
    let lower = name.to_lowercase();
    SKIP.contains(&lower.as_str())
}

/// 既知 secret のプレフィックス一覧(検出とマスクで共有)。
///
/// 以前は scan 本体(block 1)と line_contains_secret(マスク側)が別々の縮小リストを
/// 持っており、gho_/whsec_/SG./PEM などが「検出はされるがマスクされず AI に平文送信」される
/// 漏洩があった。両者をこの 1 つの定数に統一してドリフトを防ぐ。
const SECRET_NEEDLES: &[(&str, &str)] = &[
    ("sk-", "openai-like key"),
    ("sk_live_", "stripe live key"),
    ("sk_test_", "stripe test key"),
    // pk_live_ / pk_test_(Stripe publishable key)はフロントに埋め込む前提の公開値で
    // 秘密ではない。ここに入れると「秘密が直書き」と誤検出し、ユーザーが不要な修正を
    // してしまう(誤検出は許されない方針・CLAUDE.md §6.5)。除外する(Codex round 17 Medium)。
    ("rk_live_", "stripe restricted live"),
    ("whsec_", "stripe webhook secret"),
    ("AKIA", "aws access key id"),
    ("ASIA", "aws temporary access key"),
    ("AIza", "google api key"),
    ("ghp_", "github personal token"),
    ("gho_", "github oauth token"),
    ("ghu_", "github user token"),
    ("ghs_", "github server token"),
    ("ghr_", "github refresh token"),
    ("github_pat_", "github fine-grained pat"),
    ("xoxb-", "slack bot token"),
    ("xoxp-", "slack user token"),
    ("xoxa-", "slack workspace token"),
    ("xoxs-", "slack app token"),
    ("dckr_pat_", "docker hub pat"),
    ("SG.", "sendgrid api key"),
    ("mongodb+srv://", "mongodb connection string"),
    ("postgres://", "postgres connection string"),
    ("postgresql://", "postgres connection string"),
    ("mysql://", "mysql connection string"),
    ("redis://", "redis connection string"),
    ("-----BEGIN RSA PRIVATE KEY-----", "private key"),
    ("-----BEGIN OPENSSH PRIVATE KEY-----", "openssh private key"),
    ("-----BEGIN PRIVATE KEY-----", "private key"),
    ("-----BEGIN EC PRIVATE KEY-----", "ec private key"),
    ("-----BEGIN DSA PRIVATE KEY-----", "dsa private key"),
];

/// 既存 PATH に開発者ツールがよく置かれるパスを追記して返す。
///
/// macOS の GUI アプリ(.app)は launchd から起動するため PATH が縮小されており、
/// `~/.local/bin`(Claude Code native installer)・`/opt/homebrew/bin`(Apple
/// Silicon Homebrew)・`/usr/local/bin`(Intel / 公式 .pkg)などが含まれないまま
/// になる。配布版で「ターミナルでは動くのに AppMap からは Claude が見えない」を
/// 防ぐため、subprocess に渡す PATH をここで拡張する。
///
/// (v0.1.0 配布後 partner フィードバック 2026-05-16 修正 1)
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let existing = std::env::var("PATH").unwrap_or_default();

    let extras: Vec<String> = if cfg!(windows) {
        // Windows の GUI アプリは比較的 PATH を維持するので追加は控えめ。
        // npm グローバル shim の典型位置だけ予防的に追記。
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        vec![format!("{}\\npm", appdata)]
    } else {
        // macOS / Linux でよく使われる開発者ツールのインストール先
        vec![
            format!("{}/.local/bin", home),               // Claude Code native installer
            format!("{}/.local/share/claude/bin", home),  // 同上、versions 配下を直接指すケース
            format!("{}/.npm-global/bin", home),
            format!("{}/.volta/bin", home),
            format!("{}/.bun/bin", home),
            format!("{}/.cargo/bin", home),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ]
    };

    let sep = if cfg!(windows) { ";" } else { ":" };
    let combined = std::iter::once(existing)
        .chain(extras)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(sep);
    combined
}

/// PathBuf を 1 つもらって、それが npm shim(隣に node_modules があるパターン)なら
/// その配下の本体バイナリパスへ展開、そうでなければ自分自身を返す。
///
/// - npm パターン: `<dir>/node_modules/@anthropic-ai/claude-code/bin/claude(.exe)`
/// - native installer: symlink 1 段で実行可能なのでそのまま返す
/// - 存在しないファイルなら None
fn resolve_claude_binary(entry: PathBuf) -> Option<PathBuf> {
    if !entry.exists() {
        return None;
    }
    if let Some(parent) = entry.parent() {
        let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
        let derived = parent
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join(exe_name);
        if derived.exists() {
            return Some(derived);
        }
    }
    Some(entry)
}

/// Find the claude binary to spawn for analysis / login / version check.
///
/// 探索戦略:
///   1. `where`/`which claude` を **augmented PATH 付き** で実行 → 見つかれば
///      npm shim → 本体派生 を試し、ダメなら見つけたファイル自体を返す
///   2. (1) で見つからなければ、よくあるインストール先を直接 `exists()` で確認
///      - macOS: `~/.local/bin/claude`(native installer)、`/opt/homebrew/bin/claude`、
///        `/usr/local/bin/claude`、`~/.npm-global/bin/claude`、`~/.volta/bin/claude`、
///        `~/.bun/bin/claude`、`~/.asdf/shims/claude`、`~/.local/share/claude/bin/claude`
///      - Windows: `%APPDATA%\npm\claude.cmd`(npm shim パターン)
///
/// なお Rust 1.78+ の CVE-2024-24576 緩和策により、Windows では `.cmd` を直接呼ぶと
/// 複雑な引数が拒否されるので、shim → `node_modules/@anthropic-ai/.../claude.exe` を
/// 派生して返す挙動(従来通り)を `resolve_claude_binary` で保持している。
fn find_claude_exe() -> Result<PathBuf, String> {
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };

    // 1) `which`/`where` を augmented PATH で実行
    let lookup_result = StdCommand::new(lookup_cmd)
        .arg("claude")
        .env("PATH", augmented_path())
        .output();

    if let Ok(output) = &lookup_result {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<&str> = stdout
                .lines()
                .map(|s| s.trim())
                .filter(|l| !l.is_empty())
                .collect();

            // Windows は `where` が ext 別に複数行返すので .cmd 優先
            let shim = if cfg!(windows) {
                lines
                    .iter()
                    .find(|l| l.to_lowercase().ends_with(".cmd"))
                    .copied()
                    .or_else(|| lines.first().copied())
            } else {
                lines.first().copied()
            };

            if let Some(shim) = shim {
                if let Some(resolved) = resolve_claude_binary(PathBuf::from(shim)) {
                    return Ok(resolved);
                }
            }
        }
    }

    // 2) Fallback:候補パスを直接探索
    let home = std::env::var("HOME").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();

    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![PathBuf::from(&appdata).join("npm").join("claude.cmd")]
    } else {
        vec![
            PathBuf::from(&home).join(".local").join("bin").join("claude"), // native installer
            PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("claude")
                .join("bin")
                .join("claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from(&home).join(".npm-global").join("bin").join("claude"),
            PathBuf::from(&home).join(".volta").join("bin").join("claude"),
            PathBuf::from(&home).join(".bun").join("bin").join("claude"),
            PathBuf::from(&home).join(".asdf").join("shims").join("claude"),
        ]
    };

    for candidate in candidates {
        if let Some(resolved) = resolve_claude_binary(candidate) {
            return Ok(resolved);
        }
    }

    Err(format!(
        "claude not found in PATH (augmented) or common install locations. lookup: {}",
        match lookup_result {
            Ok(o) if !o.status.success() => format!(
                "`{} claude` returned non-zero ({:?}): {}",
                lookup_cmd,
                o.status.code(),
                String::from_utf8_lossy(&o.stderr)
            ),
            Ok(_) => "shim found but binary resolution failed".to_string(),
            Err(e) => format!("failed to run {}: {}", lookup_cmd, e),
        }
    ))
}

#[tauri::command]
fn claude_check_version() -> Result<String, String> {
    let exe = find_claude_exe()?;
    let output = StdCommand::new(&exe)
        .arg("--version")
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("failed to spawn claude: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "claude --version failed (code {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run `claude -p <user_prompt>` with the given args, return stdout as a string.
/// JSON parsing happens on the JS side to keep this command focused.
///
/// Async + `spawn_blocking` to prevent the UI from freezing during long
/// analyses (claude can run several minutes on large folders). Without this,
/// the host showed "応答なし" (Not Responding) — sync `std::process::Command`
/// blocks the Tauri command thread and the OS message loop.
#[tauri::command]
async fn claude_analyze(
    folder: String,
    user_prompt: String,
    system_prompt: String,
    schema: String,
    model: String,
) -> Result<String, String> {
    let exe = find_claude_exe()?;
    let path_env = augmented_path();
    // 分析を「エージェント読み歩き(--add-dir で claude が自分で読む)」から「先読みして
    //   inline で渡す」方式へ。理由:
    //   1) 大規模プロジェクト(例:3 万ファイルの Unity)は読み歩きが 20 往復でも終わらず
    //      8 分で落ちていた。read_project_context は .gitignore を尊重し上限内だけ読むので、
    //      巨大な Library/ 等を避けて数秒で済む。
    //   2) `--json-schema`(制約デコード)は深いネストのスキーマで生成が詰まる。ローカル LLM で
    //      同じ現象を確認済み(json_object へ緩めて解決)。claude 側も外し、スキーマ形状は
    //      system_prompt 内の記述で誘導、受信側 TS(unwrapResult + extractJsonFromString +
    //      isScreenMapResult)で型検証する。
    //   タイムアウト(8 分)は無限ハング防止の保険として維持。stdout/stderr は別スレッドで
    //   並行ドレインしてパイプ詰まりのデッドロックを避ける。
    //   schema 引数は上記のため未使用だが、TS 側 invoke 契約維持のため受け取りは残す。
    let _ = &schema;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // 1. プロジェクトを先読み(.gitignore 尊重・秘密マスク済み)して 1 テキスト化。
        let folder_path = PathBuf::from(&folder);
        if !folder_path.exists() {
            return Err(format!("folder does not exist: {}", folder));
        }
        let context = read_project_context(&folder_path)?;
        let full_user_prompt = format!(
            "{}\n\n=== Project files context ===\n{}",
            user_prompt, context
        );

        // 2. claude を起動。プロンプト本体は stdin(先読みで大きく、引数だと Windows の
        //    コマンドライン上限 ~32KB を超えて os error 206 になる)。`-p` の後に引数が無く
        //    stdin があれば stdin から読む(claude_chat と同方式)。--add-dir 無し(先読み
        //    済み)、--json-schema 無し(制約デコード回避)。
        let mut child = StdCommand::new(&exe)
            .args([
                "-p",
                "--model",
                &model,
                "--output-format",
                "json",
                "--system-prompt",
                &system_prompt,
                // 先読み済みで読み歩き不要。思考 + 出力の少数往復で足りる。
                "--max-turns",
                "6",
            ])
            .env("PATH", &path_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn claude: {}", e))?;

        // プロンプト(先読みで大きい)は別スレッドで stdin に書き、書き終えたら drop で EOF。
        //   stdout ドレインと並行させてパイプ詰まりのデッドロックを避ける。
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = stdin.write_all(full_user_prompt.as_bytes());
            });
        }

        // 大きな出力(マップ JSON)で子プロセスが stdout 書き込みでブロックしないよう、
        //   両パイプを別スレッドで最後まで読み切る。
        let out_pipe = child.stdout.take();
        let err_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(mut p) = out_pipe {
                p.read_to_end(&mut buf).ok();
            }
            buf
        });
        let err_handle = std::thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(mut p) = err_pipe {
                p.read_to_end(&mut buf).ok();
            }
            buf
        });

        let start = Instant::now();
        let timeout = Duration::from_secs(480); // 8 分の保険(無限ハング防止)
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stdout =
                        String::from_utf8_lossy(&out_handle.join().unwrap_or_default())
                            .into_owned();
                    let stderr =
                        String::from_utf8_lossy(&err_handle.join().unwrap_or_default())
                            .into_owned();
                    if !status.success() {
                        // v0.1.7 hotfix:Claude CLI は --output-format json 時にエラーを
                        // stdout 側に出すことがあるため、stderr + stdout 両方を混ぜる。
                        return Err(format!(
                            "claude failed (code {:?})\nstderr: {}\nstdout (先頭 2000 字): {}",
                            status.code(),
                            if stderr.trim().is_empty() { "(empty)" } else { stderr.trim() },
                            if stdout.trim().is_empty() {
                                "(empty)".to_string()
                            } else {
                                stdout.chars().take(2000).collect()
                            }
                        ));
                    }
                    return Ok(stdout);
                }
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(
                            "分析がタイムアウトしました(8 分)。フォルダのファイル数がとても多いか、通常のアプリではない(データ中心のフォルダ等)可能性があります。別のフォルダでお試しください。"
                                .to_string(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err(e) => return Err(format!("wait failed: {}", e)),
            }
        }
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Check if Node.js is installed and return its version (機能拡張 Option A).
///
/// Returns the version string ("v22.x.x") on success, error message on failure.
/// `node.exe` is a native binary (not .cmd), so BatBadBut mitigation doesn't apply.
#[tauri::command]
fn node_check_version() -> Result<String, String> {
    // claude と同じ理由で augmented PATH 経由 + 候補パス直叩きの 2 段構え
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };
    let path_env = augmented_path();

    // 1) which/where + augmented PATH
    let lookup = StdCommand::new(lookup_cmd)
        .arg("node")
        .env("PATH", &path_env)
        .output()
        .map_err(|e| format!("failed to run {}: {}", lookup_cmd, e))?;

    let node_path: PathBuf = if lookup.status.success() {
        let stdout = String::from_utf8_lossy(&lookup.stdout);
        stdout
            .lines()
            .map(|s| s.trim())
            .find(|l| !l.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"))
    } else {
        // 2) Fallback:候補パスを直接探索(Mac の native installer / GUI PATH lag 対応)
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates: Vec<PathBuf> = if cfg!(windows) {
            vec![PathBuf::from("C:\\Program Files\\nodejs\\node.exe")]
        } else {
            vec![
                PathBuf::from("/opt/homebrew/bin/node"),
                PathBuf::from("/usr/local/bin/node"),
                PathBuf::from(&home).join(".volta").join("bin").join("node"),
                PathBuf::from(&home).join(".nvm").join("versions").join("node"), // 不完全だが目印
                PathBuf::from(&home).join(".asdf").join("shims").join("node"),
            ]
        };
        candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or_else(|| "node not found in PATH or common locations".to_string())?
    };

    let output = StdCommand::new(&node_path)
        .arg("--version")
        .env("PATH", &path_env)
        .output()
        .map_err(|e| format!("failed to spawn node: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "node --version failed (code {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run `npm install -g @anthropic-ai/claude-code` from inside the app
/// (機能拡張 Option A — セットアップ自動化).
///
/// Args to npm are all hardcoded constants, so BatBadBut mitigation
/// (CVE-2024-24576) does not block this even on Windows with `npm.cmd`.
///
/// Async + spawn_blocking because the install can take 30s-2min depending
/// on network. Returns stdout on success; stderr on failure (the caller
/// surfaces it to the user, often with a "try sudo" hint on Mac EACCES).
#[tauri::command]
async fn install_claude_code() -> Result<String, String> {
    let npm_cmd = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let path_env = augmented_path();

    let output = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new(npm_cmd)
            .args(["install", "-g", "@anthropic-ai/claude-code"])
            .env("PATH", &path_env)
            .output()
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    .map_err(|e| format!("failed to spawn npm: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "npm install failed (code {:?}):\nstderr: {}\nstdout: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run `claude login` with a 5-minute timeout (Codex review 2026-05-11 round 3 Med #1).
///
/// claude.exe spawns a browser for OAuth and waits for user to complete the
/// flow. The original `.output()` implementation waited indefinitely — if the
/// user closed the browser, abandoned OAuth, or the CLI hung, `loggingIn` in
/// the UI would never resolve.
///
/// New approach: spawn the child, poll `try_wait()` every 500ms up to 300s.
/// On timeout, kill the child and return an error. spawn_blocking keeps the UI
/// responsive during the wait.
#[tauri::command]
async fn claude_login() -> Result<String, String> {
    let exe = find_claude_exe()?;
    let path_env = augmented_path();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // v0.1.10:`claude login` は無効。正しくは `claude auth login`(OAuth ブラウザフロー起動)。
        //   以前の実装ミス:i18n の説明文でも `claude auth login` と案内していたのに、
        //   Rust 側は誤って `claude login` を呼んでいて exit code 1 で常に失敗していた。
        let mut child = StdCommand::new(&exe)
            .args(["auth", "login"])
            .env("PATH", &path_env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn claude: {}", e))?;

        let start = Instant::now();
        let timeout = Duration::from_secs(300); // 5 分

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // 子プロセス終了。stdout / stderr を吸い出す
                    let mut stdout = String::new();
                    let mut stderr = String::new();
                    if let Some(mut out) = child.stdout.take() {
                        out.read_to_string(&mut stdout).ok();
                    }
                    if let Some(mut err) = child.stderr.take() {
                        err.read_to_string(&mut stderr).ok();
                    }
                    if status.success() {
                        return Ok(stdout);
                    } else {
                        return Err(format!(
                            "claude login failed (code {:?}): {}",
                            status.code(),
                            stderr
                        ));
                    }
                }
                Ok(None) => {
                    // まだ走っている。timeout 判定
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(
                            "claude login がタイムアウトしました(5 分)。ブラウザでログインを完了してから再度お試しください。"
                                .to_string(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err(e) => return Err(format!("wait failed: {}", e)),
            }
        }
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

// ═════════════════════════════════════════════════════════════════════
// v0.1.7 ローカル LLM(llama.cpp + Qwen 2.5-Coder)機能
// ═════════════════════════════════════════════════════════════════════
//
// 設計:
//   - llama-server をサブプロセスとして AppMap が管理
//   - モデル(GGUF)は user data dir に保存、初回起動時に HF から DL
//   - OpenAI 互換 HTTP API(/v1/chat/completions)を叩いて分析
//   - 1 セッション中は 1 つの llama-server をずっと走らせる(model loading コスト回避)
//
// Phase 1(本コミット):バイナリは手動で `<app_data_dir>/bin/llama-server.exe` に置いてもらう
// Phase 2(将来):Tauri resources で同梱、`externalBin` 化

/// 起動中の llama-server プロセス。app state として共有(複数 command から触る)。
struct LlamaState {
    server: Mutex<Option<Child>>,
}

/// デフォルトモデル:Qwen 2.5-Coder 14B Q4_K_M(~9 GB)。HuggingFace Qwen 公式 GGUF。
///
/// v0.1.7 hotfix:7B は構造化出力(nodes/edges を schema 通りに埋める)で諦めて
/// nodes:[] を返す挙動が確認された。14B に上げて構造化能力を確保。
/// RTX 5070 Ti 16GB VRAM + 64GB RAM クラスなら余裕で常駐できる。
/// 7B 配布ユーザー向けの fallback はまだ用意していない(Phase 2 でハード自動判定)。
const DEFAULT_MODEL_FILE: &str = "qwen2.5-coder-14b-instruct-q4_k_m.gguf";
const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/qwen2.5-coder-14b-instruct-q4_k_m.gguf";
/// llama-server がリッスンするポート。AppMap 専用にハードコード(衝突したら後で env 化)。
const LLAMA_PORT: u16 = 8088;

/// llama-server バイナリの探索順:
///   1. `<app_data_dir>/bin/llama-server[.exe]` (Phase 1: ユーザーが手動配置)
///   2. PATH 上の `llama-server`(brew/winget で入れた人向け)
fn llama_binary_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let bin_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    if let Ok(dir) = app_handle.path().app_data_dir() {
        let candidate = dir.join("bin").join(bin_name);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(bin_name)
}

/// モデル格納ディレクトリ。無ければ作る。`<app_data_dir>/models/`
fn llama_model_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {}", e))?;
    let models = dir.join("models");
    std::fs::create_dir_all(&models).map_err(|e| format!("mkdir failed: {}", e))?;
    Ok(models)
}

/// llama-server バイナリが入っているか + version 文字列を返す。
///
/// v0.1.7 hotfix:llama-server は --version を stderr に出して **exit code 1** を返す
/// バージョンがある。旧実装は `!status.success() && combined.trim().is_empty()` で
/// エラー判定してたが、出力ありの exit≠0 はそのまま受け入れる挙動。
/// それでも検出失敗するケースがあったため、**まず file existence チェック** を
/// 第一段にして、ファイルがあればそれだけで OK 扱いに切替(version 文字列の取得は
/// best-effort)。
#[tauri::command]
fn llama_check_binary(app_handle: tauri::AppHandle) -> Result<String, String> {
    let bin = llama_binary_path(&app_handle);
    if !bin.exists() {
        return Err(format!(
            "llama-server not found at {}",
            bin.display()
        ));
    }
    // ファイルはある → --version 実行を試みて version 文字列を取得(失敗しても OK 扱い)
    match StdCommand::new(&bin).arg("--version").output() {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let trimmed = combined.trim();
            if trimmed.is_empty() {
                Ok(format!("detected at {}", bin.display()))
            } else {
                Ok(trimmed.to_string())
            }
        }
        // --version 実行失敗してもファイルあるなら OK
        Err(_) => Ok(format!("detected at {}", bin.display())),
    }
}

/// モデル GGUF が既に DL 済みかチェック。
#[tauri::command]
fn llama_check_model(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let dir = llama_model_dir(&app_handle)?;
    Ok(dir.join(DEFAULT_MODEL_FILE).exists())
}

/// モデルの保存先パスを返す(UI で表示用)。
#[tauri::command]
fn llama_model_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = llama_model_dir(&app_handle)?;
    Ok(dir.join(DEFAULT_MODEL_FILE).to_string_lossy().to_string())
}

/// HuggingFace から GGUF をストリーミング DL。
/// 進捗は `llama-download-progress` event で {downloaded, total} を 1MB ごとに emit。
#[tauri::command]
async fn llama_download_model(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = llama_model_dir(&app_handle)?;
    let dest = dir.join(DEFAULT_MODEL_FILE);
    if dest.exists() {
        return Ok(dest.to_string_lossy().to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600)) // 1 時間まで許容(遅回線 + 4.5GB)
        .build()
        .map_err(|e| format!("http client error: {}", e))?;

    let resp = client
        .get(DEFAULT_MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "download returned status {}",
            resp.status()
        ));
    }
    let total = resp.content_length().unwrap_or(0);

    // 一旦 .part に DL → 完了で rename(中断時の不整合防止)
    let part = dest.with_extension("gguf.part");
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("create file failed: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write error: {}", e))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 1024 * 1024 {
            let _ = app_handle.emit(
                "llama-download-progress",
                serde_json::json!({
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
            last_emit = downloaded;
        }
    }
    file.flush().await.ok();
    drop(file);

    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| format!("rename failed: {}", e))?;

    // 100% emit(進捗 UI を 100/100 にするため)
    let _ = app_handle.emit(
        "llama-download-progress",
        serde_json::json!({
            "downloaded": downloaded,
            "total": total.max(downloaded),
        }),
    );

    Ok(dest.to_string_lossy().to_string())
}

/// llama-server を起動 → /health が 200 を返すまで待つ。
/// 既に起動済みなら "already running" を返す(冪等)。
///
/// v0.1.7 hotfix: dev mode で Rust recompile による Tauri restart 後、
/// 子 llama-server プロセスはオーファンとして残ったまま port を握り続ける。
/// state.server は None になっているが port は使用中。
/// このときは「外側で生きてるサーバーを再利用」する判定を入れる(spawn を skip)。
#[tauri::command]
async fn llama_start_server(
    app_handle: tauri::AppHandle,
    state: State<'_, LlamaState>,
) -> Result<String, String> {
    // 1. state 上で起動中扱いか
    {
        let server = state.server.lock().unwrap();
        if server.is_some() {
            return Ok("already running".to_string());
        }
    }

    // 2. state には載ってないが /health に応答する別プロセスがあるか
    //    (Tauri dev restart で残ったオーファン)→ 再利用する
    let probe = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|e| format!("http client error: {}", e))?;
    let health_url = format!("http://127.0.0.1:{}/health", LLAMA_PORT);
    if let Ok(r) = probe.get(&health_url).send().await {
        if r.status().is_success() {
            return Ok("already running (existing)".to_string());
        }
    }

    let bin = llama_binary_path(&app_handle);
    let model = llama_model_dir(&app_handle)?.join(DEFAULT_MODEL_FILE);
    if !model.exists() {
        return Err(format!("model not found at {}", model.display()));
    }

    let port = LLAMA_PORT.to_string();
    let child = StdCommand::new(&bin)
        .args([
            "--model",
            model.to_str().ok_or("non-UTF8 model path")?,
            "--port",
            &port,
            "--host",
            "127.0.0.1",
            "--ctx-size",
            "32768",
            // GPU 全部に乗せる試み。CUDA / Metal / Vulkan ビルドなら効く、CPU ビルドなら無視される
            "--n-gpu-layers",
            "99",
            "--threads",
            "4",
            "--no-warmup",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {}", e))?;

    // /health を polling して ready 待ち(model load に 5-30 秒、巨大モデルは 1 分超え得る)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("http client error: {}", e))?;
    let url = format!("http://127.0.0.1:{}/health", LLAMA_PORT);
    let start = Instant::now();
    let timeout = Duration::from_secs(120);
    let mut ready = false;
    while start.elapsed() < timeout {
        if let Ok(r) = client.get(&url).send().await {
            if r.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if !ready {
        // タイムアウトで起動失敗 → kill して error 返す
        let mut server = state.server.lock().unwrap();
        if let Some(mut c) = server.take() {
            let _ = c.kill();
        }
        return Err("llama-server failed to become ready in 120s".to_string());
    }

    state.server.lock().unwrap().replace(child);
    Ok("started".to_string())
}

#[tauri::command]
fn llama_stop_server(state: State<'_, LlamaState>) -> Result<(), String> {
    let mut server = state.server.lock().unwrap();
    if let Some(mut child) = server.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// プロジェクトフォルダから AI に渡すテキストコンテキストを構築する。
///
/// Claude は agentic で自力探索するが、ローカル LLM は tool calling が弱い前提で
/// 事前に「重要そうなファイルを集めた 1 個のテキスト」を作る。
///
/// 含めるファイル:
///   - 優先:README.md / CLAUDE.md / package.json / Cargo.toml / tsconfig / App.tsx 等
///   - 一般:src ツリー以下の `.ts/.tsx/.js/.jsx/.py/.rs/.go/.md/.json` 等
///   - 除外:node_modules / .git / target / dist / build / .next / venv / 隠しディレクトリ
///   - 上限:1 ファイル 50KB、合計 150KB(LLM のコンテキスト予算)
fn read_project_context(folder: &Path) -> Result<String, String> {
    use ignore::WalkBuilder;

    // bilingual 出力(~14K tokens)+ system_prompt を ctx に収めるため入力は 30KB 上限。
    let max_total: usize = 30 * 1024;
    let max_per_file: usize = 10 * 1024;

    // 画面マップ生成に効く拡張子。Unity(cs/unity/prefab/asset/uxml)や Kotlin も含める
    //   (画面・遷移が C# スクリプトや Scene/Prefab 側にある。Codex 2026-08-15 指摘)。
    const INCLUDE_EXTS: &[&str] = &[
        "md", "json", "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "kt",
        "vue", "svelte", "html", "css", "toml", "yaml", "yml", "cs", "unity", "prefab",
        "asset", "uxml",
    ];

    // 1. 候補ファイルを列挙。
    //    - WalkBuilder が `.gitignore` を Git 互換で尊重(手書き近似はしない。過去に手書き
    //      glob で誤検出/取りこぼしを繰り返した反省。ripgrep と同じ ignore クレートに委譲)。
    //    - filter_entry で is_skippable_dir のキャッシュ/生成物ディレクトリは descend しない
    //      (`.gitignore` に無い Unity Library 等も確実に除外)。
    //    - hidden(true):隠しファイル/ディレクトリを除外(従来踏襲)。
    //    - require_git(false):Git 管理外フォルダでも `.gitignore` を尊重。
    //    - parents(false):解析対象フォルダの外(親)の `.gitignore` は見ない。
    //    - max_filesize:巨大ファイル(生成データ等)は列挙しない。
    let mut candidates: Vec<(i32, String, PathBuf)> = Vec::new();
    let walker = WalkBuilder::new(folder)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .parents(false)
        .max_filesize(Some(1024 * 1024))
        .filter_entry(|e| {
            if e.file_type().map_or(false, |t| t.is_dir()) {
                return !is_skippable_dir(&e.file_name().to_string_lossy());
            }
            true
        })
        .build();

    // 列挙の時間上限。超巨大ツリー(数十万ファイル)でも「読み込み中」で固まらないための保険。
    let walk_start = Instant::now();
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map_or(false, |t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !INCLUDE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let rel = path
            .strip_prefix(folder)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        candidates.push((screen_map_priority(&rel, &ext), rel, path.to_path_buf()));
        // 暴走を防ぐ backstop(件数 or 時間、どちらか先に到達したら打ち切る。通常規模では未到達)。
        if candidates.len() >= 50_000 || walk_start.elapsed() > Duration::from_secs(3) {
            break;
        }
    }

    // 2. 画面/遷移に効く順へ安定ソート(score 昇順=優先、同点は rel パスで決定的に)。
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    // 3. 予算(30KB)まで連結。credential ファイルは丸ごと skip、それ以外は secret 行を
    //    mask してから渡す(以前は再帰探索側だけマスクが抜けていた。Codex 2026-08-15 指摘)。
    let mut out = String::new();
    let mut total: usize = 0;
    for (_score, rel, path) in candidates {
        if total >= max_total {
            break;
        }
        if is_credential_file_path(&rel) {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let masked = mask_secrets_only(&content);
        let truncated: String = masked.chars().take(max_per_file).collect();
        let header = format!("\n\n<<<<< FILE: {} >>>>>\n", rel);
        // このファイルが入らなくても、後続のより小さいファイルは入るかもしれないので continue。
        if total + header.len() + truncated.len() > max_total {
            continue;
        }
        out.push_str(&header);
        out.push_str(&truncated);
        total += header.len() + truncated.len();
    }
    Ok(out)
}

/// 画面マップ生成に効く順にファイルへ優先度スコアを付ける(小さいほど優先)。
///   README/manifest → エントリポイント → ルーティング/画面 → 一般ソース → Unity Scene/Prefab。
fn screen_map_priority(rel: &str, ext: &str) -> i32 {
    let lower = rel.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(lower.as_str());

    const TOP: &[&str] = &[
        "readme.md", "readme.markdown", "claude.md", "package.json", "cargo.toml",
        "tsconfig.json", "pubspec.yaml", "go.mod", "requirements.txt", "pyproject.toml",
    ];
    if TOP.contains(&base) {
        return 0;
    }
    const ENTRY: &[&str] = &[
        "app.tsx", "app.jsx", "app.ts", "app.js", "main.tsx", "main.ts", "index.tsx",
        "index.ts", "main.py", "app.py", "main.dart",
    ];
    if ENTRY.contains(&base) {
        return 5;
    }
    // 画面/遷移に効くディレクトリ・語(ルーティング中心)
    const SCREEN_HINTS: &[&str] = &[
        "/routes/", "/route/", "/pages/", "/page/", "/screens/", "/screen/", "/views/",
        "/view/", "/navigation/", "/router/", "/routing/", "/scenes/", "/controllers/",
    ];
    if SCREEN_HINTS.iter().any(|h| lower.contains(h)) {
        return 10;
    }
    // Unity Scene/Prefab/Asset は冗長なので後ろへ回す。
    if matches!(ext, "unity" | "prefab" | "asset") {
        return 45;
    }
    // 一般ソースの入口寄り。
    if lower.starts_with("src/")
        || lower.starts_with("app/")
        || lower.starts_with("lib/")
        || lower.starts_with("assets/")
    {
        return 20;
    }
    30
}

/// フォールバック用:解析対象フォルダのトップレベルの主要ディレクトリ名を返す。
///
/// AI 分析が失敗したとき(タイムアウト・出力破損など)、フロント側がフォルダ構成から
/// 「必ず出る最小マップ」を組むための材料。キャッシュ/生成物/隠しディレクトリは除外。
/// これにより「読み込めない=アプリの存在意義が無い」を回避する(最優先要件)。
#[tauri::command]
fn list_project_areas(folder: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&folder);
    if !path.is_dir() {
        return Err(format!("folder does not exist: {}", folder));
    }
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || is_skippable_dir(&name) {
                continue;
            }
            dirs.push(name);
        }
    }
    dirs.sort();
    dirs.truncate(12); // マップが混雑しないよう上限
    Ok(dirs)
}

/// llama-server に POST して画面マップ JSON を取得。
///   1. プロジェクト読み込み(read_project_context)
///   2. OpenAI 互換 /v1/chat/completions に POST、response_format で JSON schema 制約
///   3. choices[0].message.content を返す(JS 側で claudeCli と同じ unwrap 経路へ流す)
#[tauri::command]
async fn llama_analyze(
    folder: String,
    user_prompt: String,
    system_prompt: String,
    schema: String,
) -> Result<String, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err(format!("folder does not exist: {}", folder));
    }

    // 1. プロジェクトファイル群を 150KB 上限で集めて 1 テキスト化
    let context = tauri::async_runtime::spawn_blocking(move || read_project_context(&folder_path))
        .await
        .map_err(|e| format!("join error: {}", e))??;

    // 2. ユーザーメッセージに連結
    let full_user_prompt = format!("{}\n\n=== Project files context ===\n{}", user_prompt, context);

    // v0.1.7 hotfix:strict json_schema mode は llama.cpp の grammar enforcement で
    // 深いネストに引っかかり、Qwen が「nodes:[],edges:[]」を吐いて諦める現象が確認された。
    // 緩めの json_object mode に変更:JSON 出力は強制するが構造はモデル任せ。
    // 受信側(claudeCli の extractJsonFromString + isScreenMapResult)で型検証する。
    //
    // schema 文字列はバリデートだけ走らせて、payload からは外す(プロンプトは引き続き schema を含む)。
    let _: serde_json::Value =
        serde_json::from_str(&schema).map_err(|e| format!("invalid schema JSON: {}", e))?;

    let payload = serde_json::json!({
        "model": "local",
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": full_user_prompt }
        ],
        "response_format": {
            "type": "json_object"
        },
        "temperature": 0.1,
        // v0.1.7:短縮版プロンプト + maxItems 縮小で出力量が減ったので
        //   max_tokens を 20000 → 12000 に戻す(生成時間短縮の副効果あり)。
        //   出力量が本当に足りなくなったら再度引き上げる。
        "max_tokens": 12000
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600)) // 10 min:遅い PC でも完了するように
        .build()
        .map_err(|e| format!("http client error: {}", e))?;

    let url = format!("http://127.0.0.1:{}/v1/chat/completions", LLAMA_PORT);
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("llama-server returned {}: {}", status, body));
    }

    let response_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("response parse failed: {}", e))?;

    let content = response_body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no content in response: {}", response_body))?;

    // v0.1.7 デバッグ:ローカル LLM の生出力をターミナルに出して品質確認
    eprintln!(
        "\n[AppMap llama_analyze] ────── raw response ({} chars) ──────\n{}\n[AppMap llama_analyze] ────── end ──────\n",
        content.len(),
        content
    );

    Ok(content.to_string())
}

/// v0.1.8: ノード単位の Q&A(Claude 版)。
/// analyze と違い schema・folder 不要。単一プロンプトを流し、plain text を返す。
#[tauri::command]
async fn claude_chat(system_prompt: String, user_prompt: String, model: String) -> Result<String, String> {
    let exe = find_claude_exe()?;
    let path_env = augmented_path();
    // v0.1.9:user_prompt を stdin 経由で渡す。
    //   理由:Windows の CreateProcess のコマンドライン長制限(32,768 文字)を回避するため。
    //   深掘り機能では 64KB のコード + プロンプトを渡すので、argv だと `os error 206
    //   (ファイル名または拡張子が長すぎます)` で spawn 失敗する。
    //   Claude CLI は `-p` 引数なしで起動すると stdin からプロンプトを読む仕様。
    let output = tauri::async_runtime::spawn_blocking(move || -> Result<std::process::Output, String> {
        let mut child = StdCommand::new(&exe)
            .args([
                "-p",
                "--model",
                &model,
                "--system-prompt",
                &system_prompt,
                // v0.1.10:1 だと大きなプロンプト(深掘りで JSON を返す等)で
                // `Reached max turns (1)` エラーが出る。5 なら Q&A / 深掘り両方に十分。
                "--max-turns",
                "5",
            ])
            .env("PATH", &path_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn claude: {}", e))?;

        // stdin に user_prompt を書き込む(drop でクローズされ、CLI に EOF が伝わる)
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "failed to open claude stdin".to_string())?;
            stdin
                .write_all(user_prompt.as_bytes())
                .map_err(|e| format!("failed to write to claude stdin: {}", e))?;
        }

        child
            .wait_with_output()
            .map_err(|e| format!("failed to wait for claude: {}", e))
    })
    .await
    .map_err(|e| format!("join error: {}", e))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "claude failed (code {:?})\nstderr: {}\nstdout: {}",
            output.status.code(),
            if stderr.trim().is_empty() { "(empty)" } else { stderr.trim() },
            if stdout.trim().is_empty() { "(empty)" } else { stdout.trim() },
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// v0.1.8: ノード単位の Q&A(ローカル LLM 版)。
/// llama-server の OpenAI 互換 API に plain messages を投げて content を返す。
#[tauri::command]
async fn llama_chat(system_prompt: String, user_prompt: String) -> Result<String, String> {
    let payload = serde_json::json!({
        "model": "local",
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": 0.3,
        "max_tokens": 800
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http client error: {}", e))?;

    let url = format!("http://127.0.0.1:{}/v1/chat/completions", LLAMA_PORT);
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("llama-server returned {}: {}", status, body));
    }

    let response_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("response parse failed: {}", e))?;

    let content = response_body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no content in response: {}", response_body))?;

    Ok(content.trim().to_string())
}

/// v0.1.8:Inspector の関連ファイルを外部エディタで開く。
/// 対応:
///   - "cursor"  → cursor://file/{abs_path}:{line?}
///   - "vscode"  → vscode://file/{abs_path}:{line?}
///   - "system"  → OS のデフォルトファイルハンドラ(Explorer / Finder / xdg-open)
///
/// URL scheme は該当エディタがインストール & プロトコル登録済みの時のみ機能する。
/// 未登録なら OS が「関連付けが無い」ダイアログを出す(致命的エラーにはしない)。
#[tauri::command]
async fn open_in_editor(
    editor: String,
    folder: String,
    file: String,
    line: Option<u32>,
) -> Result<(), String> {
    let abs_path = PathBuf::from(&folder).join(&file);
    if !abs_path.exists() {
        return Err(format!("file does not exist: {}", abs_path.display()));
    }
    // Windows パス を URL に載せるので `\` を `/` に、先頭は `/C:/...` にはせず
    // `C:/Users/...` のまま(vscode/cursor はこの形式を受け付ける)
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let with_line = match line {
        Some(l) => format!("{}:{}", path_str, l),
        None => path_str.clone(),
    };

    match editor.as_str() {
        "cursor" | "vscode" => {
            let scheme = if editor == "cursor" { "cursor" } else { "vscode" };
            let url = format!("{}://file/{}", scheme, with_line);
            open_target(&url)
        }
        "system" => open_target(&abs_path.to_string_lossy()),
        other => Err(format!("unknown editor: {}", other)),
    }
}

/// OS のデフォルトハンドラで URL / パスを開く。
/// Tauri の opener plugin を直接呼ばず std::process::Command で自前実装
/// (URL scheme と file path の両方を同じ経路で扱えるため)
fn open_target(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // `start "" <url>`  空タイトル("")を挟むのが Windows の作法
        StdCommand::new("cmd")
            .args(["/c", "start", "", target])
            .spawn()
            .map_err(|e| format!("failed to open: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        StdCommand::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to open: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        StdCommand::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("failed to open: {}", e))?;
        Ok(())
    }
}

/// v0.1.8:AI 質問(askNode)向けにノードの関連ファイルを実読する。
/// path traversal 防止のため、必ず folder 配下に正規化して収まる分だけ返す。
#[derive(serde::Serialize)]
struct QAFileContent {
    file: String,
    content: String,
    truncated: bool,
}

const QA_MAX_FILES: usize = 10;
const QA_MAX_BYTES_PER_FILE: usize = 8 * 1024; // 1 ファイル最大 8KB
const QA_MAX_TOTAL_BYTES: usize = 64 * 1024; // 合計 64KB(トークン爆発防止)

#[tauri::command]
async fn read_files_for_qa(
    folder: String,
    files: Vec<String>,
) -> Result<Vec<QAFileContent>, String> {
    let folder_path = PathBuf::from(&folder);
    // フォルダ実体の canonical(シンボリックリンク解決)を取り、以降の比較基準にする
    let folder_canon = folder_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve folder: {}", e))?;

    let mut out: Vec<QAFileContent> = Vec::new();
    let mut total_bytes: usize = 0;

    for rel in files.into_iter().take(QA_MAX_FILES) {
        if total_bytes >= QA_MAX_TOTAL_BYTES {
            break;
        }
        // 明らかに秘密を含むファイルは Q&A プロンプトに載せない。
        //   .env* / *.pem / *.key / id_rsa / *credentials* / *secrets* / *.p12 / *.pfx
        //   コードチェック側で mask しているのに、Q&A 側が素通しでは思想が矛盾する。
        if is_credential_file_path(&rel) {
            continue;
        }
        let candidate = folder_path.join(&rel);
        let Ok(canon) = candidate.canonicalize() else {
            continue; // 存在しないパスは黙って skip(ノードの files が古いだけかも)
        };
        // path traversal 防止:必ず folder 配下であること
        if !canon.starts_with(&folder_canon) {
            continue;
        }
        // バイナリ判定は「null byte を含むか」で簡易判定
        let Ok(bytes) = std::fs::read(&canon) else {
            continue;
        };
        if bytes.contains(&0) {
            continue; // バイナリはスキップ
        }
        let mut truncated = false;
        let remaining_budget = QA_MAX_TOTAL_BYTES.saturating_sub(total_bytes);
        let per_file_cap = QA_MAX_BYTES_PER_FILE.min(remaining_budget);
        let take = bytes.len().min(per_file_cap);
        if take < bytes.len() {
            truncated = true;
        }
        // UTF-8 変換:失敗時は lossy でも渡す(コード解析用途なので雑で OK)。
        // 各行に対して mask_snippet を通し、コードチェック側と同じレベルで
        // 秘密情報が LLM プロンプトへ流れないよう伏せ字化する。
        let raw = String::from_utf8_lossy(&bytes[..take]).to_string();
        // secret を含む行だけ選択的に mask する。全 quote を伏せると UI 文言・SQL・
        // route 名まで消えて Q&A の回答品質が落ちるため(mask_snippet 全行適用の弊害)。
        let content = mask_secrets_only(&raw);
        total_bytes += take;
        out.push(QAFileContent {
            file: rel,
            content,
            truncated,
        });
    }

    Ok(out)
}

/// 各行を見て「secret っぽい行」だけ mask_snippet で伏せ字化し、それ以外はそのまま返す。
/// LLM に渡す文脈の情報量を保ちつつ、秘密情報の流出だけを防ぐ。
///   secret 判定:既知 prefix(is_plausible_secret_hit)、secret 変数名 = 値、
///   credential URL(scheme://user:pass@)のいずれか。
fn mask_secrets_only(raw: &str) -> String {
    // PEM 秘密鍵は複数行(ヘッダ + base64 本体 + フッタ)。base64 本体行はどの needle にも
    // 当たらないので、BEGIN...END PRIVATE KEY の間は行内容に関係なく全行マスクする。
    let mut in_pem = false;
    raw.lines()
        .map(|line| {
            if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
                in_pem = true;
            }
            let mask = in_pem || line_contains_secret(line);
            if line.contains("-----END") && line.contains("PRIVATE KEY") {
                in_pem = false;
            }
            if mask {
                mask_snippet(line)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 行が secret を含むか(mask 対象か)の軽量判定。検出本体(block 1)と同じ SECRET_NEEDLES +
/// is_plausible_secret_hit を使う。以前はここが縮小リストで、検出はされるがマスクされない
/// 漏洩があった(gho_/whsec_/SG./PEM 等)。
fn line_contains_secret(line: &str) -> bool {
    for (n, _) in SECRET_NEEDLES {
        if line.contains(n) && is_plausible_secret_hit(line, n) {
            return true;
        }
    }
    // credential URL(scheme://user:pass@)
    if line.contains("://") && line.contains('@') {
        // @ が URL の credential 区切りかを緩く判定
        if let Some(pos) = line.find("://") {
            let after = &line[pos + 3..];
            if let Some(at) = after.find('@') {
                if after[..at].contains(':') || !after[..at].is_empty() {
                    // ホスト前に user[:pass] があれば credential URL
                    if !after[..at].contains('/') && !after[..at].contains(' ') {
                        return true;
                    }
                }
            }
        }
    }
    // secret 変数名 = 16 文字以上の値(quote あり/なし)
    for sep in ['=', ':'] {
        for (i, _) in line.match_indices(sep) {
            if is_inside_string_literal(line, i) { continue; }
            let before = line[..i].trim_end();
            let key_body = before.strip_suffix('"').or_else(|| before.strip_suffix('\'')).unwrap_or(before);
            let lhs = trailing_identifier(key_body);
            if lhs.is_empty() || !is_secret_variable_name(lhs) { continue; }
            let rest = line[i + 1..].trim_start();
            if rest.starts_with("process.env") || rest.starts_with("${") || rest.starts_with('$') {
                continue;
            }
            let val_len = if rest.starts_with('"') || rest.starts_with('\'') {
                let q = rest.chars().next().unwrap();
                rest[1..].chars().take_while(|c| *c != q).count()
            } else {
                rest.chars().take_while(|c| !c.is_whitespace() && *c != ';' && *c != ',').count()
            };
            if val_len >= 16 {
                return true;
            }
        }
    }
    false
}

/// Q&A に載せてはいけない典型的な credential ファイルパスを判定する。
fn is_credential_file_path(rel: &str) -> bool {
    let lower = rel.to_lowercase().replace('\\', "/");
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    // .env / .env.local / .env.production.local などは全て弾く
    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    // 秘密鍵 / 証明書 / OpenSSH / PGP 系
    let suspicious_ext = [".pem", ".key", ".p12", ".pfx", ".jks", ".asc", ".ppk"];
    if suspicious_ext.iter().any(|e| name.ends_with(e)) {
        return true;
    }
    // 特定ファイル名(OpenSSH / Netrc / gcloud application_default_credentials 等)
    if matches!(
        name,
        "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa"
            | ".netrc" | "netrc" | ".htpasswd"
            | "application_default_credentials.json"
    ) {
        return true;
    }
    // 命名に「credentials」「secrets」を含むファイル
    name.contains("credentials") || name.contains("secrets")
}

/// 秘密鍵っぽいファイル名か(`.pem` / `.key` / 拡張子なしの id_rsa 等)。
/// これらを内容走査に含めないと、SECRET_NEEDLES の PEM ヘッダが本物の鍵ファイルに
/// 当たらず取りこぼす(Codex round 20 High)。finding 自体は PEM ヘッダ一致時のみ
/// 出すので、ここで走査対象を広げても誤検出は増えない(.p12/.pfx 等のバイナリ鍵は
/// PEM ヘッダを持たないので対象外)。
fn is_private_key_file_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || matches!(lower.as_str(), "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa")
}

/// git で追跡済み(commit 済み or index 追加済み)の env ファイルを返す。
/// gitignore は既に追跡されたファイルを無視できないため、tracked な `.env` は
/// gitignore 済みでも漏洩リスクが残る(Codex round 20 High)。
/// 非 git フォルダ / git 未導入 / 判定不能時は空を返す(安全側:誤検出しない)。
fn git_tracked_env_files(folder: &Path, env_files: &[String]) -> Vec<String> {
    if env_files.is_empty() || !folder.join(".git").exists() {
        return Vec::new();
    }
    // `git ls-files -z -- <paths>` は tracked なパスだけを NUL 区切りで出力する
    //(未追跡は出力されない)。1 プロセスで全 env ファイルを判定する。
    let output = std::process::Command::new("git")
        .current_dir(folder)
        .arg("ls-files")
        .arg("-z")
        .arg("--")
        .args(env_files)
        .output();
    let Ok(out) = output else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let listed: std::collections::HashSet<String> = String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect();
    env_files
        .iter()
        .filter(|f| listed.contains(&f.replace('\\', "/")))
        .cloned()
        .collect()
}

/// v0.1.8:リリース前チェックのコードスキャン結果。
/// LLM を呼ばずローカルで regex 相当の文字列マッチだけ実行。
#[derive(serde::Serialize)]
struct PreReleaseScanResult {
    secrets: Vec<ScanHit>,
    todos: Vec<ScanHit>,
    /// file:line 付き。件数のみだと Cursor が全体 grep で意図的な console.error まで
    /// 消す過剰修正の温床になる。
    console_logs: Vec<ScanHit>,
    /// truncate 前の総数(secrets/todos/console_logs はそれぞれ 20/50/50 で切詰め)。
    /// UI 表示・AI prompt の「N 箇所」はこの total を使う。
    secrets_total: usize,
    todos_total: usize,
    console_logs_total: usize,
    files_scanned: usize,
    files_truncated: bool,
    /// 運用 gates:package.json / lockfile / CI workflow / tsconfig などの存在。
    /// TODO/console 件数より重要な「本番前にあるべきインフラ」の欠落を検出する。
    project_meta: ProjectMeta,
    /// v0.1.8:設定ファイル+package.json を実物 grep してリアルタイム検出。
    /// AI 分析の context.testing が古い時、こちらを優先する。
    /// 検出できなかった時は None。
    detected_test_framework: Option<String>,
    /// テストファイル(*.test.* / *.spec.* / __tests__/)が存在するか
    has_test_files: bool,
    /// v0.1.8 セキュリティ:.env ファイル存在 + .gitignore カバー状況。
    ///   - env_files_present:.env / .env.local / .env.production 等が実在するか
    ///   - env_covered_by_gitignore:.gitignore が .env パターンを含むか
    /// 両者から「秘密情報を Git に上げる危険な状態か」を判定する。
    env_files_present: bool,
    env_covered_by_gitignore: bool,
    /// v0.1.33:git で追跡済み(commit 済み or index 追加済み)の .env ファイル。
    /// gitignore は追跡済みファイルを守らないため、gitignore 済みでも tracked なら漏洩リスクが
    /// 残る(Codex round 20 High)。git 未導入 / 非 git フォルダでは空。
    env_tracked_files: Vec<String>,
}

/// 運用 gates:TODO や console.log よりリリース前に効く実運用チェック。
/// project_type は「代表的なタイプ」(単一値)。manifests は「全部の manifest」(monorepo/Tauri 対応)。
#[derive(serde::Serialize)]
struct ProjectMeta {
    /// 代表 project_type。単一プロジェクトなら唯一の manifest から、複数なら root 優先で決める。
    project_type: Option<String>,
    /// 検出された全ての manifest タイプ(重複除去済み)。UI/gates は主にこれを見る。
    project_types: Vec<String>,
    /// 代表 manifest の scripts 有無(単一 project 時の後方互換用)
    has_build_script: bool,
    has_test_script: bool,
    has_typecheck_script: bool,
    /// root で見つかる lockfile の有無(package-lock.json 等)
    has_lockfile: bool,
    /// いずれかの Node manifest が tsconfig ファイルを持つ(devDeps.typescript は含まない)
    has_tsconfig_file: bool,
    /// いずれかの Node manifest が TS project(has_tsconfig_file OR typescript 依存)
    is_typescript_project: bool,
    has_ci_workflow: bool,
    /// 検出された全 manifest の詳細(gates finding はこれを iterate)
    manifests: Vec<ManifestInfo>,
}

/// 個々の manifest ファイル情報(gates finding を per-manifest に出すため)。
#[derive(serde::Serialize, Clone)]
struct ManifestInfo {
    /// "node" / "rust" / "python" / "go" / "ruby" / "php"
    manifest_type: String,
    /// プロジェクトルートからの相対パス。root なら "package.json" / "Cargo.toml"、
    /// monorepo なら "apps/web/package.json" のような形。
    path: String,
    has_build: bool,
    has_test: bool,
    has_typecheck: bool,
    /// この manifest 直近の lockfile(package.json → package-lock.json 等)
    has_lockfile: bool,
    /// この manifest 近傍に tsconfig.json / tsconfig*.json が実在するか。
    ///   純粋にファイル存在の事実(devDependencies.typescript は含めない)。
    ///   将来「tsconfig 欠落」チェックを追加するときに意味がぶれないよう分離。
    has_tsconfig_file: bool,
    /// この manifest が TypeScript プロジェクトとして扱われるか。
    ///   has_tsconfig_file OR devDependencies.typescript OR dependencies.typescript。
    ///   typecheck script 欠落 gate は「TS project なのに typecheck scripts が無い」で判定する。
    is_typescript_project: bool,
}

#[derive(serde::Serialize)]
struct ScanHit {
    file: String,
    line: usize,
    /// マッチした行の該当部分だけを抜粋(値そのものは伏せ字化)
    snippet: String,
    /// 検出パターンの分類(例:"api_key", "password", "aws", "todo")
    kind: String,
}

/// v0.1.8:リリース前チェック用のファイルスキャン。
/// - `SECRET_PATTERNS` に該当するトークンを含む行を検出(値は伏せて先頭 60 字に切詰め)
/// - TODO / FIXME / XXX / HACK 行を検出
/// - console.log の総数を集計(存在の目安として)
/// スキャンは分析用と同じ include_exts + skip_dirs を使い、200 ファイルで打切り。
#[tauri::command]
async fn pre_release_scan(folder: String) -> Result<PreReleaseScanResult, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err(format!("folder does not exist: {}", folder));
    }

    // ディレクトリの除外は is_skippable_dir に一元化(Unity/.NET キャッシュも含む)。
    const INCLUDE_EXTS: &[&str] = &[
        "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "cs",
        "vue", "svelte", "html", "css", "json", "toml", "yaml", "yml",
        "env", "sh", "ps1",
    ];
    // cs は Unity/.NET 向け。secret/TODO は言語非依存で効く(console.log 検出は JS 用の
    // ままなので C# には出ない=誤検出も出ない)。
    //   - MAX_SCAN_FILES:ソース内容を読む上限。
    //     200 は低すぎて、少し大きめのプロジェクトで常に「未完了(打切り)」になり
    //     "コード検査は完了していません" が出続けていた。実際の非エンジニアのアプリを
    //     大きいアプリでも「未走査」を減らすため 8000 まで読む。内容読み込み + regex は
    //     spawn_blocking 上。件数上限に加え、下の content scan ループに時間上限(6 秒)を
    //     付け、極端に重いプロジェクトでも走査時間を抑える(先読みの時間上限と同じ考え)。
    //     極端に大きいツリーは MAX_WALK_FILES/MAX_WALK_VISITS が上流で止める。
    //   - MAX_WALK_FILES:ファイル名リストの上限(test framework/test file 検出は
    //     名前だけ見るので大きめに)。source が cap を超えても test framework は落とさない。
    const MAX_SCAN_FILES: usize = 8000;
    const MAX_WALK_FILES: usize = 10_000;
    // 訪問(stat)エントリ数の上限。既知の巨大キャッシュは is_skippable_dir で除外するが、
    // 未知の巨大ツリーに対する保険。この数に達したら partial 扱いで打ち切る。
    const MAX_WALK_VISITS: usize = 40_000;

    // シークレット系プレフィックス。検出とマスクで同じ定義を使う(SECRET_NEEDLES)。
    let secret_needles = SECRET_NEEDLES;
    // 変数名系 secret 検出は「LHS(左辺)にキーワードが含まれるか + 安全マーカーがないか」
    // で判定する(is_secret_variable_name)。以前は固定 needle 列挙 → substring 一致 → 境界
    // チェック方式だったが、SUPABASE_SERVICE_ROLE_KEY や NEXTAUTH_SECRET のような
    // 「未知だが明らかに secret」な変数を全て取りこぼしていた回帰があったため、方針転換。
    // 実際の作業マーカーだけに絞る。XXX は "env.XXX" / "example.com/xxx" などのプレースホルダで
    // 誤検知が多すぎるので外す(HACK/FIXME/TODO で必要十分)。
    let todo_needles: &[&str] = &["TODO", "FIXME", "HACK"];

    let mut secrets: Vec<ScanHit> = Vec::new();
    let mut todos: Vec<ScanHit> = Vec::new();
    let mut console_logs: Vec<ScanHit> = Vec::new();
    let mut files_scanned: usize = 0;
    let mut files_truncated = false;
    let mut detected_test_framework: Option<String> = None;
    let mut has_test_files: bool = false;

    // .env の存在 + .gitignore カバー状況を独立に判定する。
    // 「.env が実在するが .gitignore で守られていない」→ 秘密情報 git push 事故のリスクとして
    // 高優先度 finding を発火。
    //
    // v0.1.10 で全階層収集に変更(monorepo の apps/*/.env.local や
    // packages/admin/.env が root 固定検出だと落ちていた問題への対応)。
    // 対象ごとに、そのファイルからの相対パスを見て root/.gitignore で評価する。
    // .env.example / .env.sample は「意図的に共有される非秘密ファイル」なので除外。
    let env_walk_start = folder_path.clone();
    let (existing_env_files, env_collection_truncated): (Vec<String>, bool) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut out: Vec<String> = Vec::new();
            let truncated = collect_env_files(&env_walk_start, &env_walk_start, &mut out, 512, 0);
            (out, truncated)
        })
        .await
        .map_err(|e| format!("join error: {}", e))?;
    let env_files_present = !existing_env_files.is_empty();
    let env_covered_by_gitignore = if !env_files_present {
        // 対象ファイルが無ければ「守るものが無い」→ true 扱いで finding は発火しない
        true
    } else {
        // 各 env ファイルを、ルート〜そのファイルの親までの全 .gitignore で評価する。
        // ルート .gitignore しか見ないと、monorepo の apps/web/.gitignore で守られた
        // .env.local を「未保護」と誤判定して block を出していた。
        existing_env_files
            .iter()
            .all(|rel_path| env_file_is_gitignored(&folder_path, rel_path))
    };
    // env 収集が上限で打ち切られ、かつ見つかった範囲は全部保護済みだった場合、未走査の
    // .env が未保護かもしれない。Ready と断定しないよう partial(files_truncated)に倒す
    //(Codex round 19 Medium)。未保護が既に見つかっていれば finding が出るのでそのまま。
    if env_collection_truncated && env_covered_by_gitignore {
        files_truncated = true;
    }
    // gitignore で守られていても、既に git に追跡済み(commit 済み)の .env は漏洩リスクが
    // 残る(gitignore は追跡済みファイルを守らない)。git で tracked な .env を拾う
    //(Codex round 20 High)。git 未導入 / 非 git フォルダでは空(誤検出しない)。
    let env_files_for_git = existing_env_files.clone();
    let folder_for_git = folder_path.clone();
    let env_tracked_files: Vec<String> = tauri::async_runtime::spawn_blocking(move || {
        git_tracked_env_files(&folder_for_git, &env_files_for_git)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;

    /// 優先ディレクトリ名。walk 時にこれらを含むディレクトリを先に辿る。
    /// generated/fixtures/node_modules 相当が先頭 10k を食い潰して src/ に到達
    /// できない事故を避ける。
    fn dir_priority(name: &str) -> u8 {
        let lower = name.to_lowercase();
        match lower.as_str() {
            "src" | "app" | "pages" | "routes" | "api" | "server" | "handlers" | "lib" => 0,
            "config" | "packages" | "apps" | "services" => 1,
            // generated / fixtures / dist 相当は最後
            "generated" | "gen" | "fixtures" | "__fixtures__" | "examples" | "vendor" => 3,
            _ => 2,
        }
    }

    /// priority frontier queue による探索。DFS だと `packages/a/generated/` の 10k を
    /// 掘り切ってから `packages/web/src/` に来るため、cap 到達で本命が未収集になる。
    /// (priority, depth) の小さい順にディレクトリを処理する優先度付き BFS にすることで、
    /// 全 subtree の src/app/server を深い generated より先に消化する。
    ///
    /// 上限は 2 系統:
    ///   - max_files:収集した(拡張子マッチ)ファイル数。並び替え後 content scan する母数。
    ///   - max_visits:stat したエントリ数。Unity の `Library`(3GB / 2 万ファイル)のように
    ///     拡張子フィルタに大量に引っかからないまま延々走査してタイムアウトするのを防ぐ
    ///     ハードストッパ。is_skippable_dir で Library 自体は除外するが、未知の巨大ツリーに
    ///     対する保険として visits 上限も持つ。
    /// 返り値:cap で「未処理のディレクトリ/ファイルが残ったか」= true。
    fn walk(
        root: &Path,
        include_exts: &[&str],
        files: &mut Vec<PathBuf>,
        max_files: usize,
        max_visits: usize,
    ) -> bool {
        use std::collections::BinaryHeap;
        use std::cmp::Reverse;

        // ヒープキー:(priority, depth, path文字列)。Reverse で min-heap 化。
        // path 文字列は決定性のためのタイブレーク。
        let mut heap: BinaryHeap<Reverse<(u8, u32, String, PathBuf)>> = BinaryHeap::new();
        let root_name = root.file_name().and_then(|n| n.to_str()).unwrap_or("");
        heap.push(Reverse((dir_priority(root_name), 0, String::new(), root.to_path_buf())));

        let mut had_more = false;
        let mut visits: usize = 0;
        'outer: while let Some(Reverse((_prio, depth, _tie, dir))) = heap.pop() {
            if files.len() >= max_files || visits >= max_visits {
                had_more = true;
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                visits += 1;
                if visits >= max_visits {
                    had_more = true;
                    break 'outer;
                }
                // file_type() は多くの環境で追加 stat 無しに種別が取れる(is_dir/is_file の
                // 二重 stat を避ける)。symlink はディレクトリ扱いしない=ループ回避にもなる。
                let is_dir = match entry.file_type() {
                    Ok(ft) => ft.is_dir(),
                    Err(_) => entry.path().is_dir(),
                };
                let path = entry.path();
                if is_dir {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !is_skippable_dir(name) && !name.starts_with('.') {
                        let key = path.to_string_lossy().to_string();
                        heap.push(Reverse((dir_priority(name), depth + 1, key, path)));
                    }
                } else {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    // 拡張子が対象、または秘密鍵ファイル名(.pem/.key/id_rsa 等)なら内容走査に含める。
                    // 後者を外すと PEM ヘッダ検出が本物の鍵ファイルに当たらない(Codex round 20 High)。
                    if include_exts.contains(&ext.as_str()) || is_private_key_file_name(name) {
                        if files.len() >= max_files {
                            had_more = true;
                            break 'outer;
                        }
                        files.push(path);
                    }
                }
            }
        }
        // heap にディレクトリが残っていれば未探索あり
        had_more || !heap.is_empty()
    }

    let folder_owned = folder_path.clone();
    let folder_for_sort = folder_path.clone();
    let (file_list, walk_truncated): (Vec<PathBuf>, bool) = tauri::async_runtime::spawn_blocking(move || {
        let mut list = Vec::new();
        let truncated = walk(&folder_owned, INCLUDE_EXTS, &mut list, MAX_WALK_FILES, MAX_WALK_VISITS);
        // 優先順位付き並び替え:
        //   MAX_SCAN_FILES=200 で content 読み込みが打ち切られる時、重要ファイルが
        //   後方に残ると誤検知(見つからなかった=安全)を招く。
        //   src/app/pages/routes/api/server/handlers/lib を先頭寄せる。
        list.sort_by_key(|p| {
            let rel = p.strip_prefix(&folder_for_sort).unwrap_or(p).to_string_lossy().replace('\\', "/");
            let lower = rel.to_lowercase();
            // 優先度:小さいほど先。「重要ディレクトリを含む」+「浅い」を優先。
            let priority: u8 = if lower.starts_with("src/") || lower.starts_with("app/")
                || lower.starts_with("pages/") || lower.starts_with("routes/")
                || lower.starts_with("api/") || lower.starts_with("server/")
                || lower.starts_with("handlers/") || lower.starts_with("lib/")
                || lower.contains("/src/") || lower.contains("/app/")
                || lower.contains("/pages/") || lower.contains("/api/")
                || lower.contains("/server/") { 0 }
            else if lower.starts_with("config/") || lower.contains("/config/")
                || !lower.contains('/') { 1 } // ルート直下 config 系
            else { 2 };
            let depth = rel.matches('/').count() as u32;
            (priority, depth, rel)
        });
        (list, truncated)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;

    // 打ち切り表示の判定は 2 段:
    //   (a) walk 自体が cap で中断した(bool フラグで実際に打ち切ったか判定)
    //   (b) 非テストファイル(content scan の実対象)が MAX_SCAN_FILES=200 を超えた
    // どちらも「未走査部分あり」を意味するので partial verdict の根拠になる。
    // (a) は `len == cap` の推測ではなく、walk が実際に「次の候補を処理できなかった」
    // 瞬間に返す true を信じる。ちょうど 10,000 件で walk が完走した repo を
    // 誤って partial 扱いにしない。
    let content_candidate_count = file_list
        .iter()
        .filter(|p| !is_test_file_path(p))
        .count();
    if walk_truncated || content_candidate_count > MAX_SCAN_FILES {
        files_truncated = true;
    }

    // v0.1.8:テストフレームワーク検出(AI 分析より新しい情報)
    // 1) 明示的な設定ファイル
    // 2) package.json / requirements.txt に framework 名
    // 3) test ファイル(*.test.*, *.spec.*, __tests__/)の存在
    for path in &file_list {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if detected_test_framework.is_none() {
            let n_lower = name.to_lowercase();
            if n_lower.starts_with("vitest.config.") {
                detected_test_framework = Some("Vitest".to_string());
            } else if n_lower.starts_with("jest.config.") {
                detected_test_framework = Some("Jest".to_string());
            } else if n_lower == "pytest.ini" || n_lower == "conftest.py" {
                detected_test_framework = Some("Pytest".to_string());
            } else if n_lower == "playwright.config.ts" || n_lower == "playwright.config.js" {
                detected_test_framework = Some("Playwright".to_string());
            } else if n_lower == "cypress.config.ts" || n_lower == "cypress.config.js"
                || n_lower == "cypress.json" {
                detected_test_framework = Some("Cypress".to_string());
            } else if n_lower == "karma.conf.js" || n_lower == "karma.conf.ts" {
                detected_test_framework = Some("Karma".to_string());
            } else if n_lower == "mocharc.json" || n_lower == ".mocharc.json"
                || n_lower == ".mocharc.js" {
                detected_test_framework = Some("Mocha".to_string());
            } else if n_lower == "phpunit.xml" || n_lower == "phpunit.xml.dist" {
                detected_test_framework = Some("PHPUnit".to_string());
            }
        }
        // has_test_files の判定は is_test_file_path と同じロジックを使う。
        // 2 実装があると片方の見落とし(__tests__/ など)を招くので必ず helper 経由。
        if !has_test_files && is_test_file_path(path) {
            has_test_files = true;
        }
    }

    // 4) package.json の dep 探索(まだ検出できていなければ)
    //    v0.1.10(Codex 指摘 Medium #6 対応):root だけでなく apps/*/ や
    //    packages/*/ の package.json も見る(pnpm/yarn/npm workspace 対応)。
    if detected_test_framework.is_none() {
        let candidates = [
            ("\"vitest\"", "Vitest"),
            ("\"jest\"", "Jest"),
            ("\"@playwright/test\"", "Playwright"),
            ("\"cypress\"", "Cypress"),
            ("\"mocha\"", "Mocha"),
            ("\"jasmine\"", "Jasmine"),
            ("\"karma\"", "Karma"),
            ("\"ava\"", "AVA"),
        ];

        // 探索候補パス:root + monorepo 慣例の apps/*/packages/*
        let mut pkg_paths: Vec<PathBuf> = vec![folder_path.join("package.json")];
        for mono_dir in ["apps", "packages", "services"] {
            let base = folder_path.join(mono_dir);
            if let Ok(entries) = std::fs::read_dir(&base) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        pkg_paths.push(p.join("package.json"));
                    }
                }
            }
        }

        'outer: for pkg_json in &pkg_paths {
            // Unity パッケージ(UPM)の package.json は除外。Windows では `packages` が Unity の
            // `Packages` に当たり、UPM 配下の package.json に "jest" 等があると
            // 「Jest 導入済みだがテスト無し」と誤表示する(Codex round 15 Medium)。
            if let Some(parent) = pkg_json.parent() {
                if package_json_is_unity(parent) { continue; }
            }
            let Ok(content) = std::fs::read_to_string(pkg_json) else { continue };
            for (needle, name) in candidates {
                if content.contains(needle) {
                    detected_test_framework = Some(name.to_string());
                    break 'outer;
                }
            }
        }

        // Python: requirements.txt / pyproject.toml
        if detected_test_framework.is_none() {
            for req_name in ["requirements.txt", "requirements-dev.txt", "pyproject.toml"] {
                let path = folder_path.join(req_name);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains("pytest") {
                        detected_test_framework = Some("Pytest".to_string());
                        break;
                    }
                }
            }
        }
    }

    // v0.1.10(Codex 指摘 Medium #6):content 読み込みは MAX_SCAN_FILES で打ち切る。
    //   file_list 自体は上流で MAX_WALK_FILES(10k)までを許容してあり、
    //   test framework/test file 検出のループは既にそちらを消化済み。
    // テストファイルは fixture として fake secret を含むのが普通なので content スキャンから除外。
    //   trufflehog / detect-secrets / bandit 等の業界標準ツールも同じ挙動。
    //   filter → take の順にする(take → filter の順だと cap 内でテストが多い時に
    //   実プロダクションが読まれずに終わる誤検知源になる)。
    let content_targets: Vec<PathBuf> = file_list
        .into_iter()
        .filter(|p| !is_test_file_path(p))
        .take(MAX_SCAN_FILES)
        .collect();
    // 内容読み込みの時間上限。上限を 8000 に上げたので、極端に重いプロジェクトでも走査が
    //   長引かないよう 6 秒で打ち切り、未走査分は partial(files_truncated)に倒す。
    let scan_start = Instant::now();
    for path in content_targets {
        if scan_start.elapsed() > Duration::from_secs(6) {
            files_truncated = true;
            break;
        }
        // read_to_string は非 UTF-8(Shift-JIS/UTF-16 の .cs 等、日本語 Windows で普通に
        // 起こる)で失敗する。それを「未走査=未完了」に数えると、実際は読める内容まで
        // partial 扱いになる。bytes で読んで from_utf8_lossy にすれば文字コードに関係なく
        // 走査でき、ASCII 部分(変数名 / console.log / TODO / secret 接頭辞)は保たれる。
        // 本当に読めない(権限等)場合だけ未走査扱いにする。
        let content = match std::fs::read(&path) {
            Ok(bytes) => decode_scan_bytes(&bytes),
            Err(_) => {
                files_truncated = true;
                continue;
            }
        };
        files_scanned += 1;
        let rel = path.strip_prefix(&folder_path).unwrap_or(&path)
            .to_string_lossy().replace('\\', "/");

        for (line_idx, raw_line) in content.lines().enumerate() {
            let line_num = line_idx + 1;
            let trimmed = raw_line.trim();
            if trimmed.is_empty() { continue; }
            // コメント風の行は誤検知が多いので TODO のみ抽出、シークレットは非コメントで判定
            let is_commentish = trimmed.starts_with("//") || trimmed.starts_with('#')
                || trimmed.starts_with('*') || trimmed.starts_with("<!--");

            // 1) シークレットのプレフィックス(自身のパターン定義や説明文を弾く強化版)。
            //   これが findings の secret 検出の唯一の経路(既知トークン + 接続文字列)。
            //   コメント行でも検出する:コメントアウトされた本物のキー(`// old key: ghp_...`)は
            //   実運用では普通に漏洩なので見逃さない。README の短い例示は is_plausible_secret_hit
            //   が本体長/引用符/左境界で落とす(Codex round 15 Medium)。
            //   ただし接続文字列(scheme://)だけはコメント行では検出しない。DB ライブラリの
            //   説明で `postgres://user:pass@host` のような例示が普遍的で、コメントで拾うと
            //   誤検出が多すぎる(本物の接続文字列漏洩は実コードにある)。既知トークン接頭辞は
            //   例示が稀なのでコメント行でも維持する。
            for (needle, kind) in secret_needles {
                if is_commentish && needle.ends_with("://") {
                    continue;
                }
                if raw_line.contains(needle) && is_plausible_secret_hit(raw_line, needle) {
                    secrets.push(ScanHit {
                        file: rel.clone(),
                        line: line_num,
                        snippet: mask_snippet(raw_line),
                        kind: kind.to_string(),
                    });
                    break;
                }
            }

            // 2) 変数名ヒューリスティック(変数名が secret っぽい + 値が長い)は撤去した。
            //   CLAUDE.md §6.5:これが誤検出(author / publicKey / authRecoveryTitle 等)の
            //   唯一の温床だった。「誤検出は許されない」方針に従い、findings は確実な検出
            //   (下の block 1 = 既知トークン接頭辞 + 接続文字列 + .env)だけにする。
            //   見逃す分は SECRET_NEEDLES に既知パターンを足して安全に補う(誤検出リスク無しで
            //   recall を上げられる)。ここには曖昧判定を戻さない。

            // 3) TODO / FIXME(コメント内かつ文字列リテラル外に限定)
            for tag in todo_needles {
                if raw_line.contains(tag) && is_tag_in_real_comment(raw_line, tag) {
                    todos.push(ScanHit {
                        file: rel.clone(),
                        line: line_num,
                        snippet: raw_line.chars().take(120).collect(),
                        kind: tag.to_string(),
                    });
                    break;
                }
            }

            // 4) console.log 検出(JS/TS 系のみ、文字列リテラル内は除外)
            //   v0.1.10(Codex 指摘 Medium #4):件数だけでなく file:line も記録。
            //   Cursor に「XX 箇所削除して」ではなく具体場所を渡せるようになり、
            //   意図的な console.error を巻き込む過剰修正が起きにくくなる。
            if !is_commentish
                && (rel.ends_with(".ts") || rel.ends_with(".tsx")
                    || rel.ends_with(".js") || rel.ends_with(".jsx"))
                && is_real_console_log(raw_line)
            {
                console_logs.push(ScanHit {
                    file: rel.clone(),
                    line: line_num,
                    snippet: raw_line.chars().take(120).collect::<String>().trim().to_string(),
                    kind: "console.log".to_string(),
                });
            }

        }
    }

    // truncate 前に総数を保存(UI/AI prompt での「N 箇所」表示に使う)。
    let secrets_total = secrets.len();
    let todos_total = todos.len();
    let console_logs_total = console_logs.len();

    // ノイズ削減:同ファイルで多発する項目は先頭 N 件までに絞る
    secrets.truncate(20);
    todos.truncate(50);
    console_logs.truncate(50);

    let project_meta = detect_project_meta(&folder_path);

    Ok(PreReleaseScanResult {
        secrets,
        todos,
        console_logs,
        secrets_total,
        todos_total,
        console_logs_total,
        files_scanned,
        files_truncated,
        detected_test_framework,
        has_test_files,
        env_files_present,
        env_covered_by_gitignore,
        env_tracked_files,
        project_meta,
    })
}

/// プロジェクトの manifest を全部集めて運用 gates 検出用の情報を返す。
///
/// **monorepo / Tauri 対応**:
///   root/package.json だけでなく apps/*/package.json、packages/*/package.json、
///   services/*/package.json、src-tauri/Cargo.toml なども見る。root に Cargo.toml と
///   frontend/package.json が両立する構成でも両方 gates 対象になる。
///
/// **script parse**:
///   `serde_json` で package.json を正式にパースする。以前の手 depth 計算は
///   `node -e "{...}"` のような script 値に含まれる brace で壊れていた。
fn detect_project_meta(folder: &Path) -> ProjectMeta {
    let has = |p: &str| folder.join(p).exists();

    // ── 1. manifest 収集(root + 慣例的 monorepo dirs + src-tauri)
    //   root と subdir を同じ関数で扱う。subdir を「package.json/Cargo.toml だけ」に
    //   狭めていた前実装は services/api/pyproject.toml、apps/admin/composer.json などを
    //   落としていたため、Node/Rust/Python/Go/Ruby/PHP を等しく検出する。
    let mut manifests: Vec<ManifestInfo> = Vec::new();

    collect_manifests_at(folder, folder, "", &mut manifests);

    // workspace 定義があればソース・オブ・トゥルースとして展開する。
    //   pnpm-workspace.yaml / package.json.workspaces の pattern から候補ディレクトリを
    //   実際に列挙(例:`examples/*` → examples/foo, examples/bar)。
    //   `apps|packages|services` 固定だと `examples/*` や `tools/*`、`apps/*/*` の
    //   nested 構成を落とすため。
    let workspace_dirs = expand_workspace_member_dirs(folder);
    for (sub, rel_prefix) in &workspace_dirs {
        // 既に同 prefix で拾っていればスキップ(重複防止)
        let dup = manifests.iter().any(|m| m.path.starts_with(&format!("{}/", rel_prefix)));
        if !dup {
            collect_manifests_at(sub, folder, rel_prefix, &mut manifests);
        }
    }

    // fallback:workspace 定義が無い場合の慣例ディレクトリ(直下 1 段)
    if workspace_dirs.is_empty() {
        for mono_dir in ["apps", "packages", "services"] {
            let base = folder.join(mono_dir);
            if let Ok(entries) = std::fs::read_dir(&base) {
                for entry in entries.flatten() {
                    let sub = entry.path();
                    if !sub.is_dir() { continue; }
                    let sub_name = sub.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if sub_name.starts_with('.') { continue; }
                    let rel_prefix = format!("{}/{}", mono_dir, sub_name);
                    collect_manifests_at(&sub, folder, &rel_prefix, &mut manifests);
                }
            }
        }
    }

    // Tauri 慣例:src-tauri/Cargo.toml(root Cargo.toml と併存できるため個別で拾う)
    if folder.join("src-tauri/Cargo.toml").exists()
        && !manifests.iter().any(|m| m.path == "src-tauri/Cargo.toml")
    {
        collect_manifests_at(&folder.join("src-tauri"), folder, "src-tauri", &mut manifests);
    }

    // ── 2. 代表 project_type / project_types(monorepo で複数ある時のため)
    let mut project_types: Vec<String> = manifests.iter().map(|m| m.manifest_type.clone()).collect();
    project_types.sort();
    project_types.dedup();
    let project_type = manifests.first().map(|m| m.manifest_type.clone());

    // ── 3. 単一プロジェクト後方互換のための代表 script フラグ
    let (has_build, has_test, has_typecheck) = manifests
        .first()
        .map(|m| (m.has_build, m.has_test, m.has_typecheck))
        .unwrap_or((false, false, false));

    // ── 4. project ワイドの情報
    let has_lockfile = manifests.iter().any(|m| m.has_lockfile)
        || has("package-lock.json") || has("yarn.lock") || has("pnpm-lock.yaml")
        || has("Cargo.lock") || has("poetry.lock") || has("Pipfile.lock")
        || has("Gemfile.lock") || has("composer.lock") || has("go.sum");
    // project-wide TS 判定は Node manifest 側の情報から導出。
    // has_tsconfig_file は「純粋な tsconfig 実在」、is_typescript_project は
    // 「tsconfig OR devDeps.typescript」で意味を分離。tsconfig 欠落 gate を
    // 将来追加するときに has_tsconfig_file だけ見ればよくなる。
    let has_tsconfig_file = manifests
        .iter()
        .any(|m| m.manifest_type == "node" && m.has_tsconfig_file);
    let is_typescript_project = manifests
        .iter()
        .any(|m| m.manifest_type == "node" && m.is_typescript_project);
    let has_ci_workflow = has(".github/workflows")
        || has(".gitlab-ci.yml")
        || has("azure-pipelines.yml")
        || has(".circleci/config.yml")
        || has("bitbucket-pipelines.yml")
        || has(".drone.yml");

    ProjectMeta {
        project_type,
        project_types,
        has_build_script: has_build,
        has_test_script: has_test,
        has_typecheck_script: has_typecheck,
        has_lockfile,
        has_tsconfig_file,
        is_typescript_project,
        has_ci_workflow,
        manifests,
    }
}

/// workspace 定義(pnpm-workspace.yaml / package.json.workspaces)の pattern から
/// 実在する member ディレクトリを列挙する。
///   `apps/*` → apps/ 直下の各ディレクトリ
///   `apps/**` / `apps/*/*` → 2 階層まで展開(それ以上の深さは実用上稀なので打ち切り)
///   negation(`!...`)pattern は除外リストとして適用。
/// 返り値:(絶対パス, root からの相対 prefix)
fn expand_workspace_member_dirs(project_root: &Path) -> Vec<(PathBuf, String)> {
    let mut patterns: Vec<(String, bool)> = Vec::new(); // (pattern, is_negation)

    // package.json.workspaces
    if let Ok(content) = std::fs::read_to_string(project_root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            let ws = v.get("workspaces");
            let arr: Vec<String> = if let Some(arr) = ws.and_then(|w| w.as_array()) {
                arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
            } else if let Some(obj) = ws.and_then(|w| w.as_object()) {
                obj.get("packages").and_then(|p| p.as_array())
                    .map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            for p in arr {
                let is_neg = p.starts_with('!');
                let clean = p.trim_start_matches('!').trim_start_matches("./").to_string();
                patterns.push((clean, is_neg));
            }
        }
    }
    // pnpm-workspace.yaml
    if let Ok(content) = std::fs::read_to_string(project_root.join("pnpm-workspace.yaml")) {
        let mut in_packages = false;
        for line in content.lines() {
            let mut trimmed = line.trim();
            if let Some(pos) = find_yaml_comment_start(trimmed) {
                trimmed = trimmed[..pos].trim_end();
            }
            if trimmed.starts_with("packages:") {
                in_packages = true;
                continue;
            }
            if in_packages {
                if let Some(rest) = trimmed.strip_prefix("- ") {
                    let raw = rest.trim().trim_matches('"').trim_matches('\'');
                    let is_neg = raw.starts_with('!');
                    let clean = raw.trim_start_matches('!').trim_start_matches("./").to_string();
                    patterns.push((clean, is_neg));
                } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    in_packages = false;
                }
            }
        }
    }
    if patterns.is_empty() {
        return Vec::new();
    }

    // pattern からディレクトリ候補を展開(segment 単位の再帰 glob)
    let mut result: Vec<(PathBuf, String)> = Vec::new();

    for (pattern, is_neg) in &patterns {
        if *is_neg { continue; } // negation は後段で filter
        let pat = pattern.trim_end_matches('/');
        // pattern を `/` の segment に分解し、segment 単位で glob 展開する。
        //   `apps/*/packages/*` → apps 直下 → 各 * → packages 直下 → 各 *
        //   `services/**` → services 配下を全階層再帰
        let segments: Vec<&str> = pat.split('/').collect();
        expand_segments(project_root, "", &segments, &mut result);
    }

    // negation pattern に一致する候補を除外
    let negations: Vec<&str> = patterns.iter().filter(|(_, n)| *n).map(|(p, _)| p.as_str()).collect();
    if !negations.is_empty() {
        result.retain(|(_, rel)| {
            !negations.iter().any(|n| workspace_glob_matches(n, rel))
        });
    }

    // `**` の再帰展開で同一ディレクトリが複数回入りうるので dedup(相対パス基準)。
    result.sort_by(|a, b| a.1.cmp(&b.1));
    result.dedup_by(|a, b| a.1 == b.1);

    result
}

/// workspace pattern の segment 列を再帰的に glob 展開して、実在ディレクトリを列挙する。
///   segment `*`  → 現在ディレクトリの子ディレクトリ全て(1 階層)
///   segment `**` → 現在ディレクトリ配下の全ディレクトリ(再帰、自身含む)
///   それ以外    → 固定名の子ディレクトリ
/// `cur_rel` は project_root からの現在の相対パス。マッチしたディレクトリを
/// (絶対パス, 相対パス) として out に push。
fn expand_segments(
    project_root: &Path,
    cur_rel: &str,
    segments: &[&str],
    out: &mut Vec<(PathBuf, String)>,
) {
    // 無限再帰・巨大展開の保護:相対パス階層が深すぎたら打ち切り。
    if cur_rel.matches('/').count() > 8 {
        return;
    }
    let cur_abs = if cur_rel.is_empty() {
        project_root.to_path_buf()
    } else {
        project_root.join(cur_rel)
    };
    // 全 segment 消化 → cur が最終マッチ
    let Some((seg, rest)) = segments.split_first() else {
        if !cur_rel.is_empty() && cur_abs.is_dir() {
            out.push((cur_abs, cur_rel.to_string()));
        }
        return;
    };

    let join_rel = |name: &str| -> String {
        if cur_rel.is_empty() { name.to_string() } else { format!("{}/{}", cur_rel, name) }
    };
    let child_dirs = |dir: &Path| -> Vec<String> {
        let mut names = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') && name != "node_modules" {
                        names.push(name);
                    }
                }
            }
        }
        names
    };

    if *seg == "**" {
        // `**` は 0 階層以上にマッチ。まず「この階層で ** を消費した」= rest を試す。
        expand_segments(project_root, cur_rel, rest, out);
        // 加えて子ディレクトリを再帰的に ** のまま辿る。
        for name in child_dirs(&cur_abs) {
            expand_segments(project_root, &join_rel(&name), segments, out);
        }
    } else if *seg == "*" {
        for name in child_dirs(&cur_abs) {
            expand_segments(project_root, &join_rel(&name), rest, out);
        }
    } else {
        // 固定名
        let next = join_rel(seg);
        if project_root.join(&next).is_dir() {
            expand_segments(project_root, &next, rest, out);
        }
    }
}

/// 指定ディレクトリ直下の manifest を全 6 種類チェックして manifests に push する。
///   Node / Rust / Python / Go / Ruby / PHP を root / subdir で同じルールで扱う。
///   `rel_prefix` は project root からの相対パス接頭辞("" for root、"apps/web" for subdir)。
/// package.json が Unity パッケージ(UPM)か。`unity` フィールドを持つ package.json は
/// Unity のパッケージ(第三者シェーダー等の依存物)であって、ユーザーの Node プロジェクト
/// ではない。Node 運用ゲート(build/CI/lockfile/test)を当てはめると全く無意味な指摘に
/// なるため manifest 収集から除外する。
///
/// なぜ踏むか:Windows はフォルダ名の大文字小文字を区別しないため、monorepo 検出の
/// `packages/` フォールバックが Unity の `Packages/` にヒットし、その中の第三者パッケージ
/// (例 jp.lilxyzw.liltoon)を「ユーザーの package」と誤認していた。
fn package_json_is_unity(dir: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("unity").cloned())
        .is_some()
}

fn collect_manifests_at(dir: &Path, project_root: &Path, rel_prefix: &str, out: &mut Vec<ManifestInfo>) {
    let has = |p: &str| dir.join(p).exists();
    let prefix = if rel_prefix.is_empty() { String::new() } else { format!("{}/", rel_prefix) };

    if has("package.json") && !package_json_is_unity(dir) {
        out.push(build_node_manifest(
            dir,
            project_root,
            &format!("{}package.json", prefix),
        ));
    }
    if has("Cargo.toml") {
        // Cargo.lock は同ディレクトリを優先。workspace member の場合は project root の Cargo.lock を参照。
        let local_lock = dir.join("Cargo.lock").exists();
        let root_lock = project_root.join("Cargo.lock").exists();
        out.push(build_rust_manifest(
            format!("{}Cargo.toml", prefix),
            local_lock || root_lock,
        ));
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        let file = if has("pyproject.toml") { "pyproject.toml" }
            else if has("requirements.txt") { "requirements.txt" }
            else { "setup.py" };
        out.push(build_python_manifest(
            dir,
            format!("{}{}", prefix, file),
            has("poetry.lock") || has("Pipfile.lock"),
        ));
    }
    if has("go.mod") {
        out.push(build_go_manifest(format!("{}go.mod", prefix), has("go.sum")));
    }
    if has("Gemfile") {
        out.push(build_ruby_manifest(format!("{}Gemfile", prefix), has("Gemfile.lock")));
    }
    if has("composer.json") {
        out.push(build_php_manifest(format!("{}composer.json", prefix), has("composer.lock")));
    }
}

/// package.json を `serde_json` で正式にパースし、scripts のキー有無を判定する。
/// 手 depth カウント方式は `node -e "{...}"` のような script 値の brace で
/// 壊れていた(false negative)ため。
fn build_node_manifest(dir: &Path, project_root: &Path, path: &str) -> ManifestInfo {
    let package_json = std::fs::read_to_string(dir.join("package.json")).ok();
    let parsed = package_json
        .as_deref()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
    let (has_build, has_test, has_typecheck) = parsed
        .as_ref()
        .map(|v| {
            let scripts = v.get("scripts").and_then(|s| s.as_object());
            let has_key = |k: &str| scripts.map_or(false, |m| m.contains_key(k));
            // 専用 typecheck スクリプトが無くても、いずれかの script の「値」で tsc を
            // 走らせていれば型検査はできている(`"build": "tsc && vite build"` が典型)。
            // これを見ないと default Vite react-ts テンプレ全部で誤って「typecheck 無し」が出る。
            let value_runs_tsc = scripts.map_or(false, |m| {
                m.values()
                    .any(|val| val.as_str().map_or(false, |s| s.contains("tsc")))
            });
            (
                has_key("build"),
                has_key("test"),
                has_key("typecheck") || has_key("type-check") || has_key("tsc") || value_runs_tsc,
            )
        })
        .unwrap_or((false, false, false));
    // devDependencies / dependencies に typescript が入っていれば TS プロジェクト扱い
    let has_ts_dep = parsed.as_ref().map_or(false, |v| {
        let dev = v.get("devDependencies").and_then(|s| s.as_object());
        let prod = v.get("dependencies").and_then(|s| s.as_object());
        dev.map_or(false, |m| m.contains_key("typescript"))
            || prod.map_or(false, |m| m.contains_key("typescript"))
    });
    let has_tsconfig_file = dir_has_tsconfig(dir);
    // TS project 判定は tsconfig ファイルまたは typescript 依存の OR。
    // これで tsconfig.app.json 単独構成でも devDeps.typescript 単独でも TS 扱いになる。
    let is_typescript_project = has_tsconfig_file || has_ts_dep;
    // Node lockfile 判定:
    //   1. local(sub package 直下)にあれば OK
    //   2. root にあり、かつ「この sub package が root のワークスペースメンバー」なら OK
    //   3. root にあっても workspace 外(独立 sub app 等)なら local 必須
    // 前実装は無条件で root 継承していたため、独立 sub package で誤って no-lockfile を
    // 出さないバグがあった(root lockfile は無関係)。
    let local_lock_names = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
    let local_lock = local_lock_names.iter().any(|f| dir.join(f).exists());
    let is_workspace_member = if dir == project_root {
        true // root 自身
    } else {
        node_workspace_includes(project_root, dir)
    };
    let root_lock = is_workspace_member
        && local_lock_names.iter().any(|f| project_root.join(f).exists());
    ManifestInfo {
        manifest_type: "node".to_string(),
        path: path.to_string(),
        has_build,
        has_test,
        has_typecheck,
        has_lockfile: local_lock || root_lock,
        has_tsconfig_file,
        is_typescript_project,
    }
}

/// root の `package.json.workspaces`(npm/yarn)または `pnpm-workspace.yaml` が
/// 指定の sub package path を含むか。単純 substring 検索。
///   - npm/yarn: `"workspaces": ["apps/*", "packages/*"]` の glob と、rel path の先頭一致
///   - pnpm: `pnpm-workspace.yaml` の `packages:` 内の glob との先頭一致
///
/// 判定不能(root package.json 無し / workspaces 未定義)なら「メンバーでない」に倒す。
fn node_workspace_includes(project_root: &Path, sub_dir: &Path) -> bool {
    let Ok(rel) = sub_dir.strip_prefix(project_root) else { return false; };
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    // 1) package.json.workspaces
    if let Ok(content) = std::fs::read_to_string(project_root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            let ws = v.get("workspaces");
            let patterns: Vec<String> = if let Some(arr) = ws.and_then(|w| w.as_array()) {
                arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect()
            } else if let Some(obj) = ws.and_then(|w| w.as_object()) {
                // yarn { "packages": [...] } 形式
                obj.get("packages").and_then(|p| p.as_array())
                    .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            for pat in &patterns {
                if workspace_glob_matches(pat, &rel_str) {
                    return true;
                }
            }
        }
    }
    // 2) pnpm-workspace.yaml — 実運用の書き方に合わせて頑張って parse:
    //   - inline comment `- "apps/*" # note` → `# note` を除去
    //   - `./packages/*` の先頭 `./` を正規化
    //   - `!**/dist/**` の negation は最後に一致した方を勝ちにする
    if let Ok(content) = std::fs::read_to_string(project_root.join("pnpm-workspace.yaml")) {
        let mut in_packages = false;
        let mut is_included = false; // 「最後に一致したルール」で更新
        for line in content.lines() {
            let mut trimmed = line.trim();
            // inline コメント除去(quote 外の `#` から後ろ)
            if let Some(pos) = find_yaml_comment_start(trimmed) {
                trimmed = trimmed[..pos].trim_end();
            }
            if trimmed.starts_with("packages:") {
                in_packages = true;
                continue;
            }
            if in_packages {
                if let Some(rest) = trimmed.strip_prefix("- ") {
                    let raw = rest.trim().trim_matches('"').trim_matches('\'');
                    // negation の適用順を保つ
                    let (pat, is_negation) = if let Some(pos_pat) = raw.strip_prefix('!') {
                        (pos_pat, true)
                    } else {
                        (raw, false)
                    };
                    // `./packages/*` を `packages/*` に正規化
                    let normalized = pat.strip_prefix("./").unwrap_or(pat);
                    if workspace_glob_matches(normalized, &rel_str) {
                        is_included = !is_negation;
                    }
                } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    in_packages = false;
                }
            }
        }
        if is_included {
            return true;
        }
    }
    false
}

/// YAML 行の quote 外の `#` 位置(コメント開始点)を返す。quote 内 `#` は無視。
fn find_yaml_comment_start(line: &str) -> Option<usize> {
    let mut in_single = false;
    let mut in_double = false;
    for (i, c) in line.char_indices() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => {
                // 直前が空白でない場合(URL#anchor 等)はコメント扱いしない
                let prev_is_space = i == 0
                    || line[..i].chars().rev().next().map_or(true, |c| c.is_whitespace());
                if prev_is_space {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// workspace pattern の最小 glob マッチ(`apps/*` `apps/**` `packages/foo` などを想定)。
fn workspace_glob_matches(pattern: &str, path: &str) -> bool {
    let pat = pattern.trim().trim_end_matches('/');
    let path = path.trim().trim_end_matches('/');
    let pat_segs: Vec<&str> = pat.split('/').filter(|s| !s.is_empty()).collect();
    let path_segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    glob_segments_match(&pat_segs, &path_segs)
}

/// segment 単位の glob マッチ(`*` は 1 セグメント、`**` は 0+ セグメント)。
/// `!**/dist/**` `apps/*/packages/*` のような workspace / negation pattern を扱う。
fn glob_segments_match(pat: &[&str], path: &[&str]) -> bool {
    match (pat.first(), path.first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(&"**"), _) => {
            // ** は 0 セグメント消費 or 1 セグメント消費して ** のまま継続
            glob_segments_match(&pat[1..], path)
                || (!path.is_empty() && glob_segments_match(pat, &path[1..]))
        }
        (Some(_), None) => false,
        (Some(&"*"), Some(_)) => glob_segments_match(&pat[1..], &path[1..]),
        (Some(&p), Some(&s)) => p == s && glob_segments_match(&pat[1..], &path[1..]),
    }
}

/// dir 直下に `tsconfig.json` or `tsconfig*.json` が 1 つでもあれば真。
/// Vite 系の `tsconfig.app.json` / `tsconfig.node.json` 構成を拾えるようにする。
/// `*.tsbuildinfo` は除外。
fn dir_has_tsconfig(dir: &Path) -> bool {
    if dir.join("tsconfig.json").exists() { return true; }
    let Ok(entries) = std::fs::read_dir(dir) else { return false; };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if name_str.starts_with("tsconfig.")
            && name_str.ends_with(".json")
            && !name_str.ends_with(".tsbuildinfo")
        {
            return true;
        }
    }
    false
}

fn build_rust_manifest(path: String, has_lockfile: bool) -> ManifestInfo {
    // Rust は cargo build / test / check がツールチェイン標準なので常に true
    ManifestInfo {
        manifest_type: "rust".to_string(),
        path,
        has_build: true,
        has_test: true,
        has_typecheck: true,
        has_lockfile,
        has_tsconfig_file: false,
        is_typescript_project: false,
    }
}

fn build_python_manifest(dir: &Path, path: String, has_lockfile: bool) -> ManifestInfo {
    let has_test = dir.join("pytest.ini").exists()
        || dir.join("conftest.py").exists()
        || std::fs::read_to_string(dir.join("pyproject.toml"))
            .map(|c| c.contains("pytest"))
            .unwrap_or(false);
    ManifestInfo {
        manifest_type: "python".to_string(),
        path,
        has_build: true, // false にすると Python に対して常に no-build-script が出るのを避ける
        has_test,
        has_typecheck: true,
        has_lockfile,
        has_tsconfig_file: false,
        is_typescript_project: false,
    }
}

fn build_go_manifest(path: String, has_lockfile: bool) -> ManifestInfo {
    ManifestInfo {
        manifest_type: "go".to_string(),
        path,
        has_build: true,
        has_test: true,
        has_typecheck: true,
        has_lockfile,
        has_tsconfig_file: false,
        is_typescript_project: false,
    }
}

fn build_ruby_manifest(path: String, has_lockfile: bool) -> ManifestInfo {
    ManifestInfo {
        manifest_type: "ruby".to_string(),
        path,
        has_build: true,
        has_test: true,
        has_typecheck: true,
        has_lockfile,
        has_tsconfig_file: false,
        is_typescript_project: false,
    }
}

fn build_php_manifest(path: String, has_lockfile: bool) -> ManifestInfo {
    ManifestInfo {
        manifest_type: "php".to_string(),
        path,
        has_build: true,
        has_test: true,
        has_typecheck: true,
        has_lockfile,
        has_tsconfig_file: false,
        is_typescript_project: false,
    }
}

// v0.1.10:detect_potential_error は誤検知率が高すぎて実害の方が大きく、削除。
// リリース前チェックは信頼度の高い実 grep ベース検出のみに絞った。

/// 与えられたパスがテストファイルか判定する(言語別マーカー)。
///   - JS/TS:  *.test.* / *.spec.*
///   - Python: test_*.py / *_test.py
///   - Rust:   tests/ 配下 or #[cfg(test)] を含むファイル(名前だけでは判定困難なので tests/ 配下 + `_test.rs` 慣例)
///   - Go:     *_test.go
///   - Ruby:   *_spec.rb / *_test.rb
///   - JVM:    *Test / *Tests / *Spec で終わるファイル
///   - 一般:   __tests__ / __test__ 配下(JS 慣例)
fn is_test_file_path(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let full = path.to_string_lossy().replace('\\', "/");
    let full_lower = full.to_lowercase();

    // 汎用:__tests__ / __test__ ディレクトリ配下(先頭 or 途中どちらでも)
    if full.contains("/__tests__/") || full.contains("/__test__/")
        || full.starts_with("__tests__/") || full.starts_with("__test__/") {
        return true;
    }

    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            name.contains(".test.") || name.contains(".spec.")
        }
        "py" => name.starts_with("test_") || name.ends_with("_test.py"),
        "rs" => {
            // Rust: tests/*.rs(integration test)or ファイル名末尾が `_test.rs`。
            //   inline #[cfg(test)] mod tests までは名前判定できないので、
            //   ここでは path-based だけに絞る(名前 wise は不十分だが安全側)。
            let in_tests_dir = (full_lower.contains("/tests/") || full_lower.starts_with("tests/"))
                && !full_lower.contains("/target/");
            in_tests_dir || name.ends_with("_test.rs")
        }
        "go" => name.ends_with("_test.go"),
        "rb" => name.ends_with("_spec.rb") || name.ends_with("_test.rb"),
        "java" | "kt" | "scala" => {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            stem.ends_with("Test") || stem.ends_with("Tests") || stem.ends_with("Spec")
        }
        // C# / Unity:FooTest(s).cs / FooSpec.cs、または Tests/ 配下(Unity は Editor/Tests)。
        "cs" => {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            stem.ends_with("Test") || stem.ends_with("Tests") || stem.ends_with("Spec")
                || full_lower.contains("/tests/") || full_lower.contains("/test/")
                || full_lower.starts_with("tests/")
        }
        _ => false,
    }
}

/// key_body の末尾から identifier(英数字 / `_` / `-`)の連続だけを切り出す。
///
/// なぜ専用関数か:`rfind` は「マッチした文字の先頭 byte」を返すため、直前が
/// マルチバイト文字(日本語コメント・全角記号など)だと `pos + 1` が UTF-8 の
/// char 境界を割り、`&key_body[pos + 1..]` が panic する。日本語を含むファイル
/// (Unity の JSON / C# 等)で実際にスキャンが落ちた。char_indices で境界を保つ。
fn trailing_identifier(key_body: &str) -> &str {
    let start = key_body
        .char_indices()
        .rev()
        .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '_' && *c != '-')
        .map(|(i, c)| i + c.len_utf8()) // マッチ文字の「次」の境界へ進める
        .unwrap_or(0);
    &key_body[start..]
}

/// 変数名を token に分割する(`_` `-` 区切り + camelCase 境界)。全て小文字化。
///   `SUPABASE_SERVICE_ROLE_KEY` → ["supabase","service","role","key"]
///   `clientSecret` → ["client","secret"]
///   `PASSWORDLESS` → ["passwordless"](区切りなしの単一 token)
fn tokenize_var_name(name: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if c == '_' || c == '-' || c == '.' {
            if !cur.is_empty() { tokens.push(std::mem::take(&mut cur)); }
            prev_lower = false;
            continue;
        }
        // camelCase 境界:小文字 → 大文字
        if c.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
        }
        cur.push(c.to_ascii_lowercase());
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
    }
    if !cur.is_empty() { tokens.push(cur); }
    tokens
}

/// 変数名(LHS)が「secret を保持していそうな名前」かを判定する。
///
/// token 境界で判定する(substring マッチだと DEFAULT_ADMIN_PASSWORD が `default` に
/// ヒットして本物 secret を殺す回帰があったため)。
///   - SAFE_TOKENS のどれかが token に一致 → 非 secret(hint/id/name/type 等の構造語)
///   - SECRET_MARKERS のどれかを token が含む → secret(key/secret/token/password 等)
///
/// `default` `sample` `example` `mock` `dummy` `placeholder` は名前では弾かず、値側の
/// is_placeholder_value で判定する(DEFAULT_ADMIN_PASSWORD="realpw" は検出したい)。
fn is_secret_variable_name(lhs: &str) -> bool {
    let tokens = tokenize_var_name(lhs);
    // 構造的に secret でないことが確実な token(完全一致で除外)。
    // public/primary/... は「公開鍵」「DB キー」など secret でない key 修飾語。
    const SAFE_TOKENS: &[&str] = &[
        "hint", "id", "name", "type", "path", "prefix", "suffix", "label",
        "readme", "keyword", "keyboard", "keychain", "passwordless", "layout",
        "ttl", "expiry", "expires", "expire", "count", "length", "size",
        "public", "primary", "partition", "sort", "foreign", "row", "cache",
        "routing", "map", "idempotency",
    ];
    for t in &tokens {
        if SAFE_TOKENS.contains(&t.as_str()) {
            return false;
        }
    }
    // 単独の "key" は汎用すぎる(CI cache key / map key / primary key)。修飾付き
    // (apiKey/secretKey)や既知 prefix(block 1)に委ねるため、単独では secret 扱いしない。
    if tokens.len() == 1 && tokens[0] == "key" {
        return false;
    }
    // 短い曖昧マーカーは token 完全一致で判定する。substring だと author⊃auth /
    // tokenizer⊃token / secretary⊃secret / monkey⊃key を誤検出していた。
    const EXACT_MARKERS: &[&str] = &[
        "key", "secret", "token", "password", "passwd", "pwd", "passphrase",
        "auth", "authorization", "credential", "credentials", "webhook", "dsn",
    ];
    // 複合語は substring(APIKEY / PRIVATEKEY のように区切り無しで綴られる)。
    const SUBSTRING_MARKERS: &[&str] = &["apikey", "privatekey", "accesskey", "secretkey"];
    for t in &tokens {
        if EXACT_MARKERS.contains(&t.as_str()) {
            return true;
        }
        if SUBSTRING_MARKERS.iter().any(|m| t.contains(m)) {
            return true;
        }
    }
    false
}

/// プロジェクト内の `.env*` ファイルを再帰的に収集する。
///   - `.env.example` `.env.sample` `.env.template` は意図的に共有される非秘密なので除外
///   - node_modules / .git / target / dist / build 等はスキップ
///   - out には base からの相対パス(POSIX 区切り)を入れる
/// 戻り値 = 打ち切りが起きたか(上限 max 到達 or 深さ上限)。true なら「未走査の .env が
/// 残っているかもしれない」ことを呼び出し側に伝え、Ready 断定を避ける材料にする
///(Codex round 19 Medium:静かに打ち切ると 513 個目以降の未保護 .env を見逃す)。
fn collect_env_files(dir: &Path, base: &Path, out: &mut Vec<String>, max: usize, depth: usize) -> bool {
    // 深さ上限:ディレクトリ symlink の循環や異常に深いツリーでの無限再帰
    // (= スタックオーバーフローによる強制クラッシュ)を防ぐ保険。
    const MAX_DEPTH: usize = 24;
    if out.len() >= max || depth > MAX_DEPTH { return true; }
    // read_dir エラー(権限等)は稀で、通常は skip 対象の system dir。ここを打ち切り扱いに
    // すると正常なプロジェクトまで partial に倒れて UX が悪化するため false のままにする。
    let Ok(entries) = std::fs::read_dir(dir) else { return false; };
    let mut truncated = false;
    for entry in entries.flatten() {
        if out.len() >= max { return true; }
        // file_type() は symlink を辿らない。path.is_dir() は symlink を辿るため、
        // `a/b -> a` のような循環でスタックオーバーフローし得た。
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Unity/.NET の巨大キャッシュも除外(is_skippable_dir に一元化)。これが無いと
            // .env 探索だけで Library 配下 2 万ファイルを走査してしまう。
            if !is_skippable_dir(name) {
                if collect_env_files(&path, base, out, max, depth + 1) {
                    truncated = true;
                }
            }
        } else if ft.is_file() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let is_env = name == ".env" || name.starts_with(".env.");
            let is_example = name.ends_with(".example")
                || name.ends_with(".sample")
                || name.ends_with(".template")
                || name.ends_with(".dist");
            if is_env && !is_example {
                let rel = path.strip_prefix(base).unwrap_or(&path)
                    .to_string_lossy().replace('\\', "/");
                out.push(rel);
            }
        }
    }
    truncated
}

/// env ファイル(root 相対 POSIX パス)が `.gitignore` で無視されるかを判定する。
///
/// v0.1.33(Codex round 17-18):手書きの近似 glob を廃止し、ripgrep と同じ `ignore`
/// クレートに委譲する。末尾 `/`(ディレクトリ専用)・`**`・否定 `!`・アンカリングを
/// すべて Git 互換で処理でき、手書き実装で繰り返し出ていたエッジケースの取りこぼし/
/// 誤検出を恒久的に無くす。root からファイルの親までの各 `.gitignore` を深い方から
/// 評価し(Git は対象に近い `.gitignore` が優先)、最初に確定した結果を採る。
fn env_file_is_gitignored(root: &Path, rel_path: &str) -> bool {
    use ignore::gitignore::GitignoreBuilder;
    use ignore::Match;

    let parts: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return false;
    }
    // 深い階層の .gitignore から順に評価(Git は対象に近い .gitignore が優先)。
    // 深い whitelist は「候補」として保持する。上位で祖先ディレクトリが除外されていれば
    // 子は `!child` でも再 include できないため、深い whitelist だけで未保護と断定しない
    //(Codex round 19 High:root=`apps/` + apps/web/.gitignore=`!.env` の取りこぼし)。
    let mut whitelisted_by_deeper = false;
    for depth in (0..parts.len()).rev() {
        let mut gi_dir = root.to_path_buf();
        for p in &parts[..depth] {
            gi_dir.push(p);
        }
        let gitignore_path = gi_dir.join(".gitignore");
        if !gitignore_path.is_file() {
            continue;
        }
        let mut builder = GitignoreBuilder::new(&gi_dir);
        // add はパースエラー時に Some(err) を返す。その階層は skip する。
        if builder.add(&gitignore_path).is_some() {
            continue;
        }
        let Ok(gi) = builder.build() else { continue };
        let sub = &parts[depth..];
        // git ルール:親ディレクトリが除外されていると、子は `!child` でも再 include できない。
        //   この .gitignore から見た各祖先ディレクトリを is_dir=true で確認し、ignore されて
        //   いれば即 ignored 確定(ファイル側の whitelist より優先)。
        let ancestor_ignored = (1..sub.len()).any(|k| {
            matches!(gi.matched(sub[..k].join("/"), true), Match::Ignore(_))
        });
        if ancestor_ignored {
            return true;
        }
        // 祖先が除外されていなければ、ファイル自身の ignore/whitelist を採る。
        //   深い階層で whitelist 済みなら、この階層の Ignore では上書きしない(深い方が優先)。
        match gi.matched(sub.join("/"), false) {
            Match::Ignore(_) if !whitelisted_by_deeper => return true,
            Match::Ignore(_) => {}
            Match::Whitelist(_) => whitelisted_by_deeper = true,
            Match::None => {}
        }
    }
    false
}

/// v0.1.8:プレフィックス マッチが「実際の秘密キー」らしいか判定する。
/// 目的:AppMap 自身のパターン定義配列(`("sk-", "openai-like key")`)や
///       README の説明文などを誤検知しないため。
/// ルール:
///   1) プレフィックスの直前が `"`/`'` で、直後 15 文字以内に閉じ引用符があれば
///      「短い引用符囲みの中」= パターン定義や説明文と見なして棄却
///   2) プレフィックス末尾からキー本体らしき連続文字([A-Za-z0-9_/+=-])を数え、
///      16 文字未満なら本物のキーではないと見なして棄却
///   3) PRIVATE KEY のような長いプレフィックスは 1) の判定だけを適用(それ自身が有意)
///
/// v0.1.32(Codex round 16 High):1 行に prefix が複数回現れる場合を全部見る。
///   例:`// 例: postgres://user:pass@host  実際は postgres://appuser:Xk29@10.0.3.5/db`
///   先頭一致(旧 `line.find`)だけだと最初の placeholder で false 判定して打ち切り、
///   後続の本物を取りこぼしていた。全出現を走査し、どれか 1 つでも本物らしければ真。
fn is_plausible_secret_hit(line: &str, prefix: &str) -> bool {
    line.match_indices(prefix)
        .any(|(prefix_start, _)| is_plausible_hit_at(line, prefix, prefix_start))
}

/// prefix が `prefix_start` に 1 回出現したとき、その箇所が本物の秘密っぽいかを判定する。
/// is_plausible_secret_hit が各出現位置ごとに呼ぶ内部ヘルパ。
fn is_plausible_hit_at(line: &str, prefix: &str, prefix_start: usize) -> bool {
    let prefix_end = prefix_start + prefix.len();
    let bytes = line.as_bytes();

    // ルール 0(左境界):プレフィックス直前が英数字なら単語の途中。
    //   `sk-` が `task-`/`risk-`/`disk-`、`SG.` が `<img>` 等に誤ヒットするのを防ぐ。
    //   本物のキーは必ずクオート/空白/`=`/`:`/`(`(いずれも非英数字)の後に来る。
    if prefix_start > 0 && bytes[prefix_start - 1].is_ascii_alphanumeric() {
        return false;
    }

    // ルール 1:短い引用符囲みは棄却
    if prefix_start > 0 {
        let quote = bytes[prefix_start - 1];
        if quote == b'"' || quote == b'\'' {
            let tail = &line[prefix_end..];
            let mut chars = tail.char_indices();
            let mut closed_within = None;
            for (i, c) in &mut chars {
                if c == quote as char {
                    closed_within = Some(i);
                    break;
                }
                if i > 30 { break; } // 30 バイト以内で閉じるかだけ見れば充分
            }
            if let Some(close_pos) = closed_within {
                if close_pos < 16 {
                    return false; // "sk-" のような短い引用符囲み
                }
            }
        }
    }

    // ルール 1.5(Codex 二次指摘 Low #6 対応):URL 形式の prefix は
    //   credential 分離子 `@` を含む場合のみ secret 扱いにする。
    //   例:`mongodb+srv://user:pass@host/db` → 検出
    //       `mongodb+srv://localhost/app`     → 誤検知扱いで棄却
    //   接続先ホスト名は情報漏洩リスクこそあれ「秘密キー」ではないため、
    //   リリース前チェックとしては credential ありのみに絞る。
    if prefix.ends_with("://") {
        let tail = &line[prefix_end..];
        // 空白 / クオート / セミコロン / バッククォート で URL 終端と判断
        let terminator = tail.find(|c: char| {
            c.is_whitespace() || c == '"' || c == '\'' || c == ';' || c == '`' || c == '<'
        });
        let body = match terminator {
            Some(pos) => &tail[..pos],
            None => tail,
        };
        if !body.contains('@') {
            return false;
        }
        // userinfo(:// と @ の間)が明らかな placeholder(user:pass 等)なら、ドキュメント/
        // コメント中の"例"であって本物の資格情報ではない。棄却する。コメント行も検出する
        // ようにした副作用で、スキャナ自身の説明コメント(`例:mongodb+srv://user:pass@host`)まで
        // 拾っていた(Codex round 15 の comment 検出の後始末)。本物の接続文字列は実資格情報を持つ。
        if let Some(at) = body.find('@') {
            let userinfo = body[..at].to_lowercase();
            let pw = userinfo.rsplit(':').next().unwrap_or("");
            const PLACEHOLDER_PW: &[&str] = &[
                "pass", "password", "passwd", "pwd", "secret", "changeme",
                "xxx", "***", "your_password", "yourpassword", "user", "example",
            ];
            const PLACEHOLDER_USERINFO: &[&str] = &[
                "user:pass", "user:password", "username:password", "user:secret",
                "admin:admin", "root:root", "foo:bar", "user:xxx",
            ];
            if PLACEHOLDER_PW.contains(&pw) || PLACEHOLDER_USERINFO.contains(&userinfo.as_str()) {
                return false;
            }
        }
        // credential ありなら以下のルール 2/3 を通さず即真(URL 自体で 20 字超)
        return true;
    }

    // ルール 3:長いプレフィックスは本体長さ判定をスキップ(--BEGIN PRIVATE KEY-- 等)
    if prefix.len() >= 20 { return true; }

    // ルール 2:プレフィックス末尾から key-body-like な文字列を数える
    let tail = &line[prefix_end..];
    let body_len = tail.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '/' || *c == '+' || *c == '=')
        .count();
    body_len >= 16
}

/// v0.1.8:TODO/FIXME/HACK タグが「実際の作業マーカー」として書かれているか判定する。
/// AppMap 自身のコード(タグを扱う文字列リテラル・doc コメント)を誤検知しないため。
///
/// 判定ルール(全部通ったら真):
///   1) 単語境界:タグの前後が英数字/アンダースコアでない(TODO_LIST 等をはじく)
///   2) 文字列リテラル内でない(直前までの引用符が奇数個ならリテラル中と見なす)
///   3) タグ直後が `:` または `(` である(TODO: xxx / TODO(#123): xxx が典型)
///      -> `TODO / FIXME` のような doc 内の列挙をはじく主目的
///   4) コメント境界内にある(タグより前に `//` `/*` `<!--` `#` `*` のいずれかがある)
///   5) 同じ行に別のタグが出現していない(タグ列挙の doc をさらに強くはじく)
fn is_tag_in_real_comment(line: &str, tag: &str) -> bool {
    let Some(idx) = line.find(tag) else { return false };
    let after = idx + tag.len();

    // ルール 1:単語境界
    let before_ch = if idx == 0 { ' ' } else { line.as_bytes()[idx - 1] as char };
    let after_ch = if after >= line.len() { ' ' } else { line.as_bytes()[after] as char };
    if before_ch.is_ascii_alphanumeric() || after_ch.is_ascii_alphanumeric()
        || before_ch == '_' || after_ch == '_' {
        return false;
    }

    // ルール 2:文字列リテラル内なら棄却
    let mut in_single = false;
    let mut in_double = false;
    let mut in_back = false;
    for (i, c) in line.char_indices() {
        if i >= idx { break; }
        match c {
            '\'' if !in_double && !in_back => in_single = !in_single,
            '"' if !in_single && !in_back => in_double = !in_double,
            '`' if !in_single && !in_double => in_back = !in_back,
            _ => {}
        }
    }
    if in_single || in_double || in_back { return false; }

    // ルール 3:タグ直後が `:` または `(` を要求(実際の作業マーカーの記法)
    // `TODO:` `TODO(#123):` `FIXME:` などにマッチ、`TODO / FIXME` `TODO のみ` を除外
    if after_ch != ':' && after_ch != '(' {
        return false;
    }

    // ルール 3.5(Codex 指摘 Medium #3 対応):tracked TODO/FIXME は finding にしない。
    //   `TODO(#123): xxx` `TODO(ISSUE-42): xxx` `TODO(123): xxx` は
    //   既に issue に紐付いた既知タスク。fixSteps でユーザーに
    //   「issue 番号付きに整理して」と依頼するので、これを再検出すると
    //   Cursor が指示通り直しても finding が消えず矛盾する。
    //
    //   v0.1.10(Codex 二次指摘 Low #5 対応):`TODO(@user)` は tracked 扱いから
    //   外す。owner が付いてるだけでは「作業が管理されている」ことを保証しない
    //   (実際は担当者が付いた未完了タスクこそ出荷前に見逃したくない)。
    if after_ch == '(' {
        let after_paren = &line[after + 1..];
        if let Some(close_pos) = after_paren.find(')') {
            let inside = after_paren[..close_pos].trim();
            if !inside.is_empty() {
                let is_tracked = inside.starts_with('#')      // #123
                    || inside.chars().all(|c| c.is_ascii_digit()) // 123
                    // JIRA / linear 風:PROJECT-123 / ENG-42
                    || (inside.contains('-')
                        && inside.chars().any(|c| c.is_ascii_digit())
                        && inside.chars().next().map_or(false, |c| c.is_ascii_alphabetic()));
                if is_tracked {
                    return false;
                }
            }
        }
    }

    // ルール 4:コメント境界
    let before_slice = &line[..idx];
    let trimmed = line.trim_start();
    let in_comment = trimmed.starts_with('#')
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with("*")
        || trimmed.starts_with("<!--")
        || before_slice.contains("//")
        || before_slice.contains("/*")
        || before_slice.contains("<!--");
    if !in_comment { return false; }

    // ルール 5:同じ行にタグが 2 回以上出現していたら doc 説明扱いで棄却
    // 別タグの列挙(TODO / FIXME)も、同じタグの複数出現(TODO: xxx / TODO(#123): yyy)も対象。
    let mut total_occurrences = 0usize;
    for t in ["TODO", "FIXME", "HACK"] {
        total_occurrences += line.matches(t).count();
        if total_occurrences >= 2 { return false; }
    }

    true
}

/// v0.1.8:`console.log` が「実際のコード呼び出し」か判定する。
/// 文字列リテラル・doc コメント内の説明的な `console.log` を誤検知しない。
///
/// v0.1.10(Codex 指摘 Low #7 対応):
///   - `console.log(` に加え `console.log (`(空白許容)と `console?.log(`(optional chaining)も検出
fn is_real_console_log(line: &str) -> bool {
    // マッチ候補と、それぞれの「タグ直後にどこまで空白を許すか」の判定は
    // 共通ロジックにまとめる。まず候補位置を探す。
    let candidates = [
        ("console.log", 11),
        ("console?.log", 12),
    ];

    for (target, target_len) in candidates {
        let mut search_from = 0usize;
        while let Some(rel_idx) = line[search_from..].find(target) {
            let idx = search_from + rel_idx;
            // 左境界:console の直前が識別子文字(英数字/_/$)なら myconsole.log 等の
            // 別ロガー。window.console.log は直前が `.` なので通る。
            let boundary_ok = idx == 0 || {
                let b = line.as_bytes()[idx - 1];
                !(b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
            };
            // 直後は空白 0〜複数を許容してから `(` を要求
            let after_target = idx + target_len;
            let rest = &line[after_target..];
            let stripped = rest.trim_start();
            let paren_ok = stripped.starts_with('(');
            if boundary_ok && paren_ok && !is_inside_string_literal(line, idx) {
                return true;
            }
            search_from = after_target;
        }
    }
    false
}

/// v0.1.10:`idx` の位置が文字列リテラル内かを判定するヘルパ。
/// `'` `"` `` ` `` の奇偶で in-quote 状態を追う。
fn is_inside_string_literal(line: &str, idx: usize) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let mut in_back = false;
    for (i, c) in line.char_indices() {
        if i >= idx { break; }
        match c {
            '\'' if !in_double && !in_back => in_single = !in_single,
            '"' if !in_single && !in_back => in_double = !in_double,
            '`' if !in_single && !in_double => in_back = !in_back,
            _ => {}
        }
    }
    in_single || in_double || in_back
}

/// 値そのものを晒さないための伏せ字化。
/// クオート内の 8 字以上の値は "..." に置換する。
/// ファイルの生バイトを走査用文字列にデコードする。UTF-8 に加え UTF-16(BOM 付き)と
/// BOM 無し UTF-16LE(推定)を扱う。日本語 Windows の一部ツールが .cs 等を UTF-16 で保存
/// することがあり、from_utf8_lossy だと ASCII が `A\0K\0…` となって needle 検出が全滅する
/// (Codex round 15 Medium)。
fn decode_scan_bytes(bytes: &[u8]) -> String {
    // BOM 判定
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let u: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let u: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    // BOM 無し UTF-16 推定。ASCII は LE=[byte,0x00] / BE=[0x00,byte] となり、片側の
    //   バイト位置に NUL が偏る。日本語主体だと NUL は減るが、改行やコード片・記号は必ず
    //   ASCII なので偏りは残る(Codex round 16 Medium:先頭 512B が日本語だけだと旧判定が
    //   取りこぼしていた)。対策:窓を 8KB に広げ、しきい値 60% に加えて「片側 NUL が反対側の
    //   4 倍超 かつ 30% 超」という偏り条件も採用。UTF-8 テキストは NUL がほぼ皆無なので
    //   どちらの条件も踏まず、from_utf8_lossy に落ちる(誤判定リスクは実質無い)。
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.len() >= 16 {
        let pairs = (sample.len() / 2).max(1);
        let odd_nuls = sample.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
        let even_nuls = sample.iter().step_by(2).filter(|&&b| b == 0).count();
        let odd_pct = odd_nuls * 100 / pairs;
        let even_pct = even_nuls * 100 / pairs;
        // LE:高位バイト(奇数位置)が NUL 優勢
        if odd_pct >= 60 || (odd_pct >= 30 && odd_nuls >= even_nuls.saturating_mul(4) + 4) {
            let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            return String::from_utf16_lossy(&u);
        }
        // BE:高位バイト(偶数位置)が NUL 優勢
        if even_pct >= 60 || (even_pct >= 30 && even_nuls >= odd_nuls.saturating_mul(4) + 4) {
            let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            return String::from_utf16_lossy(&u);
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 既知トークン(SECRET_NEEDLES)が行に含まれていたら、変数名・引用符に関係なく
/// トークン本体(接頭辞 + 続くキー文字)を伏字化する。
///
/// なぜ必要か:mask_bare_assignments は大文字キーしか伏せないため、
/// `github_token=ghp_xxxx`(小文字 snake_case のクオート無し代入)は検出されるのに
/// 値が平文でスニペットに残る漏洩があった(Codex round 15 High)。検出した秘密を
/// 画面に晒さないため、既知接頭辞は無条件でトークンごと伏せる。
fn mask_known_tokens(line: &str) -> String {
    let mut out = line.to_string();
    for (needle, _) in SECRET_NEEDLES {
        // PEM / URL 接頭辞は別マスカ(mask_url_credentials 等)が扱う。ここは短い接頭辞トークンのみ。
        if needle.starts_with("-----BEGIN") || needle.ends_with("://") {
            continue;
        }
        // 同一行に複数出現しても全部潰す。置換文字列に needle は含まれないので無限ループしない。
        while let Some(pos) = out.find(needle) {
            let after = &out[pos + needle.len()..];
            let body_len: usize = after
                .chars()
                .take_while(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '+' | '=' | '.')
                })
                .map(|c| c.len_utf8())
                .sum();
            out.replace_range(pos..pos + needle.len() + body_len, "*** (伏字) ***");
        }
    }
    out
}

fn mask_snippet(line: &str) -> String {
    let quoted_masked = mask_quoted_values(line);
    let url_masked = mask_url_credentials(&quoted_masked);
    let bare_masked = mask_bare_assignments(&url_masked);
    let token_masked = mask_known_tokens(&bare_masked);
    token_masked.chars().take(200).collect()
}

/// クオート内(`"..."` / `'...'`)の 8 文字以上の値を伏せ字化する。
fn mask_quoted_values(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quote = c;
            out.push(quote);
            let mut inner = String::new();
            while let Some(&nc) = chars.peek() {
                if nc == quote { break; }
                inner.push(nc);
                chars.next();
            }
            if inner.len() >= 8 {
                out.push_str(MASK);
            } else {
                out.push_str(&inner);
            }
            if let Some(&nc) = chars.peek() {
                if nc == quote { out.push(quote); chars.next(); }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// URL のクレデンシャル部分(`scheme://user:pass@host`)を伏せ字化する。
/// `postgres://alice:s3cret@db.host/app` → `postgres://***:***@db.host/app`
fn mask_url_credentials(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(scheme_end) = find_scheme_at(line, i) {
            // scheme + "://" までコピー
            out.push_str(&line[i..scheme_end + 3]);
            let after_scheme = scheme_end + 3;
            // user[:pass]@ を探す(空白/quote/セミコロン/バッククォート/`<`/`>`で URL 終端)
            let end = line[after_scheme..]
                .find(|c: char| {
                    c.is_whitespace() || c == '"' || c == '\'' || c == ';' || c == '`' || c == '<' || c == '>'
                })
                .map(|p| after_scheme + p)
                .unwrap_or(bytes.len());
            let url_body = &line[after_scheme..end];
            if let Some(at_pos) = url_body.find('@') {
                let cred = &url_body[..at_pos];
                let host_and_rest = &url_body[at_pos..]; // '@...' 部分
                if cred.contains(':') {
                    out.push_str("***:***");
                } else if !cred.is_empty() {
                    out.push_str("***");
                }
                out.push_str(host_and_rest);
            } else {
                out.push_str(url_body);
            }
            i = end;
        } else {
            let ch = line[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// `KEY=value` / `KEY: value` 形式(クオートなし)の 8 文字以上の値を伏せ字化する。
/// .env や export 行、YAML 単純値をカバー。値が `${VAR}` や既に伏せ字マーカーなら触らない。
fn mask_bare_assignments(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    while i < bytes.len() {
        // KEY=... か KEY: ... の位置を探す(単純ステートマシン)
        // KEY は [A-Z_][A-Z0-9_]{1,} 相当
        let key_start = i;
        let mut key_end = i;
        while key_end < bytes.len() {
            let b = bytes[key_end];
            if (b as char).is_ascii_alphanumeric() || b == b'_' {
                key_end += 1;
            } else {
                break;
            }
        }
        if key_end == key_start {
            // ここには KEY 候補が無い。1 バイト送って続行
            let ch = line[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let key = &line[key_start..key_end];
        // '=' または ':' が続くか
        let sep_char = bytes.get(key_end).copied();
        let is_env_key = key.chars().any(|c| c.is_ascii_uppercase() || c == '_');
        let looks_secretly_named = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PWD", "PASS", "URL", "URI", "DSN", "AUTH"]
            .iter()
            .any(|kw| key.contains(kw));
        if !(is_env_key && looks_secretly_named) || sep_char != Some(b'=') && sep_char != Some(b':') {
            // KEY らしくない or セパレータ違い → そのまま流す
            out.push_str(key);
            i = key_end;
            continue;
        }
        out.push_str(key);
        out.push(sep_char.unwrap() as char);
        let mut j = key_end + 1;
        // セパレータ後の空白を保持
        while j < bytes.len() && bytes[j] == b' ' {
            out.push(' ');
            j += 1;
        }
        // 値の終端:空白/セミコロン/クオート/バッククォート
        let value_start = j;
        while j < bytes.len() {
            let b = bytes[j];
            if b == b' ' || b == b'\t' || b == b';' || b == b'"' || b == b'\'' || b == b'`' {
                break;
            }
            j += 1;
        }
        let value = &line[value_start..j];
        // env 参照 / URL / 既に伏せ字ならスルー(URL は前段の url masker が
        // credential 部分だけを "***" に置換済み。ここで全体を伏せると host も消える)
        let is_env_ref = value.starts_with("${")
            || value.starts_with("$")
            || value.starts_with("process.env")
            || value.starts_with("import.meta.env")
            || value.contains(MASK)
            || value.contains("***")
            || value.contains("://");
        if value.len() >= 8 && !is_env_ref {
            out.push_str(MASK);
        } else {
            out.push_str(value);
        }
        i = j;
    }
    out
}

const MASK: &str = "*** (伏字) ***";

/// `line[start..]` の位置に scheme(小文字 + 数字 + `+`)+ `://` があれば、scheme 末尾を返す。
fn find_scheme_at(line: &str, start: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut end = start;
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_alphabetic() || (end > start && (b.is_ascii_digit() || b == b'+' || b == b'-' || b == b'.')) {
            end += 1;
        } else {
            break;
        }
    }
    if end == start {
        return None;
    }
    if end + 2 < bytes.len() && bytes[end] == b':' && bytes[end + 1] == b'/' && bytes[end + 2] == b'/' {
        Some(end)
    } else {
        None
    }
}

// ═════════════════════════════════════════════════════════════════════
// /v0.1.7 ローカル LLM 機能ここまで
// ═════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════
// v0.1.10 ファイル監視:選択中フォルダ配下のコード保存を検知して
//   frontend に "folder-changed" イベントを emit する。
//   frontend 側はそれを受けて再スキャンを自動実行する。
//
//   実装:
//     - notify-debouncer-mini で 500ms のデバウンス(保存時の連続イベント吸収)
//     - .git / node_modules / dist / target / build / .DS_Store 等は無視
//     - Debouncer は Mutex に格納して 1 プロジェクト = 1 監視。
//       start_folder_watch を再度呼ぶと古い debouncer が drop されて自動停止
// ═════════════════════════════════════════════════════════════════════

use notify::RecommendedWatcher;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::sync::atomic::{AtomicU64, Ordering};

pub struct WatchState {
    // (watcher_id, Debouncer)。id は「誰が仕掛けたか」の識別。
    // stop は自分の id を指定した時だけクリア → 古い stop が新 watcher を殺す
    // race(Codex 指摘 High #1・#2)を防ぐ。
    debouncer: Mutex<Option<(u64, Debouncer<RecommendedWatcher>)>>,
    next_id: AtomicU64,
}

fn should_ignore_watch_path(path: &Path) -> bool {
    // 除外ディレクトリは is_skippable_dir に一元化(Unity の Library/Temp/Logs も含む)。
    // これが無いと 3GB 級の Library 全体を監視して、Unity のキャッシュ書換えで
    // 大量の folder-changed が発火し続ける。.DS_Store はファイルなので個別に維持。
    path.components().any(|c| {
        let name = c.as_os_str().to_str().unwrap_or("");
        is_skippable_dir(name) || name == ".DS_Store"
    })
}

#[tauri::command]
fn start_folder_watch(
    folder: String,
    app: tauri::AppHandle,
    state: State<'_, WatchState>,
) -> Result<u64, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.exists() {
        return Err(format!("folder does not exist: {}", folder));
    }

    // v0.1.10(Codex 二次指摘 High #1 対応):
    //   自分の id を先に取っておく。install 時点で「もっと新しい start が
    //   既に current に入っていたら install しない」ようにするため。
    //   これで「古い start 完了 → 新 watcher を上書き」の race を防ぐ。
    let new_id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let app_clone = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                // 監視対象外(ビルド生成物・.git 等)しか変わってなければ無視
                let interesting = events
                    .iter()
                    .any(|e| !should_ignore_watch_path(&e.path));
                if interesting {
                    // frontend に通知(payload は不要)
                    let _ = app_clone.emit("folder-changed", ());
                }
            }
        },
    )
    .map_err(|e| format!("failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(&folder_path, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch folder: {}", e))?;

    let mut current = state
        .debouncer
        .lock()
        .map_err(|_| "watch state mutex poisoned".to_string())?;
    // Install ガード:current の id が自分より新しい(=別の start が既に完了して
    // 上書き済み)ときは自分を install しない。自分の debouncer はここで drop → 停止。
    let should_install = current
        .as_ref()
        .map_or(true, |(cur_id, _)| *cur_id < new_id);
    if should_install {
        *current = Some((new_id, debouncer));
    }
    // else: 自分は古い start だった。debouncer を drop して黙って終了。
    // 呼び出し側は new_id を受け取るが、stop_folder_watch(new_id) は id 不一致で no-op。
    Ok(new_id)
}

/// v0.1.10 更新:id を要求する形にして race を防ぐ。
///   - id が現在の watcher と一致 → クリア
///   - 一致しない → 既に別の watcher が上書きしている(自分は「古い stop」)。何もしない。
#[tauri::command]
fn stop_folder_watch(id: u64, state: State<'_, WatchState>) -> Result<(), String> {
    let mut current = state
        .debouncer
        .lock()
        .map_err(|_| "watch state mutex poisoned".to_string())?;
    if let Some((current_id, _)) = current.as_ref() {
        if *current_id == id {
            *current = None;
        }
    }
    Ok(())
}

// Unit tests は scanner_test.rs に切り出し済み(fake secret を含む test 文字列が
// dogfooding 時に content スキャン対象にならないよう、`_test.rs` 命名でスキップさせる)。
#[cfg(test)]
#[path = "scanner_test.rs"]
mod scanner_tests;
mod create_mode;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // v0.1.7: ローカル LLM 用 state(llama-server プロセスの ownership を保持)
        .manage(LlamaState {
            server: Mutex::new(None),
        })
        // v0.1.10:ファイル監視 state(選択中フォルダの Debouncer を 1 個だけ保持)
        .manage(WatchState {
            debouncer: Mutex::new(None),
            next_id: AtomicU64::new(1),
        })
        // 制作モード:プレビュー dev サーバの ownership を保持
        .manage(create_mode::CreateState::default())
        .invoke_handler(tauri::generate_handler![
            claude_check_version,
            claude_analyze,
            list_project_areas,
            node_check_version,
            install_claude_code,
            claude_login,
            // v0.1.7 ローカル LLM commands
            llama_check_binary,
            llama_check_model,
            llama_model_path,
            llama_download_model,
            llama_start_server,
            llama_stop_server,
            llama_analyze,
            // v0.1.8 Q&A(ノード単位のチャット)
            claude_chat,
            llama_chat,
            // v0.1.8 リリース前チェック(ローカル regex スキャン)
            pre_release_scan,
            // v0.1.8 エディタで開く(vscode / cursor URL scheme or system default)
            open_in_editor,
            // v0.1.8 Q&A 精度向上:関連ファイルの実コードを読んで AI に渡す
            read_files_for_qa,
            // v0.1.10 ファイル監視(選択中フォルダの変更検知 → frontend に emit)
            start_folder_watch,
            stop_folder_watch,
            // 制作モード(Phase 1a):プロジェクト作成 + プレビュー
            create_mode::create_project,
            create_mode::start_preview,
            create_mode::stop_preview,
            // 制作モード(Phase 1b):Claude Code でコード生成
            create_mode::generate_app,
            // 制作モード:一覧からプロジェクト削除(フォルダごと)
            create_mode::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
