import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DeliveryCache } from "../../src/server/delivery-cache.ts";
import { RunSupervisor } from "../../src/server/run-supervisor.ts";
import {
  isReviewablePullRequestAction,
  parseSlashCommand,
  shouldSkipAutomaticReview,
} from "../../src/server/skip-rules.ts";
import { verifyGitHubSignature } from "../../src/server/webhook-signature.ts";
import { fakePullRequest } from "../helpers/fakes.ts";

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

describe("webhook security", () => {
  it("verifies GitHub signatures", () => {
    const secret = "test-secret";
    const body = '{"ok":true}';
    expect(verifyGitHubSignature(secret, body, sign(secret, body))).toBe(true);
    expect(verifyGitHubSignature(secret, body, sign("other", body))).toBe(false);
  });
});

describe("delivery cache", () => {
  it("remembers ids up to the limit", () => {
    const cache = new DeliveryCache(2);
    cache.remember("a");
    cache.remember("b");
    expect(cache.has("a")).toBe(true);
    cache.remember("c");
    expect(cache.has("a")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });
});

describe("run supervisor", () => {
  it("aborts the previous run when a new one starts", () => {
    const supervisor = new RunSupervisor();
    const first = supervisor.start("acme/widgets#1", "sha-1");
    const second = supervisor.start("acme/widgets#1", "sha-2");
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    supervisor.finish("acme/widgets#1", "sha-2");
    expect(supervisor.get("acme/widgets#1")).toBeNull();
  });
});

describe("skip rules", () => {
  it("accepts reviewable pull request actions only", () => {
    expect(isReviewablePullRequestAction("opened")).toBe(true);
    expect(isReviewablePullRequestAction("labeled")).toBe(false);
  });

  it("skips drafts, bots, and closed pull requests", () => {
    expect(shouldSkipAutomaticReview(fakePullRequest({ draft: true }))).toContain("draft");
    expect(shouldSkipAutomaticReview(fakePullRequest({ authorType: "Bot" }))).toContain("bot");
    expect(shouldSkipAutomaticReview(fakePullRequest({ state: "closed" }))).toContain("open");
  });

  it("parses slash commands from the first line", () => {
    expect(parseSlashCommand("/review please")).toBe("review");
    expect(parseSlashCommand("/describe\nmore")).toBe("describe");
    expect(parseSlashCommand("not a command")).toBeNull();
  });
});
