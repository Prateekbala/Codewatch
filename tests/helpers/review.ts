import { promoteFinding } from "../../src/core/graph/review/fingerprint.ts";
import type { Finding, LlmFinding, ReviewResult } from "../../src/core/graph/review/schema.ts";
import { CostTracker } from "../../src/core/llm/cost.ts";
import { LlmGateway } from "../../src/core/llm/gateway.ts";
import { charEstimateCounter } from "../../src/core/llm/tokens.ts";
import type { CoreServices } from "../../src/core/services.ts";

import { type FakeGitHubClient, type ScriptedLlm, silentLogger, testConfig } from "./fakes.ts";

export const buildServices = (
  llm: ScriptedLlm,
  client: FakeGitHubClient,
  overrides: unknown = {},
): CoreServices => {
  const partial = overrides as { review?: Record<string, unknown> };
  const config = testConfig({
    ...(overrides as object),
    review: { enableVerifier: false, ...partial.review },
  });
  return {
    github: client,
    llm: new LlmGateway({
      config,
      tracker: CostTracker.fromConfig(config),
      adapterFactory: llm.factory,
      logger: silentLogger,
    }),
    config,
    logger: silentLogger,
    counter: charEstimateCounter(4),
  };
};

export const llmFinding = (overrides: Partial<LlmFinding> = {}): LlmFinding => ({
  category: "security",
  severity: "high",
  confidence: 0.9,
  path: "src/auth.ts",
  startLine: 2,
  endLine: 2,
  side: "RIGHT",
  title: "SQL injection",
  explanation: "User input flows into the query unescaped.",
  evidence: ["R2:+new"],
  suggestion: null,
  ...overrides,
});

export const finding = (overrides: Partial<LlmFinding> = {}): Finding =>
  promoteFinding(llmFinding(overrides));

export const summaryOutput = {
  overview: "Updates authentication and API handling.",
  riskLevel: "medium" as const,
  highlights: ["Auth query construction changed"],
  fileGroups: [
    { group: "Auth", files: ["src/auth.ts", "src/missing.ts"], notes: "Needs attention" },
  ],
};

export const emptyStats: ReviewResult["stats"] = {
  candidates: 0,
  duplicates: 0,
  ungrounded: 0,
  belowConfidence: 0,
  belowSeverity: 0,
  rejectedByVerifier: 0,
  ciImported: 0,
  failedUnits: 0,
  units: 0,
};
