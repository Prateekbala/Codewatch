import type { DescribeOutcome, ReviewOutcome } from "../core/commands/run.ts";
import type { ConfigIssue } from "../core/config/loader.ts";
import { formatReview } from "../core/graph/review/format.ts";
import type { CostSummary } from "../core/llm/cost.ts";

const formatCost = (usage: CostSummary): string =>
  usage.unpricedModels.length > 0
    ? "cost unknown (no pricing configured)"
    : `$${usage.costUsd.toFixed(4)}`;

export const formatIssues = (issues: readonly ConfigIssue[]): string =>
  issues
    .map(
      (issue) =>
        `Ignored ${issue.layer} configuration (${issue.source}):\n${issue.messages
          .map((message) => `  - ${message}`)
          .join("\n")}`,
    )
    .join("\n");

export const describeOutcomeToJson = (outcome: DescribeOutcome): Record<string, unknown> => {
  const { describe, pr, usage } = outcome;
  return {
    runId: outcome.runId,
    command: outcome.command,
    pullRequest: {
      repository: `${pr.ref.owner}/${pr.ref.repo}`,
      number: pr.ref.number,
      headSha: pr.headSha,
      url: pr.htmlUrl,
    },
    dryRun: outcome.dryRun,
    published: outcome.published,
    title: describe.title,
    type: describe.output.type,
    summary: describe.output.summary,
    walkthrough: describe.output.walkthrough,
    risks: describe.output.risks,
    markdown: describe.sectionBody,
    diff: {
      included: describe.prepared.included.length,
      omitted: describe.prepared.omitted,
      ignored: describe.prepared.ignored.length,
      tokens: describe.prepared.tokens,
      budget: describe.prepared.budget,
    },
    promptHashes: describe.promptHashes,
    usage,
    configIssues: outcome.configIssues,
    durationMs: outcome.durationMs,
  };
};

export const describeOutcomeToText = (outcome: DescribeOutcome): string => {
  const { describe, usage } = outcome;
  const cost = formatCost(usage);
  const status = outcome.dryRun
    ? "dry run, nothing was written"
    : outcome.published
      ? "pull request updated"
      : "pull request already up to date";
  return [
    `Title: ${describe.title}`,
    "",
    describe.sectionBody,
    "",
    "---",
    `${status} | ${usage.totalTokens} tokens (${usage.inputTokens} in, ${usage.outputTokens} out) | ${cost} | ${outcome.durationMs}ms`,
  ].join("\n");
};

export const reviewOutcomeToJson = (outcome: ReviewOutcome): Record<string, unknown> => {
  const { review, pr, usage } = outcome;
  return {
    runId: outcome.runId,
    command: outcome.command,
    pullRequest: {
      repository: `${pr.ref.owner}/${pr.ref.repo}`,
      number: pr.ref.number,
      headSha: pr.headSha,
      url: pr.htmlUrl,
    },
    dryRun: outcome.dryRun,
    published: outcome.published,
    publish: outcome.publish,
    summary: review.summary,
    findings: review.findings,
    notices: review.notices,
    stats: review.stats,
    promptHashes: review.promptHashes,
    models: {
      reviewer: outcome.models.reviewer,
      summarizer: outcome.models.summarizer,
    },
    usage,
    configIssues: outcome.configIssues,
    durationMs: outcome.durationMs,
  };
};

export const reviewOutcomeToText = (outcome: ReviewOutcome): string => {
  const { review, usage, publish } = outcome;
  const status = outcome.dryRun
    ? "dry run, nothing was posted"
    : publish?.status === "stale"
      ? "skipped, the pull request changed during the review"
      : `posted ${publish?.inlineCount ?? 0} inline comment(s) and the summary`;
  return [
    formatReview({
      summary: review.summary,
      findings: review.findings,
      notices: review.notices,
      inlineIds: new Set(),
    }),
    "",
    "---",
    `${status} | ${review.findings.length} finding(s) | ${usage.totalTokens} tokens (${usage.inputTokens} in, ${usage.outputTokens} out) | ${formatCost(usage)} | ${outcome.durationMs}ms`,
  ].join("\n");
};
