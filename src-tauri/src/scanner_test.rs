//! Scanner helper のユニットテスト。
//!
//! ファイル名が `_test.rs` で終わることで、AppMap 自身のコードチェックの
//! `is_test_file_path` が「テスト fixture」と判定し、内部に含まれる fake secret /
//! fake TODO / console.log を content スキャンから除外できる。
//!
//! (production コード側の lib.rs から `#[path = "scanner_test.rs"]` で読み込まれる。)

use super::*;

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
