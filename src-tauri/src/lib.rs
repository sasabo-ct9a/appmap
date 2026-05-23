use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use std::io::Read;

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
        return Err(format!(
            "claude failed (code {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            claude_check_version,
            claude_analyze,
            node_check_version,
            install_claude_code,
            claude_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
