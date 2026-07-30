//! Scanner helper のユニットテスト。
//!
//! ファイル名が `_test.rs` で終わることで、AppMap 自身のコードチェックの
//! `is_test_file_path` が「テスト fixture」と判定し、内部に含まれる fake secret /
//! fake TODO / console.log を content スキャンから除外できる。
//!
//! (production コード側の lib.rs から `#[path = "scanner_test.rs"]` で読み込まれる。)

use super::*;

// ─── is_secret_variable_name(R12-#2 複合 env 名検出)──────────────
#[test]
fn secret_var_name_composite_env_names() {
    // 実運用で普通に出る複合名を検出できること(前回の境界チェックで落ちていた回帰)
    assert!(is_secret_variable_name("SUPABASE_SERVICE_ROLE_KEY"));
    assert!(is_secret_variable_name("OPENAI_API_KEY"));
    assert!(is_secret_variable_name("NEXTAUTH_SECRET"));
    assert!(is_secret_variable_name("STRIPE_WEBHOOK_SIGNING_SECRET"));
    assert!(is_secret_variable_name("clientSecret"));
    assert!(is_secret_variable_name("DATABASE_PASSWORD"));
}

#[test]
fn secret_var_name_allowlist_rejects_lookalikes() {
    // secret っぽいが実際は secret でない名前は弾く
    assert!(!is_secret_variable_name("API_KEY_HINT"));
    assert!(!is_secret_variable_name("PASSWORDLESS"));
    assert!(!is_secret_variable_name("KEYBOARD_LAYOUT"));
    assert!(!is_secret_variable_name("KEY_ID"));
    assert!(!is_secret_variable_name("token_type"));
    assert!(!is_secret_variable_name("secret_name"));
    assert!(!is_secret_variable_name("keyword"));
}

#[test]
fn secret_var_name_non_secret_rejected() {
    assert!(!is_secret_variable_name("username"));
    assert!(!is_secret_variable_name("count"));
    assert!(!is_secret_variable_name("port"));
}

// ─── find_yaml_comment_start(R12-#4 pnpm YAML inline comment)──────
#[test]
fn yaml_comment_start_strips_inline() {
    // quote 外の `# ...` を検出
    assert_eq!(find_yaml_comment_start("- \"apps/*\" # frontend"), Some(11));
    // quote 内の `#` は無視
    assert_eq!(find_yaml_comment_start("- \"apps/#special\""), None);
    // コメントなし
    assert_eq!(find_yaml_comment_start("- apps/*"), None);
}

// ─── workspace_glob_matches(R11-#5 / R12-#4)─────────────────────
#[test]
fn workspace_glob_variants() {
    assert!(workspace_glob_matches("apps/*", "apps/web"));
    assert!(!workspace_glob_matches("apps/*", "apps/web/nested"));
    assert!(workspace_glob_matches("apps/**", "apps/web/nested"));
    assert!(workspace_glob_matches("packages/foo", "packages/foo"));
    assert!(!workspace_glob_matches("apps/*", "packages/foo"));
}

// ─── mask_snippet ──────────────────────────────────────────────
#[test]
fn mask_quoted_long_value() {
    // 8+ 文字のクオート内は伏せ字
    let out = mask_snippet("api_key = \"sk-abc12345XYZ\"");
    assert!(out.contains(MASK), "expected mask, got {out}");
    assert!(!out.contains("sk-abc12345XYZ"), "raw value leaked: {out}");
}

#[test]
fn mask_quoted_short_value_kept() {
    // 7 文字以下はクオート内でもそのまま
    let out = mask_snippet("name = \"short\"");
    assert!(out.contains("\"short\""), "short quoted value should be kept: {out}");
}

#[test]
fn mask_url_credentials() {
    // URL 内 user:pass を伏せる
    let out = mask_snippet("DATABASE_URL=postgres://alice:s3cret@db.host/app");
    assert!(!out.contains("alice"), "url user leaked: {out}");
    assert!(!out.contains("s3cret"), "url password leaked: {out}");
    assert!(out.contains("db.host"), "host should stay visible: {out}");
}

#[test]
fn mask_bare_env_assignment() {
    // KEY=value(クオートなし)も伏せる
    let out = mask_snippet("API_KEY=sk-abc12345XYZ0000");
    assert!(!out.contains("sk-abc12345XYZ0000"), "bare secret leaked: {out}");
    assert!(out.contains("API_KEY="), "key name should stay visible: {out}");
}

#[test]
fn mask_env_ref_untouched() {
    // process.env.X / ${VAR} は伏せない(参照であって秘密ではない)
    let out = mask_snippet("API_KEY=process.env.MY_KEY");
    assert!(out.contains("process.env.MY_KEY"), "env-ref should stay visible: {out}");
}

// ─── is_real_console_log ───────────────────────────────────────
#[test]
fn console_log_matches_various_forms() {
    assert!(is_real_console_log("  console.log('hi')"), "plain");
    assert!(is_real_console_log("  console.log ('hi')"), "with space");
    assert!(is_real_console_log("  console?.log('hi')"), "optional chaining");
}

