import { z } from "zod";

import type { Severity } from "../../config/schema.ts";

export const FINDING_CATEGORIES = [
  "bug",
  "security",
  "performance",
  "tests",
  "api",
  "style",
] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const FINDING_SOURCES = ["llm", "lint", "sast", "ci"] as const;

export const MAX_TITLE_LENGTH = 120;

export const LlmFindingSchema = z.object({
  category: z.enum(FINDING_CATEGORIES).describe("Kind of problem"),
  severity: z.enum(FINDING_SEVERITIES).describe("Impact if the problem is real"),
  confidence: z.number().describe("Certainty that the problem is real, from 0.0 to 1.0"),
  path: z.string().describe("Path of the file exactly as shown in the diff header"),
  startLine: z.number().describe("First affected line number, as labelled in the diff"),
  endLine: z.number().describe("Last affected line number, as labelled in the diff"),
  side: z
    .enum(["LEFT", "RIGHT"])
    .describe("RIGHT for the new file (R labels), LEFT for the old file (L labels)"),
  title: z.string().describe("Specific one-line title of at most 100 characters"),
  explanation: z.string().describe("Why this matters, concretely, and how it can fail"),
  evidence: z
    .array(z.string())
    .describe("Verbatim diff lines or other facts that prove the problem"),
  suggestion: z
    .string()
    .nullable()
    .describe("Replacement code only if the fix is small and local, otherwise null"),
});

export const ReviewUnitOutputSchema = z.object({
  findings: z
    .array(LlmFindingSchema)
    .describe("Confirmed problems only; empty when the change looks correct"),
});

export const FindingSchema = z.object({
  id: z.string(),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.number().min(0).max(1),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]),
  title: z.string().max(MAX_TITLE_LENGTH),
  explanation: z.string(),
  evidence: z.array(z.string()),
  suggestion: z.string().optional(),
  source: z.enum(FINDING_SOURCES),
});

export const ReviewSummarySchema = z.object({
  overview: z
    .string()
    .describe("Two to four sentences on what the change does and where the risk is"),
  riskLevel: z.enum(FINDING_SEVERITIES).describe("Overall risk of merging this change as is"),
  highlights: z.array(z.string()).describe("Short bullets reviewers should read first"),
  fileGroups: z
    .array(
      z.object({
        group: z.string().describe("Short name of a set of related files"),
        files: z.array(z.string()).describe("Paths of changed files in this group"),
        notes: z.string().describe("What changed in the group and what to check"),
      }),
    )
    .describe("Walkthrough of the change by group of files"),
});

export type LlmFinding = z.infer<typeof LlmFindingSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type FindingCategory = Finding["category"];
export type ReviewUnitOutput = z.infer<typeof ReviewUnitOutputSchema>;
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
export type RiskLevel = ReviewSummary["riskLevel"];

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

export interface ReviewStats {
  readonly candidates: number;
  readonly duplicates: number;
  readonly ungrounded: number;
  readonly belowConfidence: number;
  readonly belowSeverity: number;
  readonly rejectedByVerifier: number;
  readonly ciImported: number;
  readonly failedUnits: number;
  readonly units: number;
}

export interface ReviewResult {
  readonly findings: readonly Finding[];
  readonly summary: ReviewSummary;
  readonly notices: readonly string[];
  readonly stats: ReviewStats;
  readonly promptHashes: {
    readonly reviewSystem: string;
    readonly reviewUser: string;
    readonly summarySystem: string;
    readonly summaryUser: string;
  };
}
