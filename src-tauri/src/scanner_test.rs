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

#[test]
fn secret_var_name_default_prefixed_still_detected() {
    // R13-#1:DEFAULT_/SAMPLE_ が付いても直書きなら検出する(allowlist が殺していた回帰)
    assert!(is_secret_variable_name("DEFAULT_ADMIN_PASSWORD"));
    assert!(is_secret_variable_name("DEFAULT_JWT_SECRET"));
    assert!(is_secret_variable_name("SAMPLE_STRIPE_SECRET"));
    assert!(is_secret_variable_name("EXAMPLE_API_KEY"));
}

// ─── line_contains_secret(R13-#7 Q&A/localLLM mask 判定)────────
#[test]
fn line_secret_detection_for_masking() {
    // URL クエリの token= は誤検出しない(quote 内)
    assert!(!line_contains_secret(
        "  callbackUrl: \"https://example.com/cb?token=aaaaaaaaaaaaaaaa\""
    ));
    // 実 secret 代入は mask 対象
    assert!(line_contains_secret("SUPABASE_SERVICE_ROLE_KEY=abcdef1234567890xyz"));
    // credential URL は mask 対象
    assert!(line_contains_secret("DATABASE_URL=postgres://user:pass@host/db"));
    // 通常の UI 文言・SQL は mask しない
    assert!(!line_contains_secret("const label = \"ようこそ、ログインしてください\""));
    assert!(!line_contains_secret("SELECT * FROM users WHERE active = true"));
}

// ─── package_json_is_unity(Unity パッケージ除外)──────────────
#[test]
fn unity_package_json_is_excluded() {
    use std::fs;
    let dir = tempfile::tempdir().unwrap();
    // Unity パッケージ(unity フィールドあり)= 除外対象
    fs::write(
        dir.path().join("package.json"),
        r#"{"name":"jp.lilxyzw.liltoon","version":"2.3.2","displayName":"lilToon","unity":"2022.3"}"#,
    )
    .unwrap();
    assert!(package_json_is_unity(dir.path()));

    // 通常の Node package.json = 除外しない
    let dir2 = tempfile::tempdir().unwrap();
    fs::write(
        dir2.path().join("package.json"),
        r#"{"name":"my-app","version":"1.0.0","scripts":{"build":"vite build"}}"#,
    )
    .unwrap();
    assert!(!package_json_is_unity(dir2.path()));
}

// ─── is_secret_variable_name(token 完全一致・誤検出回帰)──────
#[test]
fn secret_var_name_no_substring_false_positives() {
    // 実在の英単語が secret マーカーを substring 包含しても誤検出しない
    assert!(!is_secret_variable_name("author")); // ⊃ auth
    assert!(!is_secret_variable_name("tokenizer")); // ⊃ token
    assert!(!is_secret_variable_name("secretary")); // ⊃ secret
    assert!(!is_secret_variable_name("monkey")); // ⊃ key
    // 公開・構造キーは secret ではない
    assert!(!is_secret_variable_name("publicKey"));
    assert!(!is_secret_variable_name("primaryKey"));
    assert!(!is_secret_variable_name("partitionKey"));
    assert!(!is_secret_variable_name("cacheKey"));
    // 単独の key は汎用すぎるので拾わない(CI cache key 等)
    assert!(!is_secret_variable_name("key"));
    // 本物 secret 変数は従来通り検出
    assert!(is_secret_variable_name("clientSecret"));
    assert!(is_secret_variable_name("API_KEY"));
    assert!(is_secret_variable_name("signingKey"));
    assert!(is_secret_variable_name("DATABASE_PASSWORD"));
    assert!(is_secret_variable_name("SUPABASE_SERVICE_ROLE_KEY"));
    assert!(is_secret_variable_name("passphrase"));
    assert!(is_secret_variable_name("authToken"));
}

// ─── is_plausible_secret_hit(左境界・誤検出回帰)──────────────
#[test]
fn plausible_hit_requires_left_boundary() {
    // sk- が単語の途中(task-/risk-/disk-)に出ても誤検出しない
    assert!(!is_plausible_secret_hit("<div className=\"task-management-dashboard\">", "sk-"));
    assert!(!is_plausible_secret_hit("const url = \"/api/risk-assessment-report\";", "sk-"));
    assert!(!is_plausible_secret_hit(".disk-space-indicator-container {}", "sk-"));
    // 正当な代入は検出(左が空白 → 境界 OK、本体 16 文字以上)
    assert!(is_plausible_secret_hit("const k = sk-EXAMPLE_fake_test_key;", "sk-"));
}

