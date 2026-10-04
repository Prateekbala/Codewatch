import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

import type { Config } from "../../config/schema.ts";
import { BudgetExceededError } from "../../llm/errors.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import type { Logger } from "../../logging/logger.ts";
import { loadPrompt, neutralizeTags } from "../../prompts/loader.ts";

import type { Investigator } from "./investigate.ts";
import type { Finding } from "./schema.ts";

export const VerifierOutputSchema = z.object({
  keep: z.boolean().describe("True only if the problem is real on the evidence shown"),
  reason: z.string().describe("One sentence explaining keep or drop"),
});

export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export interface VerifyFindingsResult {
  readonly kept: Finding[];
  readonly rejected: number;
  readonly hash: string;
  readonly investigated: number;
  readonly toolCalls: number;
  readonly severityRevised: number;
}

export interface VerifyOptions {
  readonly signal?: AbortSignal;
  /** Present only in agentic mode. Investigates the top-ranked findings with tools. */
  readonly investigator?: Investigator;
  readonly logger?: Logger;
}

const formatEvidence = (finding: Finding): string =>
  finding.evidence.length === 0 ? "(none)" : finding.evidence.join("\n");

export const verifyFindings = async (
  llm: LlmGateway,
  config: Config,
  findings: readonly Finding[],
  options: VerifyOptions = {},
): Promise<VerifyFindingsResult> => {
  const { signal, investigator, logger } = options;
  const llmFindings = findings.filter((finding) => finding.source === "llm");
  const deterministic = findings.filter((finding) => finding.source !== "llm");
  if (!config.review.enableVerifier || llmFindings.length === 0) {
    return {
      kept: [...findings],
      rejected: 0,
      hash: "",
      investigated: 0,
      toolCalls: 0,
      severityRevised: 0,
    };
  }

  const systemTemplate = loadPrompt("verifier.system");
  const userTemplate = loadPrompt("verifier.user");
  const system = new SystemMessage(systemTemplate.render({ language: config.language }));

  const verifyOnce = async (finding: Finding): Promise<boolean> => {
    const output = await llm.invokeStructured({
      role: "verifier",
      node: "review.verify",
      schema: VerifierOutputSchema,
      schemaName: "verifier_decision",
      messages: [
        system,
        new HumanMessage(
          userTemplate.render({
            category: finding.category,
            severity: finding.severity,
            path: finding.path,
            startLine: finding.startLine,
            endLine: finding.endLine,
            title: neutralizeTags(finding.title),
            explanation: neutralizeTags(finding.explanation),
            evidence: neutralizeTags(formatEvidence(finding)),
          }),
        ),
      ],
      ...(signal === undefined ? {} : { signal }),
    });
    return output.keep;
  };

  let investigated = 0;
  let toolCalls = 0;
  let severityRevised = 0;

  interface Decision {
    readonly keep: boolean;
    readonly finding: Finding;
  }

  // Findings arrive ranked, so the investigation budget goes to the most important ones.
  const investigationQuota =
    investigator === undefined ? 0 : Math.min(config.review.maxInvestigations, llmFindings.length);
  const investigate = async (finding: Finding): Promise<Decision> => {
    if (investigator === undefined) {
      return { keep: await verifyOnce(finding), finding };
    }
    try {
      const outcome = await investigator(finding, signal);
      investigated += 1;
      toolCalls += outcome.toolCalls;
      severityRevised += outcome.revisedSeverity ? 1 : 0;
      return { keep: outcome.keep, finding: outcome.finding };
    } catch (error) {
      if (signal?.aborted === true || error instanceof BudgetExceededError) {
        throw error;
      }
      logger?.warn({ err: error, path: finding.path }, "investigation failed; using single pass");
      return { keep: await verifyOnce(finding), finding };
    }
  };

  const decide = (finding: Finding, index: number): Promise<Decision> =>
    index < investigationQuota
      ? investigate(finding)
      : verifyOnce(finding).then((keep) => ({ keep, finding }));

  const keptLlm: Finding[] = [];
  let rejected = 0;
  const concurrency = config.review.maxConcurrency;

  for (let offset = 0; offset < llmFindings.length; offset += concurrency) {
    signal?.throwIfAborted();
    const batch = llmFindings.slice(offset, offset + concurrency);
    const decisions = await Promise.all(batch.map((finding, i) => decide(finding, offset + i)));
    for (const decision of decisions) {
      if (decision.keep) {
        keptLlm.push(decision.finding);
      } else {
        rejected += 1;
      }
    }
  }

  return {
    kept: [...deterministic, ...keptLlm],
    rejected,
    hash: systemTemplate.hash,
    investigated,
    toolCalls,
    severityRevised,
  };
};
