import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

import type { GitHubAuthConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";

const ThrottledOctokit = Octokit.plugin(throttling, retry);

export type GitHubOctokit = InstanceType<typeof ThrottledOctokit>;

const MAX_RATE_LIMIT_RETRIES = 3;

export interface OctokitOptions {
  readonly auth: GitHubAuthConfig;
  readonly logger: Logger;
  readonly installationId?: number;
  readonly userAgent?: string;
  readonly baseUrl?: string;
}

export const createOctokit = (options: OctokitOptions): GitHubOctokit => {
  const { auth, logger, installationId, userAgent = "pr-review-agent", baseUrl } = options;

  const common = {
    userAgent,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    throttle: {
      onRateLimit: (
        retryAfter: number,
        request: { method: string; url: string },
        _o: unknown,
        retryCount: number,
      ) => {
        logger.warn(
          { retryAfter, retryCount, method: request.method, url: request.url },
          "github primary rate limit",
        );
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        request: { method: string; url: string },
        _o: unknown,
        retryCount: number,
      ) => {
        logger.warn(
          { retryAfter, retryCount, method: request.method, url: request.url },
          "github secondary rate limit",
        );
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
    },
  };

  if (auth.kind === "token") {
    return new ThrottledOctokit({ ...common, auth: auth.token });
  }

  return new ThrottledOctokit({
    ...common,
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: auth.privateKey,
      ...(installationId === undefined ? {} : { installationId }),
    },
  });
};

export const createAppOctokit = (
  auth: Extract<GitHubAuthConfig, { kind: "app" }>,
  logger: Logger,
): GitHubOctokit => createOctokit({ auth, logger });