// ─── line_contains_secret(マスク漏れ回帰:検出と同じ needle 集合)─
#[test]
fn masker_covers_full_needle_set() {
    // 以前マスク側の縮小リストから漏れていた prefix も mask 対象になる
    assert!(line_contains_secret("const t = \"gho_EXAMPLE_fake_test_keyabcd\";"));
    assert!(line_contains_secret("const w = \"whsec_EXAMPLE_fake_test_keyabcd\";"));
    assert!(line_contains_secret("const s = \"SG.EXAMPLE_fake_test_key.abcdRtY7bQmz\";"));
    assert!(line_contains_secret("const pk = \"pk_live_EXAMPLE_fake_test_keyabcd\";"));
}

// ─── is_test_file_path(C# 追加)────────────────────────────────
#[test]
fn test_file_path_recognizes_csharp() {
    use std::path::Path;
    assert!(is_test_file_path(Path::new("Assets/Scripts/PlayerTests.cs")));
    assert!(is_test_file_path(Path::new("src/FooTest.cs")));
    assert!(is_test_file_path(Path::new("Tests/IntegrationSpec.cs")));
    assert!(!is_test_file_path(Path::new("Assets/Scripts/Player.cs")));
}

// ─── is_skippable_dir(Unity/.NET 巨大キャッシュ除外)──────────
#[test]
fn skippable_dir_covers_unity_and_dotnet() {
    // Unity/.NET の生成物専用キャッシュは大文字小文字問わず除外(3GB Library の回帰)
    assert!(is_skippable_dir("Library"));
    assert!(is_skippable_dir("library"));
    assert!(is_skippable_dir("obj"));
    // 従来の除外も維持
    assert!(is_skippable_dir("node_modules"));
    assert!(is_skippable_dir(".git"));
    assert!(is_skippable_dir("target"));
    // temp/logs/bin は実コードを含みうるので除外しない(Codex round 15 Medium)
    assert!(!is_skippable_dir("temp"));
    assert!(!is_skippable_dir("Temp"));
    assert!(!is_skippable_dir("logs"));
    assert!(!is_skippable_dir("bin"));
    // ユーザーのコードは除外しない
    assert!(!is_skippable_dir("src"));
    assert!(!is_skippable_dir("Assets"));
    assert!(!is_skippable_dir("app"));
    assert!(!is_skippable_dir("components"));
}

// ─── is_plausible_secret_hit(接続文字列の placeholder 例示を弾く)────
#[test]
fn connection_string_placeholder_userinfo_rejected() {
    // ドキュメント/コメント中の例示(user:pass@)は本物ではないので検出しない
    assert!(!is_plausible_secret_hit("// 例:mongodb+srv://user:pass@host/db", "mongodb+srv://"));
    assert!(!is_plausible_secret_hit("/// postgres://user:pass@db.host/app → ...", "postgres://"));
    assert!(!is_plausible_secret_hit("redis://admin:admin@localhost", "redis://"));
    // 実際の資格情報を持つ接続文字列は検出する
    assert!(is_plausible_secret_hit("DATABASE_URL=postgres://dbadmin:R7bQmz9WpKv@prod/app", "postgres://"));
}

// ─── is_plausible_secret_hit(同一行の全出現を走査:Codex round 16 High)────
#[test]
fn secret_hit_scans_all_occurrences_on_line() {
    // 先頭が短い例示(sk-xxx / user:pass@)で、後続に本物がある行。
    // 旧実装は line.find で最初の 1 回だけ見て false を返し、本物を取りこぼしていた。
    // トークン接頭辞:最初の sk-xxx は本体 3 文字で棄却、2 個目の長いキーで検出。
    assert!(is_plausible_secret_hit(
        "// 例: sk-xxx  実キー: sk-EXAMPLE_fake_test_keyabcd",
        "sk-"
    ));
    // 接続文字列:最初は placeholder(user:pass)、2 個目に実資格情報。
    assert!(is_plausible_secret_hit(
        "// 例 postgres://user:pass@host  実際 postgres://appuser:Xk29fjQ7Zw@10.0.3.5/db",
        "postgres://"
    ));
    // 例示だけの行は依然として棄却される(全出現走査でも誤検出を増やさない)。
    assert!(!is_plausible_secret_hit("// 例: sk-xxx と sk-yyy のみ", "sk-"));
}

// ─── mask_snippet(既知トークンの平文漏れ回帰:Codex round 15 High)────
#[test]
fn mask_snippet_hides_lowercase_bare_tokens() {
    // 小文字 snake_case のクオート無し代入でもトークン値を伏せる(平文漏れの回帰)
    let masked = mask_snippet("github_token=ghp_EXAMPLE_fake_test_keyabcd");
    assert!(!masked.contains("ghp_EXAMPLE_fake_test_keyabcd"), "got: {}", masked);
    let masked2 = mask_snippet("slack_token: xoxb-EXAMPLE_fake_test_keyabcd");
    assert!(!masked2.contains("xoxb-EXAMPLE_fake_test_keyabcd"), "got: {}", masked2);
    // クオート付きも従来通り伏せる
    let masked3 = mask_snippet("const k = \"sk_live_EXAMPLE_fake_test_key\"");
    assert!(!masked3.contains("sk_live_EXAMPLE_fake_test_key"), "got: {}", masked3);
}

