import { type ConfigLayer, REPO_CONFIG_PATH, repoConfigLayer } from "../config/loader.ts";
import type { GitHubClient } from "../github/client.ts";
import type { RepoRef } from "../github/types.ts";

export const loadRepoConfigLayer = async (
  client: GitHubClient,
  repo: RepoRef,
  defaultBranch: string,
): Promise<ConfigLayer | null> => {
  const file = await client.getFileContent(repo, REPO_CONFIG_PATH, defaultBranch);
  return repoConfigLayer(file?.content ?? null);
};
