import { RequestError } from "@octokit/request-error";

import { toFileDiff } from "../diff/classify.ts";
import { DiffLineIndex } from "../diff/line-index.ts";
import { formatInlineComment, formatReview, REVIEW_SECTION_ID } from "../graph/review/format.ts";
import type { Finding, ReviewResult } from "../graph/review/schema.ts";
import type { CostSummary } from "../llm/cost.ts";
import type { GitHubClient } from "../github/client.ts";
import { extractFindingIds, hasManagedSection, upsertManagedSection } from "../github/markers.ts";
import type { InlineComment, PullRequest } from "../github/types.ts";

export interface PublishReviewOptions {
  readonly maxInlineComments: number;
  readonly usage?: CostSummary;
}

export type PublishStatus = "published" | "stale" | "unchanged";

export interface PublishReviewOutcome {
  readonly status: PublishStatus;
  readonly inlineCount: number;
  readonly summaryCommentId: number | null;
}

const toInlineComment = (finding: Finding): InlineComment => ({
  path: finding.path,
  line: finding.endLine,
  side: finding.side,
  ...(finding.endLine > finding.startLine
    ? { startLine: finding.startLine, startSide: finding.side }
    : {}),
  body: formatInlineComment(finding),
});

const isUnprocessable = (error: unknown): boolean =>
  error instanceof RequestError && error.status === 422;

export const publishReview = async (
  client: GitHubClient,
  stale: PullRequest,
  result: ReviewResult,
  options: PublishReviewOptions,
): Promise<PublishReviewOutcome> => {
  const current = await client.getPullRequest(stale.ref);
  if (current.headSha !== stale.headSha) {
    return { status: "stale", inlineCount: 0, summaryCommentId: null };
  }

  const [files, reviewComments, issueComments] = await Promise.all([
    client.listFiles(stale.ref),
    client.listReviewComments(stale.ref),
    client.listIssueComments(stale.ref),
  ]);

  const sticky = issueComments.find((comment) =>
    hasManagedSection(comment.body, REVIEW_SECTION_ID),
  );
  const previouslyInline = new Set(
    reviewComments.flatMap((comment) => extractFindingIds(comment.body)),
  );
  const alreadyReported = new Set([
    ...previouslyInline,
    ...(sticky === undefined ? [] : extractFindingIds(sticky.body)),
  ]);

  const fresh = result.findings.filter((finding) => !alreadyReported.has(finding.id));
  const indexes = new Map(
    files.map((file) => [file.path, new DiffLineIndex(toFileDiff(file).hunks)]),
  );
  const anchorable = fresh.filter(
    (finding) =>
      indexes.get(finding.path)?.validateRange({
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
      }).valid === true,
  );

  const selected = anchorable.slice(0, options.maxInlineComments);
  let inlineIds = new Set(selected.map((finding) => finding.id));

  if (selected.length > 0) {
    try {
      await client.createReview(stale.ref, {
        commitId: stale.headSha,
        comments: selected.map(toInlineComment),
      });
    } catch (error) {
      if (!isUnprocessable(error)) {
        throw error;
      }
      inlineIds = new Set();
    }
  }

  const body = formatReview({
    summary: result.summary,
    findings: result.findings,
    notices: result.notices,
    inlineIds: new Set([...previouslyInline, ...inlineIds]),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });

  let summaryCommentId: number | null = sticky?.id ?? null;
  if (sticky === undefined) {
    summaryCommentId = await client.createIssueComment(
      stale.ref,
      upsertManagedSection("", REVIEW_SECTION_ID, body),
    );
  } else {
    const next = upsertManagedSection(sticky.body, REVIEW_SECTION_ID, body);
    if (next !== sticky.body) {
      await client.updateIssueComment(stale.ref, sticky.id, next);
    }
  }

  return { status: "published", inlineCount: inlineIds.size, summaryCommentId };
};
