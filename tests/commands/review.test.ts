import { RequestError } from "@octokit/request-error";
import { describe, expect, it } from "vitest";

import { publishReview } from "../../src/core/commands/review.ts";
import { runCommand } from "../../src/core/commands/run.ts";
import { loadEnv } from "../../src/core/config/env.ts";
import { formatInlineComment, REVIEW_SECTION_ID } from "../../src/core/graph/review/format.ts";
import type { ReviewResult } from "../../src/core/graph/review/schema.ts";
import { wrapManagedSection } from "../../src/core/github/markers.ts";
import { charEstimateCounter } from "../../src/core/llm/tokens.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { FakeGitHubClient, ScriptedLlm, fakePullRequest, silentLogger } from "../helpers/fakes.ts";
import { changedFile } from "../helpers/fixtures.ts";
import { emptyStats, finding, llmFinding, summaryOutput } from "../helpers/review.ts";

const ref = { owner: "acme", repo: "widgets", number: 5 };

const patch = "@@ -1,5 +1,5 @@\n a\n-old\n+new\n c\n d\n e";

const files = [changedFile({ path: "src/auth.ts", patch })];

const resultWith = (findings: ReviewResult["findings"]): ReviewResult => ({
  findings,
  summary: {
    overview: "Overview.",
    riskLevel: "high",
    highlights: [],
    fileGroups: [],
  },
  notices: [],
  stats: emptyStats,
  promptHashes: { reviewSystem: "a", reviewUser: "b", summarySystem: "c", summaryUser: "d" },
});

const unprocessable = (): RequestError =>
  new RequestError("Unprocessable", 422, {
    request: { method: "POST", url: "https://api.github.com", headers: {} },
  });

describe("publishReview", () => {
  it("posts inline comments up to the cap and lists the rest in the summary", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });
    const pr = client.data.pr;
    const findings = [
      finding({ title: "First", startLine: 2, endLine: 2 }),
      finding({ title: "Second", category: "bug", startLine: 3, endLine: 3 }),
    ];

    const outcome = await publishReview(client, pr, resultWith(findings), {
      maxInlineComments: 1,
    });

    expect(outcome.status).toBe("published");
    expect(outcome.inlineCount).toBe(1);
    expect(client.reviews).toHaveLength(1);
    expect(client.reviews[0]?.commitId).toBe(pr.headSha);
    expect(client.reviews[0]?.comments).toEqual([
      expect.objectContaining({ path: "src/auth.ts", line: 2, side: "RIGHT" }),
    ]);
    const summary = client.comments[0] ?? "";
    expect(summary).toContain(`pr-agent:${REVIEW_SECTION_ID}:start`);
    expect(summary).toContain("Additional findings (1)");
    expect(summary).toContain("Second");
  });

  it("uses a multi-line range when the finding spans lines", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });

    await publishReview(
      client,
      client.data.pr,
      resultWith([finding({ startLine: 2, endLine: 3 })]),
      { maxInlineComments: 5 },
    );

    expect(client.reviews[0]?.comments[0]).toMatchObject({
      line: 3,
      startLine: 2,
      startSide: "RIGHT",
    });
  });

  it("does not anchor findings outside the diff and keeps them in the summary", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });

    const outcome = await publishReview(
      client,
      client.data.pr,
      resultWith([finding({ startLine: 40, endLine: 40, title: "Far away" })]),
      { maxInlineComments: 5 },
    );

    expect(outcome.inlineCount).toBe(0);
    expect(client.reviews).toEqual([]);
    expect(client.comments[0]).toContain("Far away");
  });

  it("skips findings already posted inline and updates the sticky comment in place", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });
    const existing = finding({ title: "Seen" });
    const fresh = finding({ title: "New", category: "bug", startLine: 3, endLine: 3 });
    client.data.reviewComments = [
      {
        id: 1,
        author: "bot",
        authorType: "Bot",
        body: formatInlineComment(existing),
        path: "src/auth.ts",
        line: 2,
        side: "RIGHT",
        inReplyToId: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    client.data.issueComments = [
      {
        id: 77,
        author: "bot",
        authorType: "Bot",
        body: wrapManagedSection(REVIEW_SECTION_ID, "old"),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const outcome = await publishReview(client, client.data.pr, resultWith([existing, fresh]), {
      maxInlineComments: 5,
    });

    expect(outcome.inlineCount).toBe(1);
    expect(client.reviews[0]?.comments).toHaveLength(1);
    expect(client.comments).toEqual([]);
    expect(client.updatedComments).toHaveLength(1);
    expect(client.updatedComments[0]?.id).toBe(77);
  });

  it("does nothing when the head moved during the review", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest({ headSha: "newer" }), files });

    const outcome = await publishReview(
      client,
      fakePullRequest({ headSha: "older" }),
      resultWith([finding()]),
      { maxInlineComments: 5 },
    );

    expect(outcome.status).toBe("stale");
    expect(client.reviews).toEqual([]);
    expect(client.comments).toEqual([]);
  });

  it("falls back to the summary when GitHub rejects the inline review", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });
    client.failNextReviewWith = unprocessable();

    const outcome = await publishReview(
      client,
      client.data.pr,
      resultWith([finding({ title: "Still visible" })]),
      { maxInlineComments: 5 },
    );

    expect(outcome.inlineCount).toBe(0);
    expect(client.comments[0]).toContain("Still visible");
  });

  it("rethrows other API failures", async () => {
    const client = new FakeGitHubClient({ pr: fakePullRequest(), files });
    client.failNextReviewWith = new Error("network down");

    await expect(
      publishReview(client, client.data.pr, resultWith([finding()]), { maxInlineComments: 5 }),
    ).rejects.toThrow("network down");
  });

  it("adds a suggestion block only for right-side suggestions", () => {
    const withSuggestion = finding({ suggestion: "const x = 1;" });
    expect(formatInlineComment(withSuggestion)).toContain("```suggestion\nconst x = 1;\n```");
    expect(formatInlineComment(finding())).not.toContain("suggestion");
  });
});

