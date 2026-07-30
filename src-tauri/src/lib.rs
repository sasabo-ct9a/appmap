use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::io::{Read, Write};

use futures_util::StreamExt;
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

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
    let output = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new(&exe)
            .args([
                "-p",
                &user_prompt,
                "--add-dir",
                &folder,
                "--model",
                &model,
                "--output-format",
                "json",
                "--json-schema",
                &schema,
                "--system-prompt",
                &system_prompt,
                "--max-turns",
                "20",
            ])
            .env("PATH", &path_env)
            .output()
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    .map_err(|e| format!("failed to spawn claude: {}", e))?;

    if !output.status.success() {
        // v0.1.7 hotfix:Claude CLI は --output-format json 時にエラーを stdout 側に
        // 出すことがあるため、stderr + stdout 両方を error メッセージに混ぜる。
        // stderr が空でも何が起きたか分かるように。
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "claude failed (code {:?})\nstderr: {}\nstdout (先頭 2000 字): {}",
            output.status.code(),
            if stderr.trim().is_empty() { "(empty)" } else { stderr.trim() },
            if stdout.trim().is_empty() {
                "(empty)".to_string()
            } else {
                stdout.chars().take(2000).collect()
            }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
    let mut out = String::new();
    let mut total: usize = 0;
    // v0.1.7 hotfix(2 回目):bilingual 化で出力が ~14K tokens 必要、
    // 入力との合計を ctx 32K に収めるため入力をさらに削る。
    //   system_prompt ~2K + 出力 14K = 16K
    //   残り 16K を入力(user_prompt + project context)で使える
    //   30KB のテキスト ≈ 10K tokens → system + user で ~12K、余裕 4K
    let max_total: usize = 30 * 1024;
    let max_per_file: usize = 10 * 1024;

    const SKIP_DIRS: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        ".cache",
        "venv",
        ".venv",
        "__pycache__",
        ".idea",
        ".vscode",
    ];
    const INCLUDE_EXTS: &[&str] = &[
        "md", "json", "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb",
        "vue", "svelte", "html", "css", "toml", "yaml", "yml",
    ];

    // 優先読込(プロジェクト構造の理解に効くやつから)
    let priorities: &[&str] = &[
        "README.md",
        "README.markdown",
        "CLAUDE.md",
        "package.json",
        "tsconfig.json",
        "Cargo.toml",
        "src-tauri/Cargo.toml",
        "src/App.tsx",
        "src/main.tsx",
        "src/index.tsx",
        "src/index.ts",
        "src/main.ts",
        "src/App.jsx",
        "src/App.js",
        "main.py",
        "app.py",
    ];

    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    let push_file = |rel: &str, content: &str, total: &mut usize, out: &mut String| -> bool {
        let truncated: String = content.chars().take(max_per_file).collect();
        let header = format!("\n\n<<<<< FILE: {} >>>>>\n", rel);
        let need = header.len() + truncated.len();
        if *total + need > max_total {
            return false;
        }
        out.push_str(&header);
        out.push_str(&truncated);
        *total += need;
        true
    };

    for p in priorities.iter() {
        let file_path = folder.join(p);
        if file_path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&file_path) {
                if !push_file(p, &content, &mut total, &mut out) {
                    return Ok(out);
                }
                visited.insert(file_path);
            }
        }
    }

    // 再帰探索(深さ優先、典型サイズなら数十ファイル止まり)
    fn walk(
        dir: &Path,
        base: &Path,
        out: &mut String,
        total: &mut usize,
        max_total: usize,
        max_per_file: usize,
        skip_dirs: &[&str],
        include_exts: &[&str],
        visited: &mut std::collections::HashSet<PathBuf>,
    ) {
        if *total >= max_total {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if *total >= max_total {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                if skip_dirs.contains(&name.as_str()) {
                    continue;
                }
                walk(
                    &path,
                    base,
                    out,
                    total,
                    max_total,
                    max_per_file,
                    skip_dirs,
                    include_exts,
                    visited,
                );
            } else if path.is_file() && !visited.contains(&path) {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !include_exts.contains(&ext.as_str()) {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let rel = path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let truncated: String = content.chars().take(max_per_file).collect();
                    let header = format!("\n\n<<<<< FILE: {} >>>>>\n", rel);
                    if *total + header.len() + truncated.len() > max_total {
                        return;
                    }
                    out.push_str(&header);
                    out.push_str(&truncated);
                    *total += header.len() + truncated.len();
                    visited.insert(path);
                }
            }
        }
    }

    walk(
        folder,
        folder,
        &mut out,
        &mut total,
        max_total,
        max_per_file,
        SKIP_DIRS,
        INCLUDE_EXTS,
        &mut visited,
    );
    Ok(out)
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
        let content = raw
            .lines()
            .map(mask_snippet)
            .collect::<Vec<_>>()
            .join("\n");
        total_bytes += take;
        out.push(QAFileContent {
            file: rel,
            content,
            truncated,
        });
    }

    Ok(out)
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

    // 分析用と同じディレクトリ / 拡張子フィルタ
    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "dist", "build", ".next",
        ".cache", "venv", ".venv", "__pycache__", ".idea", ".vscode",
    ];
    const INCLUDE_EXTS: &[&str] = &[
        "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb",
        "vue", "svelte", "html", "css", "json", "toml", "yaml", "yml",
        "env", "sh", "ps1",
    ];
    // v0.1.10(Codex 指摘 Medium #6 対応):
    //   - MAX_SCAN_FILES:ソース内容を読む上限(現状値を維持、パフォーマンス保護)
    //   - MAX_WALK_FILES:ファイル名リストの上限(test framework/test file 検出は
    //     名前だけ見るので大きめに)
    //   分離することで monorepo で source が 200 件超えても test framework は
    //   落とさない。
    const MAX_SCAN_FILES: usize = 200;
    const MAX_WALK_FILES: usize = 10_000;

    // シークレット系:プレフィックス or キー名パターン
    // 誤検知を減らすため、代入っぽい表現(= の右側 or : の後)に絞る
    // v0.1.10(Codex 指摘 Medium #5 対応):代表的な token prefix を追加。
    let secret_needles: &[(&str, &str)] = &[
        ("sk-", "openai-like key"),
        ("sk_live_", "stripe live key"),
        ("sk_test_", "stripe test key"),
        ("pk_live_", "stripe publishable live"),
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
    let existing_env_files: Vec<String> = tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<String> = Vec::new();
        collect_env_files(&env_walk_start, &env_walk_start, &mut out, 512);
        out
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;
    let env_files_present = !existing_env_files.is_empty();
    let env_covered_by_gitignore = if !env_files_present {
        // 対象ファイルが無ければ「守るものが無い」→ true 扱いで finding は発火しない
        true
    } else {
        let gi_path = folder_path.join(".gitignore");
        match std::fs::read_to_string(&gi_path) {
            Ok(content) => {
                // Git のルール評価は「上から順、最後に一致したルールが勝ち」。
                // (pattern, is_negation) のタプルで順序保存し、ファイルごとに上から
                // 評価して最後の match 結果を採用する。
                let rules: Vec<(&str, bool)> = content
                    .lines()
                    .filter_map(|line| {
                        let trimmed = line.trim();
                        if trimmed.is_empty() || trimmed.starts_with('#') {
                            return None;
                        }
                        let first = trimmed.split_whitespace().next()?;
                        if let Some(stripped) = first.strip_prefix('!') {
                            Some((stripped, true)) // negation
                        } else {
                            Some((first, false)) // positive
                        }
                    })
                    .collect();
                existing_env_files.iter().all(|rel_path| {
                    // rel_path はプロジェクトルートからの相対パス(例: "apps/web/.env.local")
                    // gitignore パターンは filename マッチ + フルパスマッチの両方を試す
                    let file_name = std::path::Path::new(rel_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(rel_path.as_str());
                    let mut ignored = false;
                    for (pattern, is_negation) in &rules {
                        if gitignore_pattern_matches(pattern, file_name)
                            || gitignore_pattern_matches(pattern, rel_path)
                        {
                            ignored = !is_negation;
                        }
                    }
                    ignored
                })
            }
            Err(_) => false, // .gitignore 自体が無い = カバーしていない
        }
    };

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

    /// 返り値:cap によって「次の候補を処理できなかった」= true。純粋な `len == cap`
    /// ではなく、実際に途中で切ったかで判定するため。
    /// ディレクトリを priority 順に辿ることで、cap 打ち切り時でも重要ディレクトリの
    /// ファイルが収集済みになる(後段の sort ではなく walk 自体を priority-first に)。
    fn walk(
        dir: &Path,
        base: &Path,
        skip_dirs: &[&str],
        include_exts: &[&str],
        files: &mut Vec<PathBuf>,
        max_files: usize,
    ) -> bool {
        if files.len() >= max_files { return true; }
        let Ok(entries) = std::fs::read_dir(dir) else { return false; };
        let mut subdirs: Vec<PathBuf> = Vec::new();
        // まず同ディレクトリ内のファイルを収集(浅いファイルを優先)、subdir は後で priority 順に。
        for entry in entries.flatten() {
            if files.len() >= max_files { return true; }
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !skip_dirs.contains(&name) && !name.starts_with('.') {
                    subdirs.push(path);
                }
            } else if path.is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if include_exts.contains(&ext.as_str()) {
                    if files.len() >= max_files { return true; }
                    files.push(path);
                }
            }
        }
        // subdir を priority 順(0 が先)に辿る
        subdirs.sort_by_key(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            (dir_priority(name), name.to_lowercase())
        });
        for sub in subdirs {
            if files.len() >= max_files { return true; }
            if walk(&sub, base, skip_dirs, include_exts, files, max_files) {
                return true;
            }
        }
        false
    }

    let folder_owned = folder_path.clone();
    let folder_for_sort = folder_path.clone();
    let (file_list, walk_truncated): (Vec<PathBuf>, bool) = tauri::async_runtime::spawn_blocking(move || {
        let mut list = Vec::new();
        let truncated = walk(&folder_owned, &folder_owned, SKIP_DIRS, INCLUDE_EXTS, &mut list, MAX_WALK_FILES);
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
    for path in content_targets {
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        files_scanned += 1;
        let rel = path.strip_prefix(&folder_path).unwrap_or(&path)
            .to_string_lossy().replace('\\', "/");
        // 拡張子は secret 変数検出の「: を区切り子として受け入れるか」の判定に使う。
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

        for (line_idx, raw_line) in content.lines().enumerate() {
            let line_num = line_idx + 1;
            let trimmed = raw_line.trim();
            if trimmed.is_empty() { continue; }
            // コメント風の行は誤検知が多いので TODO のみ抽出、シークレットは非コメントで判定
            let is_commentish = trimmed.starts_with("//") || trimmed.starts_with('#')
                || trimmed.starts_with('*') || trimmed.starts_with("<!--");

            // 同一行の重複検出を防ぐフラグ。prefix 検出と変数名検出が同じ行を拾って
            // 2 回 push するのを避ける(件数水増しと修正プロンプトのノイズを防ぐ)。
            let mut line_secret_recorded = false;

            // 1) シークレットのプレフィックス(自身のパターン定義や説明文を弾く強化版)
            if !is_commentish {
                for (needle, kind) in secret_needles {
                    if raw_line.contains(needle) && is_plausible_secret_hit(raw_line, needle) {
                        secrets.push(ScanHit {
                            file: rel.clone(),
                            line: line_num,
                            snippet: mask_snippet(raw_line),
                            kind: kind.to_string(),
                        });
                        line_secret_recorded = true;
                        break;
                    }
                }
            }

            // 2) 変数名 = 値 パターン(quoted / bare 両方)。
            //   LHS 側の識別子を separator(`=` / config 系のみ `:`)ごとに切り出し、
            //   `is_secret_variable_name` で「明らかに secret っぽいキー名」かを判定する。
            //   env 参照 / 空 / template 変数 / 明らかに短い値 は除外。
            //   prefix 検出で既に同じ行が記録済みなら重複させない(重複 push 回避)。
            if !is_commentish && !line_secret_recorded {
                let colon_ok = matches!(
                    ext.as_str(),
                    "env" | "yaml" | "yml" | "toml" | "json" | "ini" | "properties"
                );
                // 全 separator 位置を集める。1 行複数 assignment(minified JSON など)対応。
                let sep_positions: Vec<usize> = raw_line
                    .char_indices()
                    .filter_map(|(i, c)| {
                        if c == '=' || (colon_ok && c == ':') { Some(i) } else { None }
                    })
                    .collect();
                'sep_loop: for sep_pos in sep_positions {
                    // LHS 切り出し:separator の直前から identifier chars を後ろ向きに拾う。
                    let before = &raw_line[..sep_pos];
                    let before_trimmed = before.trim_end();
                    // JSON key 形式 `"apiKey":` の閉じ quote を除去
                    let key_body = before_trimmed
                        .strip_suffix('"')
                        .or_else(|| before_trimmed.strip_suffix('\''))
                        .unwrap_or(before_trimmed);
                    // identifier chars(英数字 + _-)を末尾から取る
                    let lhs_start = key_body
                        .rfind(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    let lhs = &key_body[lhs_start..];
                    if lhs.is_empty() { continue; }
                    if !is_secret_variable_name(lhs) { continue; }

                    // RHS 評価:env 参照除外、長さ 16+ を要求
                    let after = &raw_line[sep_pos + 1..];
                    let rest = after.trim_start();
                    if rest.is_empty()
                        || rest.starts_with("process.env")
                        || rest.starts_with("env.")
                        || rest.starts_with("import.meta.env")
                        || rest.starts_with("Deno.env")
                        || rest.starts_with("System.getenv")
                        || rest.starts_with("${")
                        || rest.starts_with('$')
                    {
                        continue;
                    }
                    let inner_len = if rest.starts_with('"') || rest.starts_with('\'') {
                        let quote_char = rest.chars().next().unwrap();
                        rest[1..].chars().take_while(|c| *c != quote_char).count()
                    } else if colon_ok {
                        // config 系:空白 / セミコロン / コメント / 構造区切りだけで止める
                        rest.chars()
                            .take_while(|c| {
                                !c.is_whitespace()
                                    && !matches!(c, '#' | ';' | '`' | ',' | ']' | '}' | ')')
                            })
                            .count()
                    } else {
                        // code 系:secret っぽい文字集合のみ算入(method chain 等で即打ち切り)
                        rest.chars()
                            .take_while(|c| {
                                c.is_ascii_alphanumeric()
                                    || matches!(c, '-' | '_' | '/' | '+' | '=' | '@' | '~')
                            })
                            .count()
                    };
                    if inner_len >= 16 {
                        secrets.push(ScanHit {
                            file: rel.clone(),
                            line: line_num,
                            snippet: mask_snippet(raw_line),
                            kind: format!("hardcoded {}", lhs),
                        });
                        break 'sep_loop;
                    }
                }
            }

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

    // pattern からディレクトリ候補を展開
    let mut result: Vec<(PathBuf, String)> = Vec::new();
    let list_dirs = |base: &Path| -> Vec<(PathBuf, String)> {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !name.starts_with('.') && name != "node_modules" {
                        out.push((p.clone(), name.to_string()));
                    }
                }
            }
        }
        out
    };

    for (pattern, is_neg) in &patterns {
        if *is_neg { continue; } // negation は後段で filter
        let pat = pattern.trim_end_matches('/');
        if let Some(prefix) = pat.strip_suffix("/*") {
            // 1 階層展開
            let base = project_root.join(prefix);
            for (dir, name) in list_dirs(&base) {
                result.push((dir, format!("{}/{}", prefix, name)));
            }
        } else if let Some(prefix) = pat.strip_suffix("/**").or_else(|| pat.strip_suffix("/*/*")) {
            // 2 階層まで展開(3 階層以上は打ち切り)
            let base = project_root.join(prefix);
            for (dir1, name1) in list_dirs(&base) {
                result.push((dir1.clone(), format!("{}/{}", prefix, name1)));
                for (dir2, name2) in list_dirs(&dir1) {
                    result.push((dir2, format!("{}/{}/{}", prefix, name1, name2)));
                }
            }
        } else {
            // 固定パス
            let dir = project_root.join(pat);
            if dir.is_dir() {
                result.push((dir, pat.to_string()));
            }
        }
    }

    // negation pattern に一致する候補を除外
    let negations: Vec<&str> = patterns.iter().filter(|(_, n)| *n).map(|(p, _)| p.as_str()).collect();
    if !negations.is_empty() {
        result.retain(|(_, rel)| {
            !negations.iter().any(|n| workspace_glob_matches(n, rel))
        });
    }

    result
}

