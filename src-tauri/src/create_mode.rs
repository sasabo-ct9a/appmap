// 制作モード(Create Mode)の Rust 側。Phase 1a:
//   - create_project: 同梱テンプレ(React+Vite)を workspace に書き出す
//   - start_preview:  workspace で dev サーバを起こし、プレビュー用ポートを返す(長寿命の子プロセス)
//   - stop_preview:   dev サーバを止める
//
// 長寿命プロセスの管理は LlamaState と同じ流儀(state に Child を持つ)。プレビューは
// localhost の dev サーバを frontend の iframe に映すだけ(tauri.conf.json の CSP は null=素通し)。

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// 制作モードのプレビュー dev サーバを保持する app state。
#[derive(Default)]
pub struct CreateState {
    server: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

// アプリ終了時に preview の子プロセスを確実に殺す(Codex P1)。stop_preview が呼ばれずに
// AppMap が閉じられても、npm/vite がオーファンで 5199 を掴んだまま残らないように。
impl Drop for CreateState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.server.lock() {
            if let Some(mut child) = guard.take() {
                kill_child(&mut child);
            }
        }
    }
}

/// Phase 1:プレビューは 1 プロジェクトずつ、固定ポート。テンプレの vite.config と一致させる。
const PREVIEW_PORT: u16 = 5199;

/// dev サーバの子プロセスを確実に落とす。
///
/// Windows では `npm run dev` は npm.cmd → node(vite)という親子で、child.kill() は
/// npm.cmd しか殺さず、孫の vite がオーファンとしてポートを掴んだまま残る。
/// taskkill /T でプロセスツリーごと落とす。
fn kill_child(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 指定ポートを LISTEN しているプロセスを落とす(オーファン掃除用・ベストエフォート)。
/// dev restart やアプリ異常終了で残った「自分の前回 vite」を掃除するのに使う。
fn kill_process_on_port(port: u16) {
    #[cfg(windows)]
    {
        if let Ok(out) = StdCommand::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{}", port)])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.to_uppercase().contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        let _ = StdCommand::new("taskkill")
                            .args(["/F", "/PID", pid])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = StdCommand::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output()
        {
            for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
                let _ = StdCommand::new("kill").args(["-9", pid]).status();
            }
        }
    }
}

/// 同梱テンプレ(空の React + Vite)。作成時に workspace へ書き出す。
const TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../templates/react-vite/package.json"),
    ),
    (
        "vite.config.js",
        include_str!("../templates/react-vite/vite.config.js"),
    ),
    (
        "index.html",
        include_str!("../templates/react-vite/index.html"),
    ),
    (
        "src/main.tsx",
        include_str!("../templates/react-vite/src/main.tsx"),
    ),
    (
        "src/App.tsx",
        include_str!("../templates/react-vite/src/App.tsx"),
    ),
];

/// `<app_data_dir>/projects/` を返す(無ければ作る)。
fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {}", e))?;
    let dir = base.join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("create projects dir failed: {}", e))?;
    Ok(dir)
}

/// フォルダ名として安全な文字列に(英数・-・_ 以外は _)。空なら "app"。
fn sanitize_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "app".to_string()
    } else {
        s
    }
}

/// frontend から渡された workspace パスが AppMap 管理下の projects 内かを検証する。
/// claude/npm を編集許可で走らせる前に必ず通す(§7.1:境界を信用しない。Codex P1)。
fn resolve_managed_workspace(
    app: &tauri::AppHandle,
    workspace: &str,
) -> Result<PathBuf, String> {
    let base = projects_dir(app)?
        .canonicalize()
        .map_err(|e| format!("projects dir canonicalize failed: {}", e))?;
    let ws = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace path: {}", e))?;
    if !ws.starts_with(&base) {
        return Err("workspace is outside the managed projects directory".to_string());
    }
    if !ws.join("package.json").exists() {
        return Err(format!("workspace not found: {}", ws.display()));
    }
    Ok(ws)
}

/// テンプレを複製して workspace を用意する。既にあるファイルは上書きしない
/// (生成済みのコードを潰さないため)。workspace の絶対パスを返す。
#[tauri::command]
pub fn create_project(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let ws = projects_dir(&app)?.join(sanitize_name(&name));
    fs::create_dir_all(&ws).map_err(|e| format!("create workspace failed: {}", e))?;
    for (rel, contents) in TEMPLATE_FILES {
        let path = ws.join(rel);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        fs::write(&path, contents).map_err(|e| format!("write {}: {}", path.display(), e))?;
    }
    Ok(ws.to_string_lossy().to_string())
}

