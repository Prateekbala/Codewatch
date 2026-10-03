import { runCommand } from "../core/commands/run.ts";
import type { CommandName } from "../core/commands/run.ts";
import type { GitHubClient } from "../core/github/client.ts";
import type { PullRequestRef } from "../core/github/types.ts";
import type { Logger } from "../core/logging/logger.ts";
import type { Runtime } from "../core/runtime.ts";

import type { RunSupervisor } from "./run-supervisor.ts";
import { runKey } from "./github-payload.ts";

export interface RunPullRequestJob {
  readonly ref: PullRequestRef;
  readonly headSha: string;
  readonly installationId: number;
  readonly command: CommandName;
  readonly reason: string;
}

export const runPullRequestJob = async (
  runtime: Runtime,
  supervisor: RunSupervisor,
  client: GitHubClient,
  job: RunPullRequestJob,
  logger: Logger,
): Promise<void> => {
  const key = runKey(job.ref.owner, job.ref.repo, job.ref.number);
  const signal = supervisor.start(key, job.headSha);
  try {
    logger.info({ job, key }, "starting pull request job");
    await runCommand(runtime, job.ref, job.command, {
      dryRun: false,
      client,
      signal,
      ...(job.command === "describe" ? { updateTitle: false } : {}),
    });
  } catch (error) {
    if (signal.aborted) {
      logger.info({ key, headSha: job.headSha }, "pull request job aborted");
      return;
    }
    logger.error({ err: error, job }, "pull request job failed");
  } finally {
    supervisor.finish(key, job.headSha);
  }
};
