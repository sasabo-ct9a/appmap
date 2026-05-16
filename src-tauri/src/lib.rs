use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use std::io::Read;

/// Find the actual claude.exe (or claude on Unix) by:
/// 1. Locating the `claude` shim in PATH via `where`/`which`
/// 2. Deriving the binary path from the shim's directory
///
/// This avoids invoking `.cmd` files directly (which Rust's process::Command
/// rejects on Windows due to CVE-2024-24576 mitigation when given complex args).
fn find_claude_exe() -> Result<PathBuf, String> {
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };

    let output = StdCommand::new(lookup_cmd)
        .arg("claude")
        .output()
        .map_err(|e| format!("failed to run {}: {}", lookup_cmd, e))?;

    if !output.status.success() {
        return Err(format!(
            "claude not found in PATH (run `{}` returned non-zero)",
            lookup_cmd
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout
        .lines()
        .map(|s| s.trim())
        .filter(|l| !l.is_empty())
        .collect();

    // Pick the npm shim path. On Windows `where` returns multiple lines (one
    // per extension). Prefer the .cmd shim — its parent dir holds node_modules.
    let shim = if cfg!(windows) {
        lines
            .iter()
            .find(|l| l.to_lowercase().ends_with(".cmd"))
            .copied()
            .or_else(|| lines.first().copied())
    } else {
        lines.first().copied()
    }
    .ok_or_else(|| "no claude shim found".to_string())?;

    let shim_path = PathBuf::from(shim);
    let shim_dir = shim_path
        .parent()
        .ok_or_else(|| "shim has no parent directory".to_string())?;

    // The actual binary is at: <shim_dir>/node_modules/@anthropic-ai/claude-code/bin/claude(.exe)
    let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
    let exe_path = shim_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("bin")
        .join(exe_name);

    if exe_path.exists() {
        Ok(exe_path)
    } else {
        Err(format!(
            "claude binary not found at expected location: {}",
            exe_path.display()
        ))
    }
}

#[tauri::command]
fn claude_check_version() -> Result<String, String> {
    let exe = find_claude_exe()?;
    let output = StdCommand::new(&exe)
        .arg("--version")
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
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };
    let where_output = StdCommand::new(lookup_cmd)
        .arg("node")
        .output()
        .map_err(|e| format!("failed to run {}: {}", lookup_cmd, e))?;

    if !where_output.status.success() {
        return Err("node not found in PATH".to_string());
    }

    let output = StdCommand::new("node")
        .arg("--version")
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

    let output = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new(npm_cmd)
            .args(["install", "-g", "@anthropic-ai/claude-code"])
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

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut child = StdCommand::new(&exe)
            .arg("login")
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
