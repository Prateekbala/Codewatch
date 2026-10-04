import type { GitHubClient } from "../src/core/github/client.ts";
import type {
  ChangedFile,
  CheckAnnotation,
  CheckRunSummary,
  CodeSearchHit,
  CommitSummary,
  FileContent,
  Issue,
  IssueComment,
  PullRequest,
  ReviewComment,
} from "../src/core/github/types.ts";

import type { EvalCase } from "./types.ts";

const REF = { owner: "eval", repo: "fixtures", number: 1 } as const;

const additions = (patch: string): number =>
  patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;

const deletions = (patch: string): number =>
  patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

export const pullRequestFromCase = (item: EvalCase): PullRequest => ({
  ref: REF,
  id: 1,
  title: item.pr.title,
  body: item.pr.body,
  author: item.pr.author,
  authorType: "User",
  state: "open",
  draft: false,
  merged: false,
  labels: [],
  baseRef: "main",
  baseSha: "base",
  headRef: "feature",
  headSha: "head",
  headRepo: { owner: REF.owner, repo: REF.repo },
  defaultBranch: "main",
  htmlUrl: `https://github.com/${REF.owner}/${REF.repo}/pull/1`,
  changedFiles: item.files.length,
  additions: item.files.reduce((sum, file) => sum + additions(file.patch), 0),
  deletions: item.files.reduce((sum, file) => sum + deletions(file.patch), 0),
  commitCount: item.commits.length,
});

export class MemoryGitHubClient implements GitHubClient {
  readonly #case: EvalCase;
  readonly #pr: PullRequest;

  constructor(item: EvalCase) {
    this.#case = item;
    this.#pr = pullRequestFromCase(item);
  }

  get pullRequest(): PullRequest {
    return this.#pr;
  }

  getDefaultBranch(): Promise<string> {
    return Promise.resolve("main");
  }

  getPullRequest(): Promise<PullRequest> {
    return Promise.resolve(this.#pr);
  }

  listFiles(): Promise<ChangedFile[]> {
    return Promise.resolve(
      this.#case.files.map((file) => ({
        path: file.path,
        previousPath: null,
        status: file.status,
        additions: additions(file.patch),
        deletions: deletions(file.patch),
        patch: file.patch,
        sha: null,
      })),
    );
  }

  listCommits(): Promise<CommitSummary[]> {
    return Promise.resolve(
      this.#case.commits.map((message, index) => ({
        sha: `c${index}`,
        message,
        author: this.#case.pr.author,
        date: null,
      })),
    );
  }

  listIssueComments(): Promise<IssueComment[]> {
    return Promise.resolve([]);
  }

  listReviewComments(): Promise<ReviewComment[]> {
    return Promise.resolve([]);
  }

  listCheckRuns(): Promise<CheckRunSummary[]> {
    return Promise.resolve([]);
  }

  listCheckAnnotations(): Promise<CheckAnnotation[]> {
    return Promise.resolve([]);
  }

  getFileContent(_repo: unknown, path: string, ref: string): Promise<FileContent | null> {
    const content = this.#case.contents[path];
    return Promise.resolve(content === undefined ? null : { path, ref, content });
  }

  listTree(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.#case.contents));
  }

  searchCode(_repo: unknown, query: string, limit: number): Promise<CodeSearchHit[]> {
    return Promise.resolve(
      Object.entries(this.#case.contents)
        .filter(([, content]) => content.includes(query))
        .slice(0, limit)
        .map(([path]) => ({ path, fragments: [] })),
    );
  }

  getIssue(): Promise<Issue | null> {
    return Promise.resolve(null);
  }

  updatePullRequest(): Promise<void> {
    return Promise.reject(new Error("evals are read-only"));
  }

  createIssueComment(): Promise<number> {
    return Promise.reject(new Error("evals are read-only"));
  }

  updateIssueComment(): Promise<void> {
    return Promise.reject(new Error("evals are read-only"));
  }

  createReview(): Promise<number> {
    return Promise.reject(new Error("evals are read-only"));
  }

  isCollaborator(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