// ─── decode_scan_bytes(UTF-16 検出:Codex round 15 Medium)──────────
#[test]
fn decode_handles_utf16() {
    // UTF-16LE(BOM 付き)を正しくデコードして needle が拾えること
    let text = "// TODO: remove ghp_secret";
    let mut le: Vec<u8> = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        le.extend_from_slice(&u.to_le_bytes());
    }
    let decoded = decode_scan_bytes(&le);
    assert!(decoded.contains("TODO"));
    assert!(decoded.contains("ghp_secret"));
    // 通常の UTF-8 はそのまま
    assert_eq!(decode_scan_bytes(b"hello world"), "hello world");
}

// ─── decode_scan_bytes(BOM 無し UTF-16:Codex round 16 Medium)──────────
#[test]
fn decode_handles_bomless_utf16() {
    // 先頭に日本語コメント、本体は ASCII コードで secret を含む BOM 無し UTF-16LE。
    // ASCII が多数派なので奇数位置 NUL 偏りで LE と判定でき、secret を拾える。
    let mut src = String::new();
    src.push_str("// これはライセンスヘッダーです。日本語の説明がしばらく続きます。著作権表示など。\n");
    for _ in 0..20 {
        src.push_str("export const value = computeSomething(alpha, beta, gamma);\n");
    }
    src.push_str("const token = ghp_EXAMPLE_fake_test_keyabcd;\n");
    let le: Vec<u8> = src.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let decoded = decode_scan_bytes(&le);
    assert!(decoded.contains("ghp_EXAMPLE_fake_test_keyabcd"), "LE decode failed");

    // BOM 無し UTF-16BE(高位バイトが偶数位置)も対称に判定する。
    let text = "const token = ghp_EXAMPLE_fake_test_keyabcd;";
    let be: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
    let decoded_be = decode_scan_bytes(&be);
    assert!(decoded_be.contains("ghp_EXAMPLE_fake_test_keyabcd"), "BE decode failed");

    // 純粋な UTF-8(日本語 + ASCII、NUL 皆無)は UTF-16 と誤判定しない。
    let utf8 = "秘密は書かない。const x = compute(a, b, c);";
    assert_eq!(decode_scan_bytes(utf8.as_bytes()), utf8);
}

// ─── trailing_identifier(UTF-8 境界 panic 回帰)────────────────
#[test]
fn trailing_identifier_multibyte_no_panic() {
    // マルチバイト文字の直後で切り出しても panic しない(旧 rfind+1 が落ちていた)
    assert_eq!(trailing_identifier("名前"), ""); // 全部 non-identifier → 空
    assert_eq!(trailing_identifier("設定 apiKey"), "apiKey"); // 空白が境界
    assert_eq!(trailing_identifier("plainKey"), "plainKey"); // 全部 identifier
    assert_eq!(trailing_identifier(""), "");
    assert_eq!(trailing_identifier("料金=x"), "x"); // 実際には呼ばれないが安全確認
}

#[test]
fn line_secret_detection_survives_japanese() {
    // 日本語コメント/文字列を含む行でも panic せず正しく判定する。
    // これがまさに Unity(日本語)プロジェクトでスキャンを落としていたケース。
    assert!(!line_contains_secret("// 設定ファイルの名前です"));
    assert!(!line_contains_secret("名前=太郎")); // secret 名でない + 短い
    assert!(!line_contains_secret("メッセージ: \"接続しました\""));
    // 日本語が前置されても本物 secret は拾う
    assert!(line_contains_secret("設定 apiKey=sk_live_EXAMPLE_fake_key"));
    assert!(line_contains_secret("認証トークン API_TOKEN=abcdef1234567890xyz"));
}

// ─── glob_segments_match(R13-#4 workspace glob)──────────────────
fn split_segs(s: &str) -> Vec<&str> {
    s.split('/').filter(|x| !x.is_empty()).collect()
}

#[test]
fn glob_segments_recursive() {
    // apps/*/packages/*
    assert!(glob_segments_match(&split_segs("apps/*/packages/*"), &split_segs("apps/web/packages/ui")));
    assert!(!glob_segments_match(&split_segs("apps/*/packages/*"), &split_segs("apps/web/src")));
    // services/**
    assert!(glob_segments_match(&split_segs("services/**"), &split_segs("services/api")));
    assert!(glob_segments_match(&split_segs("services/**"), &split_segs("services/api/worker")));
    // !**/dist/** 相当(negation の pattern としてのマッチ)
    assert!(glob_segments_match(&split_segs("**/dist/**"), &split_segs("apps/web/dist/assets")));
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