#[test]
fn console_log_ignores_string_literal() {
    // 文字列リテラル中の "console.log(" は無視する
    assert!(!is_real_console_log("  const s = 'console.log(x)'"));
}

// ─── is_tag_in_real_comment(TODO 検出)─────────────────────────
#[test]
fn todo_bare_marker_detected() {
    assert!(is_tag_in_real_comment("// TODO: fix later", "TODO"));
}

#[test]
fn todo_tracked_with_issue_skipped() {
    // #123 / PROJECT-42 は tracked → 検出から外す
    assert!(!is_tag_in_real_comment("// TODO(#123): xxx", "TODO"));
    assert!(!is_tag_in_real_comment("// TODO(PROJECT-42): xxx", "TODO"));
    assert!(!is_tag_in_real_comment("// TODO(123): xxx", "TODO"));
}

#[test]
fn todo_owner_only_kept() {
    // @user だけの owner は未完了扱いのまま(担当者付きでも作業は残っている)
    assert!(is_tag_in_real_comment("// TODO(@alice): implement", "TODO"));
}

// ─── gitignore_pattern_matches ─────────────────────────────────
#[test]
fn gitignore_exact_match() {
    assert!(gitignore_pattern_matches(".env", ".env"));
}

#[test]
fn gitignore_wildcard_star() {
    assert!(gitignore_pattern_matches(".env*", ".env.local"));
    assert!(gitignore_pattern_matches(".env.*", ".env.local"));
    assert!(!gitignore_pattern_matches(".env.*", ".env"));
}

#[test]
fn gitignore_globstar_prefix() {
    assert!(gitignore_pattern_matches("**/.env", ".env"));
}

// ─── is_plausible_secret_hit(URL credential 必須)─────────────
#[test]
fn plausible_secret_url_needs_at_sign() {
    // credential 付き URL → 検出
    assert!(is_plausible_secret_hit(
        "url = postgres://alice:pw@host/db",
        "postgres://",
    ));
    // credential 無し URL → 検出しない(host 情報だけでは秘密でない)
    assert!(!is_plausible_secret_hit(
        "url = postgres://localhost:5432/app",
        "postgres://",
    ));
}

// ─── is_test_file_path ────────────────────────────────────────
// ─── detect_project_meta(fixture ベース)──────────────────────
// tempdir に実 FS を作って manifests 検出が意図通りかを確認する。
// 前実装で subdir が Node/Rust しか拾わなかったバグ、root Cargo.toml と
// src-tauri/Cargo.toml が重複追加されるバグを再発させないためのガード。
#[test]
fn detect_project_meta_tauri_layout() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("package.json"), r#"{"scripts": {"build": "vite build", "test": "vitest"}}"#).unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    std::fs::write(root.join("tsconfig.json"), "{}").unwrap();
    std::fs::create_dir_all(root.join("src-tauri")).unwrap();
    std::fs::write(root.join("src-tauri/Cargo.toml"), "[package]\nname=\"x\"").unwrap();

    let meta = detect_project_meta(root);
    let paths: Vec<&str> = meta.manifests.iter().map(|m| m.path.as_str()).collect();
    assert!(paths.contains(&"package.json"), "node manifest missing: {paths:?}");
    assert!(paths.contains(&"src-tauri/Cargo.toml"), "tauri rust manifest missing: {paths:?}");
    // 重複しないこと
    assert_eq!(paths.iter().filter(|p| **p == "src-tauri/Cargo.toml").count(), 1);
    assert_eq!(paths.iter().filter(|p| **p == "package.json").count(), 1);
}

#[test]
fn detect_project_meta_monorepo_full_types() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("package.json"), "{}").unwrap();
    std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
    // pnpm workspace 定義:これが無いと root lockfile 継承は無効(独立 sub package 扱い)
    std::fs::write(
        root.join("pnpm-workspace.yaml"),
        "packages:\n  - 'apps/*'\n  - 'services/*'\n",
    )
    .unwrap();
    // Node subdir(root lockfile 継承を workspace 経由で確認)
    std::fs::create_dir_all(root.join("apps/web")).unwrap();
    std::fs::write(root.join("apps/web/package.json"), r#"{"scripts": {"build": "vite build"}}"#).unwrap();
    // Python subdir(前実装で拾えなかった)
    std::fs::create_dir_all(root.join("services/api")).unwrap();
    std::fs::write(root.join("services/api/pyproject.toml"), "[project]\nname='x'").unwrap();
    // PHP subdir(前実装で拾えなかった)
    std::fs::create_dir_all(root.join("apps/admin")).unwrap();
    std::fs::write(root.join("apps/admin/composer.json"), "{}").unwrap();
    // Go subdir(前実装で拾えなかった)
    std::fs::create_dir_all(root.join("services/worker")).unwrap();
    std::fs::write(root.join("services/worker/go.mod"), "module x").unwrap();

    let meta = detect_project_meta(root);
    let paths: Vec<&str> = meta.manifests.iter().map(|m| m.path.as_str()).collect();
    for expected in [
        "package.json",
        "apps/web/package.json",
        "services/api/pyproject.toml",
        "apps/admin/composer.json",
        "services/worker/go.mod",
    ] {
        assert!(paths.contains(&expected), "missing {expected} in {paths:?}");
    }

    // apps/web は local lockfile 無し + root pnpm-lock.yaml あり → has_lockfile=true(root 継承)
    let web = meta.manifests.iter().find(|m| m.path == "apps/web/package.json").unwrap();
    assert!(web.has_lockfile, "root lockfile inheritance failed for apps/web");
}

