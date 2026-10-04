import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import type {
  ChatModelAdapterFactory,
  StructuredCallResult,
  ToolStepResult,
} from "../../src/core/llm/adapters.ts";
import { resolveConfigStrict } from "../../src/core/config/loader.ts";
import type { Config } from "../../src/core/config/schema.ts";
import type { GitHubClient } from "../../src/core/github/client.ts";
import type {
  ChangedFile,
  CheckAnnotation,
  CheckRunSummary,
  CodeSearchHit,
  CommitSummary,
  CreateReviewInput,
  FileContent,
  Issue,
  IssueComment,
  PullRequest,
  PullRequestRef,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
} from "../../src/core/github/types.ts";
import { createLogger } from "../../src/core/logging/logger.ts";

export const silentLogger = createLogger({ level: "silent" });

export const testConfig = (overrides: unknown = {}): Config =>
  resolveConfigStrict([{ name: "cli", source: "test", value: overrides }]);

export type ScriptStep =
  | {
      readonly parsed: unknown;
      readonly usage?: { inputTokens: number; outputTokens: number } | null;
    }
  | { readonly error: Error }
  | { readonly hang: true }
  | {
      /** A tool-enabled turn: requested calls, or just `text` to stop calling tools. */
      readonly tools: readonly { name: string; args: Record<string, unknown> }[];
      readonly text?: string;
    };

export interface RecordedCall {
  readonly model: string;
  readonly schemaName: string;
  readonly messages: readonly BaseMessage[];
}

export class ScriptedLlm {
  readonly calls: RecordedCall[] = [];
  readonly #scripts: Map<string, ScriptStep[]>;

  constructor(scripts: Record<string, ScriptStep[]>) {
    this.#scripts = new Map(Object.entries(scripts).map(([model, steps]) => [model, [...steps]]));
  }

  readonly factory: ChatModelAdapterFactory = (spec) => ({
    spec,
    structured: (_schema, name) => ({
      invoke: async (messages, options): Promise<StructuredCallResult> => {
        this.calls.push({ model: spec.model, schemaName: name, messages });
        const step = this.#scripts.get(spec.model)?.shift();
        if (!step) {
          throw new Error(`no scripted response left for ${spec.model}`);
        }
        if ("error" in step) {
          throw step.error;
        }
        if ("hang" in step) {
          await new Promise<never>((_, reject) => {
            options.signal?.addEventListener("abort", () => {
              reject(options.signal?.reason as Error);
            });
          });
        }
        if (!("parsed" in step)) {
          throw new Error("scripted tool turn consumed by a structured call");
        }
        return {
          parsed: step.parsed,
          usage: step.usage === undefined ? { inputTokens: 100, outputTokens: 50 } : step.usage,
        };
      },
    }),
    withTools: () => ({
      // eslint-disable-next-line @typescript-eslint/require-await
      invoke: async (messages): Promise<ToolStepResult> => {
        this.calls.push({ model: spec.model, schemaName: "tools", messages });
        const step = this.#scripts.get(spec.model)?.shift();
        if (!step) {
          throw new Error(`no scripted response left for ${spec.model}`);
        }
        if ("error" in step) {
          throw step.error;
        }
        if (!("tools" in step)) {
          throw new Error("scripted structured step consumed by a tool turn");
        }
        const toolCalls = step.tools.map((call, index) => ({
          id: `call_${this.calls.length}_${index}`,
          name: call.name,
          args: call.args,
        }));
        return {
          message: new AIMessage({
            content: step.text ?? "",
            tool_calls: toolCalls.map((call) => ({ ...call, type: "tool_call" as const })),
          }),
          text: step.text ?? "",
          toolCalls,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    }),
  });
}

export const fakePullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  ref: { owner: "acme", repo: "widgets", number: 5 },
  id: 1,
  title: "wip",
  body: "Original author notes",
  author: "octo",
  authorType: "User",
  state: "open",
  draft: false,
  merged: false,
  labels: [],
  baseRef: "main",
  baseSha: "base-sha",
  headRef: "feature",
  headSha: "head-sha",
  headRepo: { owner: "acme", repo: "widgets" },
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/widgets/pull/5",
  changedFiles: 1,
  additions: 1,
  deletions: 1,
  commitCount: 1,
  ...overrides,
});

