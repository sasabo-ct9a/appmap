// 制作モード(Create Mode)の Rust 側。Phase 1a:
//   - create_project: 同梱テンプレ(React+Vite)を workspace に書き出す
//   - start_preview:  workspace で dev サーバを起こし、プレビュー用ポートを返す(長寿命の子プロセス)
//   - stop_preview:   dev サーバを止める
//
// 長寿命プロセスの管理は LlamaState と同じ流儀(state に Child を持つ)。プレビューは
// localhost の dev サーバを frontend の iframe に映すだけ(tauri.conf.json の CSP は null=素通し)。

use std::fs;
use std::path::{Path, PathBuf};
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
        "tsconfig.json",
        include_str!("../templates/react-vite/tsconfig.json"),
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
    (
        "src/lib/supabase.ts",
        include_str!("../templates/react-vite/src/lib/supabase.ts"),
    ),
    (
        "src/vite-env.d.ts",
        include_str!("../templates/react-vite/src/vite-env.d.ts"),
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

/// workspace で git を実行する(user.name/email はコマンド単位で与え、グローバル設定に依存しない)。
fn run_git(ws: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    let path_env = crate::augmented_path();
    StdCommand::new("git")
        .arg("-C")
        .arg(ws)
        .args(["-c", "user.name=AppMap", "-c", "user.email=appmap@local"])
        .args(args)
        .env("PATH", &path_env)
        .stdin(Stdio::null())
        .output()
}

/// workspace が git チェックポイント管理下(.git 有り)か。
fn has_git(ws: &Path) -> bool {
    ws.join(".git").exists()
}

/// HEAD のコミット数(履歴無し=0)。「戻せる世代数」の計算に使う。
fn commit_count(ws: &Path) -> i64 {
    match run_git(ws, &["rev-list", "--count", "HEAD"]) {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0)
        }
        _ => 0,
    }
}

