import { createHash } from "node:crypto";

import { MAX_TITLE_LENGTH, SEVERITY_RANK, type Finding, type LlmFinding } from "./schema.ts";

const FINGERPRINT_LENGTH = 16;
const LINE_PROXIMITY = 2;

const normalizeTitle = (title: string): string => title.toLowerCase().replace(/\s+/g, " ").trim();

export const fingerprintFinding = (
  finding: Pick<Finding, "category" | "path" | "startLine" | "endLine" | "title">,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        finding.category,
        finding.path,
        finding.startLine,
        finding.endLine,
        normalizeTitle(finding.title),
      ]),
    )
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const promoteFinding = (raw: LlmFinding): Finding => {
  const first = Math.round(raw.startLine);
  const last = Math.round(raw.endLine);
  const startLine = Math.max(1, Math.min(first, last));
  const endLine = Math.max(startLine, first, last);
  const base = {
    category: raw.category,
    severity: raw.severity,
    confidence: clamp(Number.isFinite(raw.confidence) ? raw.confidence : 0, 0, 1),
    path: raw.path.trim().replace(/^[ab]\//, ""),
    startLine,
    endLine,
    side: raw.side,
    title: raw.title.trim().slice(0, MAX_TITLE_LENGTH),
    explanation: raw.explanation.trim(),
    evidence: raw.evidence.map((item) => item.trim()).filter((item) => item !== ""),
    source: "llm" as const,
  };
  const suggestion = raw.suggestion?.trim();
  return {
    ...base,
    id: fingerprintFinding(base),
    ...(suggestion === undefined || suggestion === "" ? {} : { suggestion }),
  };
};

const overlaps = (a: Finding, b: Finding): boolean =>
  a.path === b.path &&
  a.category === b.category &&
  a.side === b.side &&
  Math.max(a.startLine, b.startLine) <= Math.min(a.endLine, b.endLine) + LINE_PROXIMITY;

const collapse = (existing: Finding, candidate: Finding): Finding => {
  const candidateWins =
    SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity] ||
    (SEVERITY_RANK[candidate.severity] === SEVERITY_RANK[existing.severity] &&
      candidate.confidence > existing.confidence);
  const winner = candidateWins ? candidate : existing;
  return {
    ...winner,
    confidence: Math.max(existing.confidence, candidate.confidence),
    evidence: [...new Set([...existing.evidence, ...candidate.evidence])],
  };
};

export const deduplicateFindings = (findings: readonly Finding[]): Finding[] => {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    byId.set(finding.id, existing ? collapse(existing, finding) : finding);
  }

  const result: Finding[] = [];
  for (const candidate of byId.values()) {
    const index = result.findIndex((existing) => overlaps(existing, candidate));
    const match = result[index];
    if (match === undefined) {
      result.push(candidate);
    } else {
      result[index] = collapse(match, candidate);
    }
  }
  return result;
};
