import { describe, expect, it } from "vitest";

import { buildReviewContext } from "../../src/core/context/builder.ts";
import { extractLinkedIssues } from "../../src/core/context/linked-issues.ts";
import { FakeGitHubClient, fakePullRequest, silentLogger, testConfig } from "../helpers/fakes.ts";

const home = { owner: "acme", repo: "widgets" };

describe("extractLinkedIssues", () => {
  it("finds closing keywords in all supported forms", () => {
    const text = [
      "Fixes #1",
      "closes: #2",
      "Resolved other/repo#3",
      "fix https://github.com/foo/bar/issues/4",
    ].join("\n");

    expect(extractLinkedIssues(text, home, 10)).toEqual([
      { repo: home, number: 1 },
      { repo: home, number: 2 },
      { repo: { owner: "other", repo: "repo" }, number: 3 },
      { repo: { owner: "foo", repo: "bar" }, number: 4 },
    ]);
  });

  it("deduplicates, ignores plain mentions, and honors the limit", () => {
    expect(extractLinkedIssues("See #9. Fixes #1, fixes #1, fixes #2, fixes #3", home, 2)).toEqual([
      { repo: home, number: 1 },
      { repo: home, number: 2 },
    ]);
  });
});

describe("buildReviewContext", () => {
  const issue = (number: number, isPullRequest = false) => ({
    number,
    title: `Issue ${number}`,
    body: "Details",
    state: "open" as const,
    isPullRequest,
  });

  it("collects linked issues, repo rules, and failing checks", async () => {
    const pr = fakePullRequest({ body: "Fixes #7 and fixes #8" });
    const client = new FakeGitHubClient({
      pr,
      issues: { 7: issue(7), 8: issue(8, true) },
      contents: { "AGENTS.md": "Always use strict mode." },
      checkRuns: [
        { id: 1, name: "lint", status: "completed", conclusion: "failure", annotationCount: 0 },
        { id: 2, name: "unit", status: "completed", conclusion: "success", annotationCount: 0 },
      ],
    });

    const context = await buildReviewContext({
      client,
      pr,
      config: testConfig(),
      logger: silentLogger,
    });

    expect(context.linkedIssues).toContain("Issue 7");
    expect(context.linkedIssues).not.toContain("Issue 8");
    expect(context.repoRules).toContain("Always use strict mode.");
    expect(context.ciSummary).toContain("lint");
    expect(context.ciSummary).not.toContain("unit");
  });

  it("tolerates missing issues", async () => {
    const pr = fakePullRequest({ body: "Fixes #404" });
    const client = new FakeGitHubClient({ pr });

    const context = await buildReviewContext({
      client,
      pr,
      config: testConfig(),
      logger: silentLogger,
    });

    expect(context.linkedIssues).toBe("");
  });
});
