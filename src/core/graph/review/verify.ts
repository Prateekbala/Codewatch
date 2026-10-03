import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

import type { Config } from "../../config/schema.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import { loadPrompt, neutralizeTags } from "../../prompts/loader.ts";

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
}

const formatEvidence = (finding: Finding): string =>
  finding.evidence.length === 0 ? "(none)" : finding.evidence.join("\n");

export const verifyFindings = async (
  llm: LlmGateway,
  config: Config,
  findings: readonly Finding[],
  signal?: AbortSignal,
): Promise<VerifyFindingsResult> => {
  const llmFindings = findings.filter((finding) => finding.source === "llm");
  const deterministic = findings.filter((finding) => finding.source !== "llm");
  if (!config.review.enableVerifier || llmFindings.length === 0) {
    return { kept: [...findings], rejected: 0, hash: "" };
  }

  const systemTemplate = loadPrompt("verifier.system");
  const userTemplate = loadPrompt("verifier.user");
  const system = new SystemMessage(systemTemplate.render({ language: config.language }));

  const keptLlm: Finding[] = [];
  let rejected = 0;
  const concurrency = config.review.maxConcurrency;

  for (let offset = 0; offset < llmFindings.length; offset += concurrency) {
    if (signal?.aborted === true) {
      throw new Error("aborted");
    }
    const batch = llmFindings.slice(offset, offset + concurrency);
    const decisions = await Promise.all(
      batch.map(async (finding) => {
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
        return { finding, output };
      }),
    );
    for (const { finding, output } of decisions) {
      if (output.keep) {
        keptLlm.push(finding);
      } else {
        rejected += 1;
      }
    }
  }

  return {
    kept: [...deterministic, ...keptLlm],
    rejected,
    hash: systemTemplate.hash,
  };
};