#[test]
fn detect_project_meta_workspace_gated_lockfile() {
    // workspace 定義が無ければ、root lockfile があっても sub package には継承しない。
    // 独立 sub package なのに no-lockfile を出さなくなる誤検知を防ぐガード。
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("package.json"), "{}").unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    // pnpm-workspace.yaml も workspaces フィールドも無い
    std::fs::create_dir_all(root.join("apps/demo")).unwrap();
    std::fs::write(root.join("apps/demo/package.json"), r#"{}"#).unwrap();

    let meta = detect_project_meta(root);
    let demo = meta
        .manifests
        .iter()
        .find(|m| m.path == "apps/demo/package.json")
        .unwrap();
    assert!(!demo.has_lockfile, "independent sub package should NOT inherit root lockfile");
}

#[test]
fn detect_project_meta_pnpm_yaml_with_comments_and_dotslash() {
    // pnpm-workspace.yaml の実例(inline comment / ./ prefix / examples/*)対応。
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("package.json"), "{}").unwrap();
    std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
    std::fs::write(
        root.join("pnpm-workspace.yaml"),
        "packages:\n  - \"apps/*\" # frontend apps\n  - ./packages/*\n  - \"examples/*\"\n",
    )
    .unwrap();
    // examples/* は固定 apps|packages|services には無いディレクトリ
    std::fs::create_dir_all(root.join("examples/demo")).unwrap();
    std::fs::write(root.join("examples/demo/package.json"), r#"{"scripts":{"build":"x"}}"#).unwrap();
    std::fs::create_dir_all(root.join("packages/ui")).unwrap();
    std::fs::write(root.join("packages/ui/package.json"), "{}").unwrap();

    let meta = detect_project_meta(root);
    let paths: Vec<&str> = meta.manifests.iter().map(|m| m.path.as_str()).collect();
    assert!(paths.contains(&"examples/demo/package.json"), "examples/* not expanded: {paths:?}");
    assert!(paths.contains(&"packages/ui/package.json"), "./packages/* not expanded: {paths:?}");
    // examples/demo は workspace member なので root pnpm-lock.yaml を継承
    let demo = meta.manifests.iter().find(|m| m.path == "examples/demo/package.json").unwrap();
    assert!(demo.has_lockfile, "workspace member should inherit root lockfile");
}

#[test]
fn detect_project_meta_vite_tsconfig_variants() {
    // tsconfig.json 無し、tsconfig.app.json + tsconfig.node.json のみでも TS 判定される
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(root.join("package.json"), r#"{"devDependencies": {"typescript": "^5"}}"#).unwrap();
    std::fs::write(root.join("tsconfig.app.json"), "{}").unwrap();
    std::fs::write(root.join("tsconfig.node.json"), "{}").unwrap();
    let meta = detect_project_meta(root);
    let node = meta.manifests.iter().find(|m| m.manifest_type == "node").unwrap();
    assert!(node.has_tsconfig_file, "tsconfig.app.json variant should mark node has_tsconfig_file");
    assert!(node.is_typescript_project, "tsconfig.app.json variant should mark node as TS project");
}

#[test]
fn test_file_path_recognizes_language_patterns() {
    // JS/TS
    assert!(is_test_file_path(std::path::Path::new("src/foo.test.ts")));
    assert!(is_test_file_path(std::path::Path::new("src/foo.spec.ts")));
    assert!(is_test_file_path(std::path::Path::new("src/__tests__/foo.ts")));
    // Python
    assert!(is_test_file_path(std::path::Path::new("tests/test_foo.py")));
    assert!(is_test_file_path(std::path::Path::new("tests/foo_test.py")));
    // Rust
    assert!(is_test_file_path(std::path::Path::new("src-tauri/src/scanner_test.rs")));
    assert!(is_test_file_path(std::path::Path::new("tests/integration.rs")));
    // Go
    assert!(is_test_file_path(std::path::Path::new("pkg/foo_test.go")));
    // Ruby
    assert!(is_test_file_path(std::path::Path::new("spec/foo_spec.rb")));
    // 非テストファイルは false
    assert!(!is_test_file_path(std::path::Path::new("src/foo.ts")));
    assert!(!is_test_file_path(std::path::Path::new("src/lib.rs")));
}