/// 指定ディレクトリ直下の manifest を全 6 種類チェックして manifests に push する。
///   Node / Rust / Python / Go / Ruby / PHP を root / subdir で同じルールで扱う。
///   `rel_prefix` は project root からの相対パス接頭辞("" for root、"apps/web" for subdir)。
fn collect_manifests_at(dir: &Path, project_root: &Path, rel_prefix: &str, out: &mut Vec<ManifestInfo>) {
    let has = |p: &str| dir.join(p).exists();
    let prefix = if rel_prefix.is_empty() { String::new() } else { format!("{}/", rel_prefix) };

    if has("package.json") {
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
            (
                has_key("build"),
                has_key("test"),
                has_key("typecheck") || has_key("type-check") || has_key("tsc"),
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
    if pat == path { return true; }
    // `apps/*` → `apps/xxx` にマッチ(1 階層)
    if let Some(prefix) = pat.strip_suffix("/*") {
        return path.starts_with(&format!("{}/", prefix))
            && !path[prefix.len() + 1..].contains('/');
    }
    // `apps/**` → `apps/xxx/yyy/...` にもマッチ
    if let Some(prefix) = pat.strip_suffix("/**") {
        return path.starts_with(&format!("{}/", prefix));
    }
    false
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
        _ => false,
    }
}

/// 変数名(LHS)が「secret を保持していそうな名前」かを判定する。
///
///   Positive:  key / secret / token / password / pwd / credential / webhook / dsn
///              / authorization / _auth / auth_
///   Allowlist: hint / example / sample / placeholder / mock / dummy / default
///              / expiry / expires / ttl / less(passwordless)/ chain(keychain)
///              / board(keyboard)/ word(keyword)/ path / prefix / suffix
///              / _name / _type / _id / readme
///
/// 判定は 2 段:allowlist substring がひとつでも含まれれば非 secret 扱い。
/// これで `API_KEY_HINT` / `PASSWORDLESS` / `KEYBOARD_LAYOUT` / `KEY_ID` は落ちる。
/// その後 positive substring があれば secret 扱い。SUPABASE_SERVICE_ROLE_KEY /
/// OPENAI_API_KEY / NEXTAUTH_SECRET / STRIPE_WEBHOOK_SIGNING_SECRET 等は拾える。
fn is_secret_variable_name(lhs: &str) -> bool {
    let lower = lhs.to_lowercase();
    // 注意:substring マッチなので、secret 系語("password" 等)を巻き込まない語を選ぶ。
    //   例:`word` は `password` にヒットしてしまうので使わず、`keyword` を明示する。
    const SAFE_MARKERS: &[&str] = &[
        "hint", "example", "sample", "placeholder", "mock", "dummy", "default",
        "expiry", "expires", "ttl", "less", "keychain", "keyboard", "keyword",
        "path", "prefix", "suffix", "_name", "_type", "_id", "readme", "label",
    ];
    for m in SAFE_MARKERS {
        if lower.contains(m) {
            return false;
        }
    }
    const SECRET_MARKERS: &[&str] = &[
        "key", "secret", "token", "password", "pwd", "credential", "webhook",
        "dsn", "auth_", "_auth", "authorization",
    ];
    for m in SECRET_MARKERS {
        if lower.contains(m) {
            return true;
        }
    }
    false
}

/// プロジェクト内の `.env*` ファイルを再帰的に収集する。
///   - `.env.example` `.env.sample` `.env.template` は意図的に共有される非秘密なので除外
///   - node_modules / .git / target / dist / build 等はスキップ
///   - out には base からの相対パス(POSIX 区切り)を入れる
fn collect_env_files(dir: &Path, base: &Path, out: &mut Vec<String>, max: usize) {
    if out.len() >= max { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        if out.len() >= max { return; }
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let skip = matches!(
                name,
                "node_modules" | ".git" | "target" | "dist" | "build"
                    | ".next" | ".turbo" | ".vite" | ".cache" | ".idea" | ".vscode"
                    | "venv" | ".venv" | "__pycache__"
            );
            if !skip {
                collect_env_files(&path, base, out, max);
            }
        } else if path.is_file() {
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
}

/// .gitignore のパターン 1 行が、指定のファイル名にマッチするかを判定する(最小 glob 実装)。
///
/// サポート:
///   - `*` ワイルドカード(任意文字列にマッチ、`/` も含む・シンプル)
///   - 先頭 `/` 除去(root-relative パターン扱い)
///   - 先頭 `**/` 除去(サブディレクトリ再帰、file 名判定なので実質同義)
///   - 末尾 `/` 除去(ディレクトリ指定は今回無視)
/// 制限:
///   - `?` は非対応(実運用でほぼ使われない)
///   - `[abc]` クラスは非対応
///   - 否定ルール `!` は呼び出し側で事前に除外している前提
fn gitignore_pattern_matches(pattern: &str, filename: &str) -> bool {
    let mut p = pattern;
    p = p.strip_prefix('/').unwrap_or(p);
    p = p.strip_prefix("**/").unwrap_or(p);
    p = p.strip_suffix('/').unwrap_or(p);

    if p == filename {
        return true;
    }
    // `*` を含まないなら完全一致以外はマッチしない
    if !p.contains('*') {
        return false;
    }

    // `*` で分割して順序どおり出現するか確認
    let parts: Vec<&str> = p.split('*').collect();
    let mut pos = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            // 連続 * / 先頭 * / 末尾 * のダミー要素はスキップ
            continue;
        }
        if i == 0 {
            // 最初の非空 part は先頭マッチ
            if !filename[pos..].starts_with(part) {
                return false;
            }
            pos += part.len();
        } else if i == parts.len() - 1 {
            // 最後の非空 part は末尾マッチ(pos 以降が part で終わるか)
            if !filename[pos..].ends_with(part) {
                return false;
            }
        } else {
            // 中間 part は pos 以降のどこかに出現
            match filename[pos..].find(part) {
                Some(idx) => pos += idx + part.len(),
                None => return false,
            }
        }
    }
    true
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
fn is_plausible_secret_hit(line: &str, prefix: &str) -> bool {
    let Some(prefix_start) = line.find(prefix) else { return false };
    let prefix_end = prefix_start + prefix.len();
    let bytes = line.as_bytes();

    // ルール 1:短い引用符囲みは棄却
    if prefix_start > 0 {
        let quote = bytes[prefix_start - 1];
        if quote == b'"' || quote == b'\'' {
            let tail = &line[prefix_end..];
            let mut chars = tail.char_indices();
            let mut closed_within = None;
            for (i, c) in &mut chars {
                if c as u8 == quote {
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
            // 直後は空白 0〜複数を許容してから `(` を要求
            let after_target = idx + target_len;
            let rest = &line[after_target..];
            let stripped = rest.trim_start();
            let paren_ok = stripped.starts_with('(');
            if paren_ok && !is_inside_string_literal(line, idx) {
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
fn mask_snippet(line: &str) -> String {
    let quoted_masked = mask_quoted_values(line);
    let url_masked = mask_url_credentials(&quoted_masked);
    let bare_masked = mask_bare_assignments(&url_masked);
    bare_masked.chars().take(200).collect()
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
    path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(".git")
                | Some("node_modules")
                | Some("dist")
                | Some("target")
                | Some("build")
                | Some(".next")
                | Some(".turbo")
                | Some(".vite")
                | Some(".DS_Store")
                | Some(".idea")
                | Some(".vscode")
        )
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
        .invoke_handler(tauri::generate_handler![
            claude_check_version,
            claude_analyze,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
