import { RequestError } from "@octokit/request-error";

import type { GitHubOctokit } from "./octokit.ts";
import type {
  ChangedFile,
  CheckAnnotation,
  CheckRunSummary,
  CommitSummary,
  CreateReviewInput,
  FileContent,
  FileStatus,
  Issue,
  IssueComment,
  PullRequest,
  PullRequestRef,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
} from "./types.ts";

export interface GitHubClient {
  getDefaultBranch(repo: RepoRef): Promise<string>;
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  listFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  listCommits(ref: PullRequestRef): Promise<CommitSummary[]>;
  listIssueComments(ref: PullRequestRef): Promise<IssueComment[]>;
  listReviewComments(ref: PullRequestRef): Promise<ReviewComment[]>;
  listCheckRuns(repo: RepoRef, sha: string): Promise<CheckRunSummary[]>;
  listCheckAnnotations(repo: RepoRef, checkRunId: number): Promise<CheckAnnotation[]>;
  getFileContent(repo: RepoRef, path: string, ref: string): Promise<FileContent | null>;
  updatePullRequest(ref: PullRequestRef, update: PullRequestUpdate): Promise<void>;
  createIssueComment(ref: PullRequestRef, body: string): Promise<number>;
  updateIssueComment(repo: RepoRef, commentId: number, body: string): Promise<void>;
  getIssue(repo: RepoRef, number: number): Promise<Issue | null>;
  createReview(ref: PullRequestRef, review: CreateReviewInput): Promise<number>;
  isCollaborator(repo: RepoRef, username: string): Promise<boolean>;
}

const PAGE_SIZE = 100;

const FILE_STATUSES: ReadonlySet<string> = new Set<FileStatus>([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

const toFileStatus = (status: string): FileStatus =>
  FILE_STATUSES.has(status) ? (status as FileStatus) : "changed";

const toSide = (side: string | undefined | null): "LEFT" | "RIGHT" | null =>
  side === "LEFT" || side === "RIGHT" ? side : null;

export const isNotFound = (error: unknown): boolean =>
  error instanceof RequestError && error.status === 404;

export class OctokitGitHubClient implements GitHubClient {
  readonly #octokit: GitHubOctokit;

  constructor(octokit: GitHubOctokit) {
    this.#octokit = octokit;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const { data } = await this.#octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo });
    return data.default_branch;
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    const { data } = await this.#octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    const headRepo = data.head.repo as typeof data.head.repo | null;
    return {
      ref,
      id: data.id,
      title: data.title,
      body: data.body ?? "",
      author: data.user.login,
      authorType: data.user.type,
      state: data.state,
      draft: data.draft ?? false,
      merged: data.merged,
      labels: data.labels.map((label) => label.name),
      baseRef: data.base.ref,
      baseSha: data.base.sha,
      headRef: data.head.ref,
      headSha: data.head.sha,
      headRepo: headRepo ? { owner: headRepo.owner.login, repo: headRepo.name } : null,
      defaultBranch: data.base.repo.default_branch,
      htmlUrl: data.html_url,
      changedFiles: data.changed_files,
      additions: data.additions,
      deletions: data.deletions,
      commitCount: data.commits,
    };
  }

  async listFiles(ref: PullRequestRef): Promise<ChangedFile[]> {
    const files = await this.#octokit.paginate(this.#octokit.rest.pulls.listFiles, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: PAGE_SIZE,
    });
    return files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: toFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      sha: file.sha,
    }));
  }

  async listCommits(ref: PullRequestRef): Promise<CommitSummary[]> {
    const commits = await this.#octokit.paginate(this.#octokit.rest.pulls.listCommits, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: PAGE_SIZE,
    });
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? commit.commit.author?.name ?? null,
      date: commit.commit.author?.date ?? null,
    }));
  }

  async listIssueComments(ref: PullRequestRef): Promise<IssueComment[]> {
    const comments = await this.#octokit.paginate(this.#octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: PAGE_SIZE,
    });
    return comments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? "ghost",
      authorType: comment.user?.type ?? "User",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }));
  }

  async listReviewComments(ref: PullRequestRef): Promise<ReviewComment[]> {
    const comments = await this.#octokit.paginate(this.#octokit.rest.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: PAGE_SIZE,
    });
    return comments.map((comment) => ({
      id: comment.id,
      author: comment.user.login,
      authorType: comment.user.type,
      body: comment.body,
      path: comment.path,
      line: comment.line ?? null,
      side: toSide(comment.side),
      inReplyToId: comment.in_reply_to_id ?? null,
      createdAt: comment.created_at,
    }));
  }

  async listCheckRuns(repo: RepoRef, sha: string): Promise<CheckRunSummary[]> {
    const runs = await this.#octokit.paginate(this.#octokit.rest.checks.listForRef, {
      owner: repo.owner,
      repo: repo.repo,
      ref: sha,
      per_page: PAGE_SIZE,
    });
    return runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      annotationCount: run.output.annotations_count,
    }));
  }

  async listCheckAnnotations(repo: RepoRef, checkRunId: number): Promise<CheckAnnotation[]> {
    const annotations = await this.#octokit.paginate(this.#octokit.rest.checks.listAnnotations, {
      owner: repo.owner,
      repo: repo.repo,
      check_run_id: checkRunId,
      per_page: PAGE_SIZE,
    });
    return annotations.flatMap((annotation) => {
      const level = annotation.annotation_level;
      if (
        annotation.message === null ||
        (level !== "notice" && level !== "warning" && level !== "failure")
      ) {
        return [];
      }
      return [
        {
          path: annotation.path,
          startLine: annotation.start_line,
          endLine: annotation.end_line,
          level,
          title: annotation.title,
          message: annotation.message,
        },
      ];
    });
  }

  async getFileContent(repo: RepoRef, path: string, ref: string): Promise<FileContent | null> {
    try {
      const response = await this.#octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref,
        mediaType: { format: "raw" },
      });
      const data: unknown = response.data;
      return typeof data === "string" ? { path, ref, content: data } : null;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async updatePullRequest(ref: PullRequestRef, update: PullRequestUpdate): Promise<void> {
    await this.#octokit.rest.pulls.update({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.body === undefined ? {} : { body: update.body }),
    });
  }

  async createIssueComment(ref: PullRequestRef, body: string): Promise<number> {
    const { data } = await this.#octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body,
    });
    return data.id;
  }

  async updateIssueComment(repo: RepoRef, commentId: number, body: string): Promise<void> {
    await this.#octokit.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.repo,
      comment_id: commentId,
      body,
    });
  }

  async getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
    try {
      const { data } = await this.#octokit.rest.issues.get({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
      });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        state: data.state === "closed" ? "closed" : "open",
        isPullRequest: data.pull_request !== undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async isCollaborator(repo: RepoRef, username: string): Promise<boolean> {
    try {
      await this.#octokit.rest.repos.checkCollaborator({
        owner: repo.owner,
        repo: repo.repo,
        username,
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async createReview(ref: PullRequestRef, review: CreateReviewInput): Promise<number> {
    const { data } = await this.#octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      commit_id: review.commitId,
      event: "COMMENT",
      ...(review.body === undefined ? {} : { body: review.body }),
      comments: review.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        ...(comment.startLine === undefined ? {} : { start_line: comment.startLine }),
        ...(comment.startSide === undefined ? {} : { start_side: comment.startSide }),
      })),
    });
    return data.id;
  }
}
