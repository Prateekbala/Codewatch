import type { RepoRef } from "../github/types.ts";

const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/|([\w.-]+)\/([\w.-]+)#|#)(\d+)/gi;

export interface IssueReference {
  readonly repo: RepoRef;
  readonly number: number;
}

export const extractLinkedIssues = (
  text: string,
  home: RepoRef,
  limit: number,
): IssueReference[] => {
  const seen = new Set<string>();
  const references: IssueReference[] = [];

  for (const match of text.matchAll(CLOSING_KEYWORD)) {
    const owner = match[1] ?? match[3] ?? home.owner;
    const repo = match[2] ?? match[4] ?? home.repo;
    const number = Number.parseInt(match[5] ?? "", 10);
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    if (Number.isNaN(number) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push({ repo: { owner, repo }, number });
    if (references.length >= limit) {
      break;
    }
  }

  return references;
};
