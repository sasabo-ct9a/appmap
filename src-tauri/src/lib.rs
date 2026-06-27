use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::io::Read;

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
        let mut child = StdCommand::new(&exe)
            .arg("login")
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
        // v0.1.7 hotfix(2 回目):詳細レベル化で 8-15 ノード × bilingual を 1 回で吐く。
        // 旧 14000 では足りないため 20000 に拡張。
        // 入力 ~12K + 出力 20K = 32K で ctx 枠ギリギリ(margin 0、要観察)。
        "max_tokens": 20000
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

// ═════════════════════════════════════════════════════════════════════
// /v0.1.7 ローカル LLM 機能ここまで
// ═════════════════════════════════════════════════════════════════════

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
