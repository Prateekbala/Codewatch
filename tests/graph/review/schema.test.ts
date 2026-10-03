import { describe, expect, it } from "vitest";

import { FindingSchema } from "../../../src/core/graph/review/schema.ts";
import {
  fingerprintFinding,
  deduplicateFindings,
} from "../../../src/core/graph/review/fingerprint.ts";
import type { Finding } from "../../../src/core/graph/review/schema.ts";

const validFinding: Omit<Finding, "id"> = {
  category: "security",
  severity: "high",
  confidence: 0.9,
  path: "src/auth.ts",
  startLine: 10,
  endLine: 15,
  side: "RIGHT",
  title: "SQL injection vulnerability",
  explanation: "User input is passed directly to the query without sanitization.",
  evidence: ["R12:+  db.query(`SELECT * FROM users WHERE id = ${userId}`)"],
  suggestion: "Use parameterized queries instead.",
  source: "llm",
};

describe("FindingSchema", () => {
  it("parses a valid finding", () => {
    const id = fingerprintFinding(validFinding);
    const result = FindingSchema.safeParse({ ...validFinding, id });
    expect(result.success).toBe(true);
  });

  it("rejects a finding missing required fields", () => {
    const { title: _omitted, ...withoutTitle } = validFinding;
    const id = fingerprintFinding(validFinding);
    const result = FindingSchema.safeParse({ ...withoutTitle, id });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const id = fingerprintFinding(validFinding);
    const result = FindingSchema.safeParse({ ...validFinding, id, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const id = fingerprintFinding(validFinding);
    const result = FindingSchema.safeParse({ ...validFinding, id, confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it("enforces title max 120 chars", () => {
    const id = fingerprintFinding(validFinding);
    const longTitle = "a".repeat(121);
    const result = FindingSchema.safeParse({ ...validFinding, id, title: longTitle });
    expect(result.success).toBe(false);
  });

  it("accepts title of exactly 120 chars", () => {
    const finding120 = { ...validFinding, title: "a".repeat(120) };
    const id = fingerprintFinding(finding120);
    const result = FindingSchema.safeParse({ ...finding120, id });
    expect(result.success).toBe(true);
  });

  it("allows suggestion to be omitted", () => {
    const { suggestion: _omitted, ...noSuggestion } = validFinding;
    const id = fingerprintFinding(noSuggestion);
    const result = FindingSchema.safeParse({ ...noSuggestion, id });
    expect(result.success).toBe(true);
  });
});

describe("fingerprintFinding", () => {
  it("returns a 16-character hex string", () => {
    const fp = fingerprintFinding(validFinding);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable — same input produces the same output", () => {
    const fp1 = fingerprintFinding(validFinding);
    const fp2 = fingerprintFinding(validFinding);
    expect(fp1).toBe(fp2);
  });

  it("produces different hashes for different paths", () => {
    const fp1 = fingerprintFinding(validFinding);
    const fp2 = fingerprintFinding({ ...validFinding, path: "src/other.ts" });
    expect(fp1).not.toBe(fp2);
  });

  it("produces different hashes for different startLines", () => {
    const fp1 = fingerprintFinding(validFinding);
    const fp2 = fingerprintFinding({ ...validFinding, startLine: 99 });
    expect(fp1).not.toBe(fp2);
  });
});

describe("deduplicateFindings", () => {
  const makeFinding = (overrides: Partial<Omit<Finding, "id">> = {}): Finding => {
    const base: Omit<Finding, "id"> = { ...validFinding, ...overrides };
    return { ...base, id: fingerprintFinding(base) };
  };

  it("removes exact duplicate ids, keeping first", () => {
    const f = makeFinding();
    const result = deduplicateFindings([f, f, f]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(f.id);
  });

  it("keeps findings with different ids", () => {
    const f1 = makeFinding({ path: "src/a.ts" });
    const f2 = makeFinding({ path: "src/b.ts" });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(2);
  });

  it("collapses overlapping same-category same-path findings", () => {
    const f1 = makeFinding({ startLine: 10, endLine: 15, severity: "high", evidence: ["e1"] });
    const f2 = makeFinding({
      startLine: 14,
      endLine: 20,
      severity: "medium",
      title: "Another issue",
      evidence: ["e2"],
    });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(1);
  });

  it("keeps higher severity when collapsing", () => {
    const f1 = makeFinding({ startLine: 10, endLine: 15, severity: "medium", evidence: ["e1"] });
    const f2 = makeFinding({
      startLine: 12,
      endLine: 18,
      severity: "critical",
      title: "Critical issue",
      evidence: ["e2"],
    });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
  });

  it("merges evidence arrays when collapsing", () => {
    const f1 = makeFinding({ startLine: 10, endLine: 15, evidence: ["e1"] });
    const f2 = makeFinding({
      startLine: 12,
      endLine: 18,
      title: "Related issue",
      evidence: ["e2"],
    });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.evidence).toContain("e1");
    expect(result[0]?.evidence).toContain("e2");
  });

  it("does not collapse findings with different categories", () => {
    const f1 = makeFinding({ startLine: 10, endLine: 15, category: "security" });
    const f2 = makeFinding({
      startLine: 12,
      endLine: 18,
      category: "performance",
      title: "Correctness issue",
    });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(2);
  });

  it("does not collapse findings with different paths", () => {
    const f1 = makeFinding({ startLine: 10, endLine: 15, path: "src/a.ts" });
    const f2 = makeFinding({
      startLine: 12,
      endLine: 18,
      path: "src/b.ts",
      title: "Issue in b",
    });
    const result = deduplicateFindings([f1, f2]);
    expect(result).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(deduplicateFindings([])).toEqual([]);
  });
});
