import type { PullRequest } from "../core/github/types.ts";

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export const isReviewablePullRequestAction = (action: string): boolean =>
  REVIEW_ACTIONS.has(action);

export const shouldSkipAutomaticReview = (pr: PullRequest): string | null => {
  if (pr.state !== "open") {
    return "pull request is not open";
  }
  if (pr.draft) {
    return "draft pull request";
  }
  if (pr.authorType === "Bot" || pr.author.toLowerCase().endsWith("[bot]")) {
    return "bot author";
  }
  return null;
};

export const parseSlashCommand = (body: string): "review" | "describe" | null => {
  const line = body.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  if (line === "/review" || line.startsWith("/review ")) {
    return "review";
  }
  if (line === "/describe" || line.startsWith("/describe ")) {
    return "describe";
  }
  return null;
};