/// workspace で dev サーバを起こし、プレビュー用ポートを返す。
/// - node_modules が無ければ npm install(初回のみ・遅い)
/// - npm run dev を長寿命の子プロセスとして起動し、ポートが応答するまで待つ
#[tauri::command]
pub async fn start_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, CreateState>,
    workspace: String,
) -> Result<u16, String> {
    // 既に起動中なら再利用(MutexGuard は await をまたがせない)
    {
        let running = state.server.lock().unwrap().is_some();
        if running {
            let port = state.port.lock().unwrap().unwrap_or(PREVIEW_PORT);
            return Ok(port);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
        .map_err(|e| format!("http client error: {}", e))?;
    let url = format!("http://127.0.0.1:{}/", PREVIEW_PORT);

    // 管理下の workspace か検証してから使う(Codex P1)。
    let ws = resolve_managed_workspace(&app, &workspace)?;

    // spawn 前にポートを確認(Codex P2)。自分の tracked preview は上の early return 済みなので、
    // ここで 200 が返るのは「前回セッションの自分のオーファン」か「別プロセス」。応答本文に
    // テンプレの目印があれば自分のオーファンと判断して掃除、無ければ他人なので触らずエラー。
    if let Ok(r) = client.get(&url).send().await {
        if r.status().is_success() {
            let body = r.text().await.unwrap_or_default();
            let looks_ours =
                body.contains("AppMap Project") || body.contains("/src/main.tsx");
            if looks_ours {
                kill_process_on_port(PREVIEW_PORT);
                tokio::time::sleep(Duration::from_millis(600)).await;
            } else {
                return Err(
                    "プレビュー用ポート 5199 が別のプロセスに使われています。そのプロセスを閉じてから、もう一度お試しください。"
                        .to_string(),
                );
            }
        }
    }

    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let path_env = crate::augmented_path();

    // 初回のみ npm install(遅いので spawn_blocking で UI を止めない)
    if !ws.join("node_modules").exists() {
        let ws2 = ws.clone();
        let path2 = path_env.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            StdCommand::new(npm)
                .arg("install")
                .current_dir(&ws2)
                .env("PATH", &path2)
                .output()
        })
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| format!("failed to spawn npm install: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "npm install failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    // npm run dev(長寿命)
    let child = StdCommand::new(npm)
        .args(["run", "dev"])
        .current_dir(&ws)
        .env("PATH", &path_env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn npm run dev: {}", e))?;
    *state.server.lock().unwrap() = Some(child);

    // ポートが応答するまで待つ
    let start = Instant::now();
    let timeout = Duration::from_secs(60);
    let mut ready = false;
    while start.elapsed() < timeout {
        // 自分が spawn した子(vite)が死んでいたら、他プロセスの 200 を採用しない(Codex P2)。
        {
            let mut guard = state.server.lock().unwrap();
            match guard.as_mut() {
                Some(child) => {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        guard.take();
                        return Err(
                            "プレビューの起動に失敗しました(ポート 5199 が使用中の可能性があります)。"
                                .to_string(),
                        );
                    }
                }
                None => break,
            }
        }
        if let Ok(r) = client.get(&url).send().await {
            if r.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    if !ready {
        if let Some(mut c) = state.server.lock().unwrap().take() {
            kill_child(&mut c);
        }
        return Err("preview dev server did not become ready in 60s".to_string());
    }

    *state.port.lock().unwrap() = Some(PREVIEW_PORT);
    Ok(PREVIEW_PORT)
}

/// dev サーバを停止する。
#[tauri::command]
pub fn stop_preview(state: tauri::State<'_, CreateState>) -> Result<(), String> {
    if let Some(mut child) = state.server.lock().unwrap().take() {
        kill_child(&mut child);
    }
    *state.port.lock().unwrap() = None;
    Ok(())
}

/// workspace で Claude Code を編集モードで走らせ、要望どおりにコードを書き換える。
///
/// スパイクで実証した呼び出し方:cwd=workspace、-p(非対話)、--permission-mode acceptEdits
/// (ファイル編集を自動承認)。編集は dev サーバの HMR で即プレビューに反映される。
/// 生成は Claude 専用(ローカル LLM は agentic なファイル編集ができない)。
#[tauri::command]
pub async fn generate_app(
    app: tauri::AppHandle,
    workspace: String,
    instruction: String,
) -> Result<String, String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    let exe = crate::find_claude_exe()?;
    let path_env = crate::augmented_path();
    let prompt = format!(
        "この Vite + React アプリを、次の要望に沿って作ってください:「{}」。\
         src/App.tsx を中心に実装し、日本語 UI、シンプルで見やすいインラインスタイルに。\
         React の useState だけで動く範囲で作る。Vite+React の構成は変えない。\
         npm パッケージは追加しない。",
        instruction
    );

    let ws2 = ws.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new(&exe)
            .args([
                "-p",
                &prompt,
                "--permission-mode",
                "acceptEdits",
                "--model",
                "sonnet",
            ])
            .current_dir(&ws2)
            .env("PATH", &path_env)
            .output()
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    .map_err(|e| format!("failed to spawn claude: {}", e))?;

    if !out.status.success() {
        // claude は認証切れ(401)・レート制限などを stdout に出すことがあるので両方拾う。
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = format!("{} {}", stdout.trim(), stderr.trim());
        return Err(format!("claude failed: {}", detail.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