/// 生成のたびに現在の状態を1コミット(=世代の節目)。git 未導入なら黙って no-op(グレースフル)。
/// 初回は git init + .gitignore(node_modules / .env / dist を除外)も用意する。
fn checkpoint(ws: &Path, message: &str) {
    if !has_git(ws) {
        let inited = run_git(ws, &["init"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !inited {
            return; // git が無い環境:チェックポイント機能はあきらめる。
        }
        let _ = fs::write(ws.join(".gitignore"), "node_modules\ndist\n.env\n.env.*\n");
    }
    let _ = run_git(ws, &["add", "-A"]);
    let _ = run_git(ws, &["commit", "-m", message]); // 変更無しの commit 失敗は無視。
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
    // 元に戻す機能の土台:初期状態を git チェックポイントに(git 未導入なら no-op)。
    checkpoint(&ws, "初期テンプレート");
    Ok(ws.to_string_lossy().to_string())
}

/// 管理下のプロジェクトフォルダを削除する(一覧からの削除で使う)。
/// resolve_managed_workspace で projects ディレクトリ内であることを検証してから消す(§7.1:境界を信用しない)。
#[tauri::command]
pub fn delete_project(app: tauri::AppHandle, workspace: String) -> Result<(), String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    fs::remove_dir_all(&ws).map_err(|e| format!("failed to delete project: {}", e))?;
    Ok(())
}

/// プロジェクトの .env に Supabase 接続情報(URL / anon key)を書く。
/// 秘密はコードに直書きせず env に置く(§6.5)。書いたら preview を再起動して反映する。
#[tauri::command]
pub fn set_supabase_env(
    app: tauri::AppHandle,
    workspace: String,
    url: String,
    anon_key: String,
) -> Result<(), String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    let path = ws.join(".env");
    // 既存の .env を読み、Supabase の2行だけ差し替える(他の変数は残す。Codex P2)。
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut has_url = false;
    let mut has_key = false;
    for line in existing.lines() {
        if line.starts_with("VITE_SUPABASE_URL=") {
            lines.push(format!("VITE_SUPABASE_URL={}", url.trim()));
            has_url = true;
        } else if line.starts_with("VITE_SUPABASE_ANON_KEY=") {
            lines.push(format!("VITE_SUPABASE_ANON_KEY={}", anon_key.trim()));
            has_key = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !has_url {
        lines.push(format!("VITE_SUPABASE_URL={}", url.trim()));
    }
    if !has_key {
        lines.push(format!("VITE_SUPABASE_ANON_KEY={}", anon_key.trim()));
    }
    let mut content = lines.join("\n");
    content.push('\n');
    fs::write(&path, content).map_err(|e| format!("failed to write .env: {}", e))?;
    Ok(())
}

/// プロジェクトの .env から Supabase 接続情報を読む(接続欄の復元用)。無ければ空。
#[tauri::command]
pub fn get_supabase_env(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<(String, String), String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    let text = match fs::read_to_string(ws.join(".env")) {
        Ok(t) => t,
        Err(_) => return Ok((String::new(), String::new())),
    };
    let mut url = String::new();
    let mut key = String::new();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("VITE_SUPABASE_URL=") {
            url = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("VITE_SUPABASE_ANON_KEY=") {
            key = v.trim().to_string();
        }
    }
    Ok((url, key))
}

/// 既存プロジェクトを本番構成(Supabase)に追いつかせる(Codex P1)。
/// 旧テンプレで作ったプロジェクトは supabase.ts / 依存が無いので、生成前に補う。
/// 何か補ったら true(呼び出し側で preview を再起動させる)。
#[tauri::command]
pub async fn ensure_supabase_ready(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<bool, String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    let mut changed = false;

    // 不足しているテンプレファイル(supabase.ts / vite-env.d.ts など)を補う(既存は触らない)。
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
        changed = true;
    }

    // @supabase/supabase-js が未インストールなら入れる(package.json にも追記される)。
    let installed = ws
        .join("node_modules")
        .join("@supabase")
        .join("supabase-js")
        .exists();
    if !installed {
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let path_env = crate::augmented_path();
        let ws2 = ws.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            StdCommand::new(npm)
                .args(["install", "@supabase/supabase-js@2"])
                .current_dir(&ws2)
                .env("PATH", &path_env)
                .output()
        })
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| format!("failed to spawn npm install: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "npm install @supabase/supabase-js failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        changed = true;
    }

    Ok(changed)
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
    prompt: String,
) -> Result<String, String> {
    // prompt は TS 側(createPrompt.ts)で本番基礎込みに組み立てて渡す(§7.1)。
    // ここは受け取った prompt をそのまま claude に流すだけ。
    let ws = resolve_managed_workspace(&app, &workspace)?;
    let exe = crate::find_claude_exe()?;
    let path_env = crate::augmented_path();

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
            // claude -p は stdin も待つため、パイプが無いと約3秒ブロックする。
            // 生成では stdin を渡さないので null に繋いで即時実行させる。
            .stdin(Stdio::null())
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
    // 生成が成功したら、その状態を git チェックポイントに(「元に戻す」の節目)。
    checkpoint(&ws, "生成");
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 直前の生成を取り消し、1つ前のチェックポイントへ戻す。戻したあとの「戻せる世代数」を返す。
#[tauri::command]
pub fn undo_generation(app: tauri::AppHandle, workspace: String) -> Result<i64, String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    if !has_git(&ws) {
        return Err("この構成では元に戻せません(履歴がありません)".to_string());
    }
    if commit_count(&ws) <= 1 {
        return Err("これ以上は戻せません(最初の状態です)".to_string());
    }
    let out = run_git(&ws, &["reset", "--hard", "HEAD~1"])
        .map_err(|e| format!("git reset failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "元に戻せませんでした: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok((commit_count(&ws) - 1).max(0))
}

/// 戻せる世代数(=コミット数-1)。git 未導入・履歴無しは -1(ボタンを隠す用)。
#[tauri::command]
pub fn undo_available(app: tauri::AppHandle, workspace: String) -> Result<i64, String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    if !has_git(&ws) {
        return Ok(-1);
    }
    Ok((commit_count(&ws) - 1).max(0))
}

/// 生成物の現在のコード revision(git HEAD の短い sha)。解析結果キャッシュの有効判定に使う。
/// 生成・元に戻すのたびに HEAD が動くので、これが同じ = コードが変わっていない、と判定できる。
/// git 未導入・履歴無しは空文字(= キャッシュ無効、毎回解析)。
#[tauri::command]
pub fn workspace_revision(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    let ws = resolve_managed_workspace(&app, &workspace)?;
    if !has_git(&ws) {
        return Ok(String::new());
    }
    match run_git(&ws, &["rev-parse", "--short", "HEAD"]) {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => Ok(String::new()),
    }
}

/// 汎用の Claude 問い合わせ(ファイル編集なし・答えのテキストをそのまま返す)。
/// 意図↔実体の対応付けなど「短い質問→短い答え」に使う。generate_app と違い acceptEdits を付けない。
#[tauri::command]
pub async fn claude_ask(prompt: String) -> Result<String, String> {
    let exe = crate::find_claude_exe()?;
    let path_env = crate::augmented_path();
    let out = tauri::async_runtime::spawn_blocking(move || {
        StdCommand::new(&exe)
            .args(["-p", &prompt, "--model", "sonnet"])
            .env("PATH", &path_env)
            .stdin(Stdio::null())
            .output()
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    .map_err(|e| format!("failed to spawn claude: {}", e))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("claude failed: {} {}", stdout.trim(), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