export interface FakeGitHubData {
  pr: PullRequest;
  files: ChangedFile[];
  commits: CommitSummary[];
  contents: Record<string, string>;
  issues: Record<number, Issue>;
  issueComments: IssueComment[];
  reviewComments: ReviewComment[];
  checkRuns: CheckRunSummary[];
  annotations: CheckAnnotation[];
}

export class FakeGitHubClient implements GitHubClient {
  readonly updates: PullRequestUpdate[] = [];
  readonly comments: string[] = [];
  readonly reviews: CreateReviewInput[] = [];
  readonly updatedComments: { id: number; body: string }[] = [];
  failNextReviewWith: Error | null = null;
  readonly data: FakeGitHubData;

  constructor(data: Partial<FakeGitHubData> = {}) {
    this.data = {
      pr: data.pr ?? fakePullRequest(),
      files: data.files ?? [],
      commits: data.commits ?? [],
      contents: data.contents ?? {},
      issues: data.issues ?? {},
      issueComments: data.issueComments ?? [],
      reviewComments: data.reviewComments ?? [],
      checkRuns: data.checkRuns ?? [],
      annotations: data.annotations ?? [],
    };
  }

  getDefaultBranch(): Promise<string> {
    return Promise.resolve(this.data.pr.defaultBranch);
  }

  getPullRequest(_ref: PullRequestRef): Promise<PullRequest> {
    return Promise.resolve(this.data.pr);
  }

  listFiles(): Promise<ChangedFile[]> {
    return Promise.resolve(this.data.files);
  }

  listCommits(): Promise<CommitSummary[]> {
    return Promise.resolve(this.data.commits);
  }

  listIssueComments(): Promise<IssueComment[]> {
    return Promise.resolve(this.data.issueComments);
  }

  listReviewComments(): Promise<ReviewComment[]> {
    return Promise.resolve(this.data.reviewComments);
  }

  listCheckRuns(): Promise<CheckRunSummary[]> {
    return Promise.resolve(this.data.checkRuns);
  }

  listCheckAnnotations(): Promise<CheckAnnotation[]> {
    return Promise.resolve(this.data.annotations);
  }

  listTree(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.data.contents));
  }

  searchCode(_repo: RepoRef, query: string, limit: number): Promise<CodeSearchHit[]> {
    return Promise.resolve(
      Object.entries(this.data.contents)
        .filter(([, content]) => content.includes(query))
        .slice(0, limit)
        .map(([path]) => ({ path, fragments: [] })),
    );
  }

  getIssue(_repo: RepoRef, number: number): Promise<Issue | null> {
    return Promise.resolve(this.data.issues[number] ?? null);
  }

  updateIssueComment(_repo: RepoRef, commentId: number, body: string): Promise<void> {
    this.updatedComments.push({ id: commentId, body });
    this.data.issueComments = this.data.issueComments.map((comment) =>
      comment.id === commentId ? { ...comment, body } : comment,
    );
    return Promise.resolve();
  }

  createReview(_ref: PullRequestRef, review: CreateReviewInput): Promise<number> {
    if (this.failNextReviewWith) {
      const error = this.failNextReviewWith;
      this.failNextReviewWith = null;
      return Promise.reject(error);
    }
    this.reviews.push(review);
    return Promise.resolve(this.reviews.length);
  }

  getFileContent(_repo: RepoRef, path: string, ref: string): Promise<FileContent | null> {
    const content = this.data.contents[path];
    return Promise.resolve(content === undefined ? null : { path, ref, content });
  }

  updatePullRequest(_ref: PullRequestRef, update: PullRequestUpdate): Promise<void> {
    this.updates.push(update);
    this.data.pr = {
      ...this.data.pr,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.body === undefined ? {} : { body: update.body }),
    };
    return Promise.resolve();
  }

  isCollaborator(_repo: RepoRef, _username: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  createIssueComment(_ref: PullRequestRef, body: string): Promise<number> {
    this.comments.push(body);
    const id = 1000 + this.comments.length;
    this.data.issueComments = [
      ...this.data.issueComments,
      {
        id,
        author: "pr-agent[bot]",
        authorType: "Bot",
        body,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    return Promise.resolve(id);
  }
}
