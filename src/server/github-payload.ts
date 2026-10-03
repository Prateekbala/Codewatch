import { z } from "zod";

const RepoSchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

const UserSchema = z.object({
  login: z.string(),
  type: z.string(),
});

const PullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number().int(),
  pull_request: z.object({
    number: z.number().int(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().optional(),
    user: UserSchema,
  }),
  repository: RepoSchema,
  installation: z.object({ id: z.number().int() }).optional(),
});

const IssueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  issue: z.object({
    number: z.number().int(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string(),
    user: UserSchema,
  }),
  repository: RepoSchema,
  installation: z.object({ id: z.number().int() }).optional(),
});

export type PullRequestWebhook = z.infer<typeof PullRequestPayloadSchema>;
export type IssueCommentWebhook = z.infer<typeof IssueCommentPayloadSchema>;

export const parsePullRequestWebhook = (payload: unknown): PullRequestWebhook | null => {
  const parsed = PullRequestPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

export const parseIssueCommentWebhook = (payload: unknown): IssueCommentWebhook | null => {
  const parsed = IssueCommentPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

export const pullRequestRefFromWebhook = (
  event: PullRequestWebhook,
): { owner: string; repo: string; number: number } => ({
  owner: event.repository.owner.login,
  repo: event.repository.name,
  number: event.pull_request.number,
});

export const issueCommentRefFromWebhook = (
  event: IssueCommentWebhook,
): { owner: string; repo: string; number: number } => ({
  owner: event.repository.owner.login,
  repo: event.repository.name,
  number: event.issue.number,
});

export const runKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;
