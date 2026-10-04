export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestRef extends RepoRef {
  readonly number: number;
}

export type FileStatus =
  "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

export interface PullRequest {
  readonly ref: PullRequestRef;
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly authorType: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly labels: readonly string[];
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepo: RepoRef | null;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly commitCount: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly sha: string | null;
}

export interface CommitSummary {
  readonly sha: string;
  readonly message: string;
  readonly author: string | null;
  readonly date: string | null;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly authorType: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewComment {
  readonly id: number;
  readonly author: string;
  readonly authorType: string;
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly side: "LEFT" | "RIGHT" | null;
  readonly inReplyToId: number | null;
  readonly createdAt: string;
}

export interface CheckRunSummary {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly annotationCount: number;
}

export interface CheckAnnotation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly level: "notice" | "warning" | "failure";
  readonly title: string | null;
  readonly message: string;
}

export interface CodeSearchHit {
  readonly path: string;
  readonly fragments: readonly string[];
}

export interface FileContent {
  readonly path: string;
  readonly ref: string;
  readonly content: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly isPullRequest: boolean;
}

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly startSide?: "LEFT" | "RIGHT";
  readonly body: string;
}

export interface CreateReviewInput {
  readonly commitId: string;
  readonly body?: string;
  readonly comments: readonly InlineComment[];
}

export interface PullRequestUpdate {
  readonly title?: string;
  readonly body?: string;
}
