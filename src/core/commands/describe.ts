import type { DescribeResult } from "../graph/describe/graph.ts";
import type { GitHubClient } from "../github/client.ts";
import { upsertManagedSection } from "../github/markers.ts";
import type { PullRequest } from "../github/types.ts";

export interface PublishDescribeOptions {
  readonly updateTitle: boolean;
}

export const publishDescribe = async (
  client: GitHubClient,
  stale: PullRequest,
  result: DescribeResult,
  options: PublishDescribeOptions,
): Promise<boolean> => {
  const current = await client.getPullRequest(stale.ref);
  const body = upsertManagedSection(current.body, result.sectionId, result.sectionBody);
  const title = options.updateTitle && result.title !== current.title ? result.title : undefined;

  if (body === current.body && title === undefined) {
    return false;
  }

  await client.updatePullRequest(current.ref, {
    ...(body === current.body ? {} : { body }),
    ...(title === undefined ? {} : { title }),
  });
  return true;
};
