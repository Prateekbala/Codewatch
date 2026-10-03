import { loadRepoConfigLayer } from "../context/repo-config.ts";
import { type ConfigIssue, type ConfigLayer, resolveConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import { type DescribeResult, runDescribe } from "../graph/describe/graph.ts";
import { runReview } from "../graph/review/graph.ts";
import type { ReviewResult } from "../graph/review/schema.ts";
import type { GitHubClient } from "../github/client.ts";
import type { PullRequest, PullRequestRef } from "../github/types.ts";
import { type CostSummary, CostTracker } from "../llm/cost.ts";
import { LlmGateway } from "../llm/gateway.ts";
import { newRunId, withRunContext } from "../logging/logger.ts";
import type { Runtime } from "../runtime.ts";
import type { CoreServices } from "../services.ts";

import { publishDescribe } from "./describe.ts";
import { type PublishReviewOutcome, publishReview } from "./review.ts";

export type CommandName = "describe" | "review";

export interface RunCommandOptions {
  readonly dryRun: boolean;
  readonly updateTitle?: boolean;
  readonly cliLayer?: ConfigLayer;
  readonly signal?: AbortSignal;
  readonly client?: GitHubClient;
}

interface OutcomeBase {
  readonly runId: string;
  readonly pr: PullRequest;
  readonly dryRun: boolean;
  readonly published: boolean;
  readonly usage: CostSummary;
  readonly models: Config["models"];
  readonly configIssues: readonly ConfigIssue[];
  readonly durationMs: number;
}

export interface DescribeOutcome extends OutcomeBase {
  readonly command: "describe";
  readonly describe: DescribeResult;
}

export interface ReviewOutcome extends OutcomeBase {
  readonly command: "review";
  readonly review: ReviewResult;
  readonly publish: PublishReviewOutcome | null;
}

export type CommandOutcome = DescribeOutcome | ReviewOutcome;

type HandlerResult =
  | { readonly command: "describe"; readonly describe: DescribeResult; readonly published: boolean }
  | {
      readonly command: "review";
      readonly review: ReviewResult;
      readonly publish: PublishReviewOutcome | null;
      readonly published: boolean;
    };

interface HandlerContext {
  readonly services: CoreServices;
  readonly pr: PullRequest;
  readonly options: RunCommandOptions;
  readonly tracker: CostTracker;
}

const executeDescribe = async ({
  services,
  pr,
  options,
}: HandlerContext): Promise<HandlerResult> => {
  const describe = await runDescribe(services, pr, options.signal);
  const published = options.dryRun
    ? false
    : await publishDescribe(services.github, pr, describe, {
        updateTitle: options.updateTitle ?? services.config.describe.updateTitle,
      });
  return { command: "describe", describe, published };
};

const executeReview = async ({
  services,
  pr,
  options,
  tracker,
}: HandlerContext): Promise<HandlerResult> => {
  const review = await runReview(services, pr, options.signal);
  const publish = options.dryRun
    ? null
    : await publishReview(services.github, pr, review, {
        maxInlineComments: services.config.review.maxInlineComments,
        usage: tracker.summary(),
      });
  return { command: "review", review, publish, published: publish?.status === "published" };
};

const COMMAND_HANDLERS: Record<CommandName, (context: HandlerContext) => Promise<HandlerResult>> = {
  describe: executeDescribe,
  review: executeReview,
};

const collectLayers = (
  runtime: Runtime,
  repoLayer: ConfigLayer | null,
  cliLayer: ConfigLayer | undefined,
): ConfigLayer[] => [
  ...runtime.baseLayers,
  ...(repoLayer ? [repoLayer] : []),
  ...(cliLayer ? [cliLayer] : []),
];

export function runCommand(
  runtime: Runtime,
  ref: PullRequestRef,
  command: "describe",
  options: RunCommandOptions,
): Promise<DescribeOutcome>;
export function runCommand(
  runtime: Runtime,
  ref: PullRequestRef,
  command: "review",
  options: RunCommandOptions,
): Promise<ReviewOutcome>;
export function runCommand(
  runtime: Runtime,
  ref: PullRequestRef,
  command: CommandName,
  options: RunCommandOptions,
): Promise<CommandOutcome>;
export async function runCommand(
  runtime: Runtime,
  ref: PullRequestRef,
  command: CommandName,
  options: RunCommandOptions,
): Promise<CommandOutcome> {
  const startedAt = performance.now();
  const runId = newRunId();
  const client = options.client ?? (await runtime.github.forRepo(ref));
  const pr = await client.getPullRequest(ref);

  const logger = withRunContext(runtime.logger, {
    runId,
    repo: `${ref.owner}/${ref.repo}`,
    prNumber: ref.number,
    headSha: pr.headSha,
  });

  const repoLayer = await loadRepoConfigLayer(client, ref, pr.defaultBranch);
  const resolved = resolveConfig(collectLayers(runtime, repoLayer, options.cliLayer));
  for (const issue of resolved.issues) {
    logger.warn({ layer: issue.layer, messages: issue.messages }, "configuration layer ignored");
  }

  const config: Config = resolved.config;
  const tracker = CostTracker.fromConfig(config);
  const llm = new LlmGateway({
    config,
    tracker,
    adapterFactory: runtime.adapterFactory,
    logger,
  });
  const services: CoreServices = {
    github: client,
    llm,
    config,
    logger,
    counter: runtime.counter,
  };

  const handler = COMMAND_HANDLERS[command];
  const result = await handler({ services, pr, options, tracker });
  const usage = tracker.summary();
  logger.info(
    { command, published: result.published, dryRun: options.dryRun, usage },
    "command completed",
  );

  const base: OutcomeBase = {
    runId,
    pr,
    dryRun: options.dryRun,
    published: result.published,
    usage,
    models: config.models,
    configIssues: resolved.issues,
    durationMs: Math.round(performance.now() - startedAt),
  };
  return result.command === "describe"
    ? { ...base, command: "describe", describe: result.describe }
    : { ...base, command: "review", review: result.review, publish: result.publish };
}