describe("review command", () => {
  const setup = (llm: ScriptedLlm) => {
    const client = new FakeGitHubClient({
      pr: fakePullRequest(),
      files,
      commits: [{ sha: "1", message: "fix: auth", author: "octo", date: null }],
    });
    const runtime = createRuntime({
      env: loadEnv({}),
      logger: silentLogger,
      github: { forRepo: () => Promise.resolve(client), forInstallation: () => client },
      adapterFactory: llm.factory,
      counter: charEstimateCounter(4),
      baseLayers: [{ name: "cli", source: "test", value: { review: { enableVerifier: false } } }],
    });
    return { client, runtime };
  };

  it("does not write anything in dry-run mode", async () => {
    const llm = new ScriptedLlm({
      "gpt-5": [{ parsed: { findings: [llmFinding()] } }],
      "gpt-5-mini": [{ parsed: summaryOutput }],
    });
    const { client, runtime } = setup(llm);

    const outcome = await runCommand(runtime, ref, "review", { dryRun: true });

    expect(outcome.review.findings).toHaveLength(1);
    expect(outcome.publish).toBeNull();
    expect(outcome.published).toBe(false);
    expect(client.reviews).toEqual([]);
    expect(client.comments).toEqual([]);
    expect(outcome.usage.byModel["gpt-5"]?.calls).toBe(1);
    expect(outcome.usage.byModel["gpt-5-mini"]?.calls).toBe(1);
  });

  it("publishes inline comments and the summary", async () => {
    const llm = new ScriptedLlm({
      "gpt-5": [{ parsed: { findings: [llmFinding()] } }],
      "gpt-5-mini": [{ parsed: summaryOutput }],
    });
    const { client, runtime } = setup(llm);

    const outcome = await runCommand(runtime, ref, "review", { dryRun: false });

    expect(outcome.published).toBe(true);
    expect(outcome.publish?.inlineCount).toBe(1);
    expect(client.reviews).toHaveLength(1);
    expect(client.comments).toHaveLength(1);
  });
});
