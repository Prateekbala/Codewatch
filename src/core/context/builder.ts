import type { Config } from "../config/schema.ts";
import type { GitHubClient } from "../github/client.ts";
import { extractFindingIds } from "../github/markers.ts";
import type {
  ChangedFile,
  CheckAnnotation,
  CheckRunSummary,
  CommitSummary,
  PullRequest,
  ReviewComment,
} from "../github/types.ts";
import type { Logger } from "../logging/logger.ts";

import { extractLinkedIssues } from "./linked-issues.ts";

export interface ReviewContext {
  readonly pr: PullRequest;
  readonly files: readonly ChangedFile[];
  readonly commits: readonly CommitSummary[];
  readonly repoRules: string;
  readonly linkedIssues: string;
  readonly ciSummary: string;
  readonly priorFindings: string;
  readonly checkAnnotations: readonly CheckAnnotation[];
}

export interface BuildContextOptions {
  readonly client: GitHubClient;
  readonly pr: PullRequest;
  readonly config: Config;
  readonly logger: Logger;
}

const REPO_RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const REPO_RULES_MAX_CHARS = 3_000;
const ISSUE_BODY_MAX_CHARS = 1_500;
const COMMENT_EXCERPT_CHARS = 160;
const MAX_ANNOTATIONS = 30;
const ANNOTATION_MESSAGE_CHARS = 200;
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

const firstLine = (text: string): string =>
  text.split("\n").find((line) => line.trim() !== "") ?? "";

const loadRepoRules = async (client: GitHubClient, pr: PullRequest): Promise<string> => {
  const repo = { owner: pr.ref.owner, repo: pr.ref.repo };
  const files = await Promise.all(
    REPO_RULES_FILES.map((path) => client.getFileContent(repo, path, pr.defaultBranch)),
  );
  const found = files.find((file) => file !== null);
  return found ? truncate(found.content.trim(), REPO_RULES_MAX_CHARS) : "";
};

const loadLinkedIssues = async (options: BuildContextOptions): Promise<string> => {
  const { client, pr, config, logger } = options;
  const references = extractLinkedIssues(
    `${pr.title}\n${pr.body}`,
    pr.ref,
    config.review.maxLinkedIssues,
  );
  const issues = await Promise.all(
    references.map(async (reference) => {
      try {
        const issue = await client.getIssue(reference.repo, reference.number);
        return issue === null || issue.isPullRequest ? null : { reference, issue };
      } catch (error) {
        logger.debug({ err: error, issue: reference.number }, "could not load linked issue");
        return null;
      }
    }),
  );
  return issues
    .flatMap((entry) => (entry === null ? [] : [entry]))
    .map(
      ({ reference, issue }) =>
        `#${reference.number} ${issue.title} (${issue.state})\n${truncate(issue.body.trim(), ISSUE_BODY_MAX_CHARS)}`,
    )
    .join("\n\n");
};

const describeRun = (run: CheckRunSummary): string =>
  `${run.name}: ${run.status}/${run.conclusion ?? "pending"}`;

const formatCi = (
  runs: readonly CheckRunSummary[],
  annotations: readonly CheckAnnotation[],
  changedPaths: ReadonlySet<string>,
): string => {
  if (runs.length === 0) {
    return "";
  }
  const problems = runs.filter(
    (run) => run.conclusion === null || !PASSING_CONCLUSIONS.has(run.conclusion),
  );
  const lines = [
    `${runs.length - problems.length} of ${runs.length} checks passed or were skipped`,
    ...problems.map(describeRun),
  ];
  const relevant = annotations
    .filter((annotation) => changedPaths.has(annotation.path) && annotation.level !== "notice")
    .slice(0, MAX_ANNOTATIONS)
    .map(
      (annotation) =>
        `${annotation.level} ${annotation.path}:${annotation.startLine} ${truncate(annotation.message, ANNOTATION_MESSAGE_CHARS)}`,
    );
  return [...lines, ...relevant].join("\n");
};

const formatPriorFindings = (comments: readonly ReviewComment[]): string =>
  comments
    .filter((comment) => extractFindingIds(comment.body).length > 0)
    .map(
      (comment) =>
        `- ${comment.path}:${comment.line ?? "?"} ${truncate(firstLine(comment.body), COMMENT_EXCERPT_CHARS)}`,
    )
    .join("\n");

export const buildReviewContext = async (options: BuildContextOptions): Promise<ReviewContext> => {
  const { client, pr } = options;
  const repo = { owner: pr.ref.owner, repo: pr.ref.repo };

  const [files, commits, reviewComments, checkRuns, repoRules, linkedIssues] = await Promise.all([
    client.listFiles(pr.ref),
    client.listCommits(pr.ref),
    client.listReviewComments(pr.ref),
    client.listCheckRuns(repo, pr.headSha),
    loadRepoRules(client, pr),
    loadLinkedIssues(options),
  ]);

  const annotationBatches = await Promise.all(
    checkRuns
      .filter((run) => run.annotationCount > 0)
      .map((run) => client.listCheckAnnotations(repo, run.id)),
  );
  const checkAnnotations = annotationBatches.flat();
  const changedPaths = new Set(files.map((file) => file.path));

  return {
    pr,
    files,
    commits,
    repoRules,
    linkedIssues,
    ciSummary: formatCi(checkRuns, checkAnnotations, changedPaths),
    priorFindings: formatPriorFindings(reviewComments),
    checkAnnotations,
  };
};
