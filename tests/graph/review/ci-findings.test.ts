import { describe, expect, it } from "vitest";

import { findingsFromAnnotations } from "../../../src/core/graph/review/ci-findings.ts";

describe("findingsFromAnnotations", () => {
  it("maps failing annotations on changed files to ci findings", () => {
    const findings = findingsFromAnnotations(
      [
        {
          path: "src/a.ts",
          startLine: 4,
          endLine: 4,
          level: "failure",
          title: "Type error",
          message: "Property x is missing",
        },
        {
          path: "src/other.ts",
          startLine: 1,
          endLine: 1,
          level: "failure",
          title: "Elsewhere",
          message: "ignored",
        },
      ],
      new Set(["src/a.ts"]),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "src/a.ts",
      source: "ci",
      severity: "high",
      confidence: 1,
    });
  });
});
