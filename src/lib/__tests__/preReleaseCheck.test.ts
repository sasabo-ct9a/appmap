import { describe, expect, it } from "vitest";
import {
  buildFindings,
  computeOverallAssessment,
  type PreReleaseScanResult,
} from "../preReleaseCheck";
import type { ScreenMapResult } from "../claudeCli";

const EMPTY_SCREENS: ScreenMapResult = {
  nodes: [],
  edges: [],
  appSummary: "test summary",
};

// Rust scanner が返す "何もない・きれい" 結果のベースライン。
// 各テストで差分だけ上書きして使い回す。
function cleanScan(overrides: Partial<PreReleaseScanResult> = {}): PreReleaseScanResult {
  return {
    secrets: [],
    todos: [],
    console_logs: [],
    secrets_total: 0,
    todos_total: 0,
    console_logs_total: 0,
    files_scanned: 100,
    files_truncated: false,
    detected_test_framework: "Vitest",
    has_test_files: true,
    env_files_present: false,
    env_covered_by_gitignore: true,
    project_meta: {
      project_type: "node",
      project_types: ["node"],
      has_build_script: true,
      has_test_script: true,
      has_typecheck_script: true,
      has_lockfile: true,
      has_tsconfig_file: true,
      is_typescript_project: true,
      has_ci_workflow: true,
      manifests: [
        {
          manifest_type: "node",
          path: "package.json",
          has_build: true,
          has_test: true,
          has_typecheck: true,
          has_lockfile: true,
          has_tsconfig_file: true,
          is_typescript_project: true,
        },
      ],
    },
    ...overrides,
  };
}

describe("buildFindings", () => {
  it("returns empty findings when scan is clean", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan(),
      language: "ja",
    });
    expect(findings).toHaveLength(0);
  });

  it("surfaces secrets as high severity", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        secrets: [{ file: "src/api.ts", line: 12, snippet: "*** (伏字) ***", kind: "openai-like key" }],
        secrets_total: 1,
      }),
      language: "ja",
    });
    const secret = findings.find((f) => f.id === "secrets");
    expect(secret?.severity).toBe("high");
    // snippet が raw value ではなく mask 済みであること
    expect(secret?.examples?.[0].snippet).toContain("*** (伏字) ***");
    expect(secret?.examples?.[0].snippet).not.toContain("sk-real");
  });

  it("surfaces env-unprotected as high when .env exists but not covered", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        env_files_present: true,
        env_covered_by_gitignore: false,
      }),
      language: "ja",
    });
    const env = findings.find((f) => f.id === "env-unprotected");
    expect(env?.severity).toBe("high");
  });

  it("does not surface env-unprotected when env is covered", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        env_files_present: true,
        env_covered_by_gitignore: true,
      }),
      language: "ja",
    });
    expect(findings.find((f) => f.id === "env-unprotected")).toBeUndefined();
  });

  it("counts secrets from secrets_total, not truncated .length", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        secrets: Array.from({ length: 5 }, (_, i) => ({
          file: `f${i}.ts`,
          line: 1,
          snippet: "*** (伏字) ***",
          kind: "openai-like key",
        })),
        secrets_total: 300, // truncate 前は 300 件
      }),
      language: "ja",
    });
    const secret = findings.find((f) => f.id === "secrets");
    expect(secret?.count).toBe(300);
  });

  it("suppresses the test-missing finding when the scan was truncated (Codex round 20)", () => {
    // walk 打ち切り時は has_test_files=false が「未走査で見つからなかっただけ」の可能性が
    // あるため、テスト欠落 finding を出さない(不明扱いに寄せる)。
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        files_truncated: true,
        has_test_files: false,
        detected_test_framework: null,
      }),
      language: "ja",
    });
    expect(findings.find((f) => f.id === "no-test-framework")).toBeUndefined();
    expect(findings.find((f) => f.id === "no-tests")).toBeUndefined();
  });

  it("still emits the test-missing finding when the scan was complete", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        files_truncated: false,
        has_test_files: false,
        detected_test_framework: null,
      }),
      language: "ja",
    });
    expect(findings.find((f) => f.id === "no-test-framework")).toBeDefined();
  });

  it("never emits Node/DevOps release-gate findings (scope charter, CLAUDE.md §6.5)", () => {
    // build/test/typecheck script・lockfile・CI は対象外に決めた。manifest が全部
    // 「欠落」でも、これらの gate finding は一切出さない。将来うっかり復活したらここで落ちる。
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        project_meta: {
          project_type: "node",
          project_types: ["node"],
          has_build_script: false,
          has_test_script: false,
          has_typecheck_script: false,
          has_lockfile: false,
          has_tsconfig_file: true,
          is_typescript_project: true,
          has_ci_workflow: false,
          manifests: [
            {
              manifest_type: "node",
              path: "package.json",
              has_build: false,
              has_test: false,
              has_typecheck: false,
              has_lockfile: false,
              has_tsconfig_file: true,
              is_typescript_project: true,
            },
          ],
        },
      }),
      language: "ja",
    });
    const ids = findings.map((f) => f.id);
    for (const gate of [
      "no-build-script",
      "no-test-script",
      "no-typecheck-script",
      "no-lockfile",
      "no-ci-workflow",
    ]) {
      expect(ids).not.toContain(gate);
    }
  });
});

describe("computeOverallAssessment", () => {
  it("returns 'unknown' when scanState is failed (does NOT say ready)", () => {
    const assessment = computeOverallAssessment([], "ja", "failed", false);
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.summary).toContain("失敗"); // 「スキャンが失敗」的な文言
  });

  it("returns 'unknown' when scanState is unavailable", () => {
    const assessment = computeOverallAssessment([], "ja", "unavailable", false);
    expect(assessment.verdict).toBe("unknown");
  });

  it("returns 'unknown' when scan ok but coverage was truncated", () => {
    const assessment = computeOverallAssessment([], "ja", "ok", true);
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.summary).toContain("未走査");
  });

  it("returns 'ready' only when scan ok AND full coverage AND no findings", () => {
    const assessment = computeOverallAssessment([], "ja", "ok", false);
    expect(assessment.verdict).toBe("ready");
  });

  it("returns 'block' when any high-severity finding exists", () => {
    const assessment = computeOverallAssessment(
      [
        {
          id: "secrets",
          severity: "high",
          category: "secrets",
          title: "leaked",
          hint: "danger",
          fixSteps: [],
        },
      ],
      "ja",
      "ok",
      false,
    );
    expect(assessment.verdict).toBe("block");
  });
});
