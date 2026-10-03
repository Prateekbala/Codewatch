import type { GitHubAuthConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";

import { type GitHubClient, OctokitGitHubClient } from "./client.ts";
import { createOctokit, type GitHubOctokit } from "./octokit.ts";
import type { RepoRef } from "./types.ts";

export interface GitHubClientFactory {
  forRepo(repo: RepoRef): Promise<GitHubClient>;
  forInstallation(installationId: number): GitHubClient;
}

export class DefaultGitHubClientFactory implements GitHubClientFactory {
  readonly #auth: GitHubAuthConfig;
  readonly #logger: Logger;
  readonly #appOctokit: GitHubOctokit | null;
  readonly #installationIds = new Map<string, number>();

  constructor(auth: GitHubAuthConfig, logger: Logger) {
    this.#auth = auth;
    this.#logger = logger;
    this.#appOctokit = auth.kind === "app" ? createOctokit({ auth, logger }) : null;
  }

  async forRepo(repo: RepoRef): Promise<GitHubClient> {
    if (this.#auth.kind === "token") {
      return new OctokitGitHubClient(createOctokit({ auth: this.#auth, logger: this.#logger }));
    }
    const installationId = await this.#resolveInstallationId(repo);
    return this.forInstallation(installationId);
  }

  forInstallation(installationId: number): GitHubClient {
    const octokit = createOctokit({
      auth: this.#auth,
      logger: this.#logger,
      installationId,
    });
    return new OctokitGitHubClient(octokit);
  }

  async #resolveInstallationId(repo: RepoRef): Promise<number> {
    const key = `${repo.owner}/${repo.repo}`;
    const cached = this.#installationIds.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.#appOctokit === null) {
      throw new Error("GitHub App credentials are required to resolve installations");
    }
    const { data } = await this.#appOctokit.rest.apps.getRepoInstallation({
      owner: repo.owner,
      repo: repo.repo,
    });
    this.#installationIds.set(key, data.id);
    return data.id;
  }
}
