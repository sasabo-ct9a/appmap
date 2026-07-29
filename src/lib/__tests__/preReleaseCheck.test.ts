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
      has_build_script: true,
      has_test_script: true,
      has_typecheck_script: true,
      has_lockfile: true,
      has_tsconfig: true,
      is_typescript_project: true,
      has_ci_workflow: true,
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

  it("adds release-gate findings for missing infra", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        project_meta: {
          project_type: "node",
          has_build_script: false,
          has_test_script: false,
          has_typecheck_script: false,
          has_lockfile: false,
          has_tsconfig: true,
          is_typescript_project: true,
          has_ci_workflow: false,
        },
      }),
      language: "ja",
    });
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("no-build-script");
    expect(ids).toContain("no-test-script");
    expect(ids).toContain("no-typecheck-script");
    expect(ids).toContain("no-lockfile");
    expect(ids).toContain("no-ci-workflow");
  });

  it("does not add Node-specific gates for Rust projects", () => {
    const findings = buildFindings({
      screens: EMPTY_SCREENS,
      scan: cleanScan({
        project_meta: {
          project_type: "rust",
          has_build_script: true,
          has_test_script: true,
          has_typecheck_script: true,
          has_lockfile: true, // Cargo.lock
          has_tsconfig: false,
          is_typescript_project: false,
          has_ci_workflow: true,
        },
      }),
      language: "ja",
    });
    const ids = findings.map((f) => f.id);
    expect(ids).not.toContain("no-build-script");
    expect(ids).not.toContain("no-typecheck-script");
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
    expect(assessment.summary).toContain("打ち切り");
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
