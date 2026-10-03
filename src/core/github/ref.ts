import type { PullRequestRef, RepoRef } from "./types.ts";

const PR_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT_PATTERN = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;

export class InvalidReferenceError extends Error {
  constructor(input: string, expected: string) {
    super(`Cannot parse "${input}" as ${expected}`);
    this.name = "InvalidReferenceError";
  }
}

export const parsePullRequestRef = (input: string): PullRequestRef => {
  const value = input.trim();
  const match = PR_URL_PATTERN.exec(value) ?? PR_SHORT_PATTERN.exec(value);
  const [, owner, repo, number] = match ?? [];
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new InvalidReferenceError(input, "a pull request URL or owner/repo#number");
  }
  return { owner, repo: repo.replace(/\.git$/, ""), number: Number.parseInt(number, 10) };
};

export const parseRepoRef = (input: string): RepoRef => {
  const match = REPO_PATTERN.exec(input.trim());
  const [, owner, repo] = match ?? [];
  if (owner === undefined || repo === undefined) {
    throw new InvalidReferenceError(input, "owner/repo");
  }
  return { owner, repo };
};

export const formatPullRequestRef = (ref: PullRequestRef): string =>
  `${ref.owner}/${ref.repo}#${ref.number}`;

export const repoFullName = (ref: RepoRef): string => `${ref.owner}/${ref.repo}`;
