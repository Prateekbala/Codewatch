import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { ReviewContext } from "../../context/builder.ts";
import type { Config } from "../../config/schema.ts";
import type { IncludedFile } from "../../diff/types.ts";
import { repoFullName } from "../../github/ref.ts";
import type { CommitSummary, PullRequest } from "../../github/types.ts";
import { loadPrompt, neutralizeTags } from "../../prompts/loader.ts";

import type { Finding } from "./schema.ts";

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMIT_CHARS = 300;
const MAX_LISTED_FILES = 120;
const MAX_OVERVIEW_COMMITS = 15;
const EXPLANATION_EXCERPT_CHARS = 240;
const NONE = "(none)";

export interface ReviewPrompt {
  readonly system: SystemMessage;
  readonly overheadText: string;
  readonly build: (unit: readonly IncludedFile[], all: readonly IncludedFile[]) => HumanMessage;
  readonly hashes: { readonly reviewSystem: string; readonly reviewUser: string };
}

export interface SummaryPrompt {
  readonly system: SystemMessage;
  readonly build: (input: SummaryInput) => HumanMessage;
  readonly hashes: { readonly summarySystem: string; readonly summaryUser: string };
}

export interface SummaryInput {
  readonly files: readonly IncludedFile[];
  readonly commits: readonly CommitSummary[];
  readonly findings: readonly Finding[];
  readonly omittedFiles: number;
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

const orNone = (text: string): string => (text.trim() === "" ? NONE : text);

const formatCommits = (commits: readonly CommitSummary[], limit: number): string => {
  if (commits.length === 0) {
    return NONE;
  }
  const lines = commits
    .slice(0, limit)
    .map((commit) => `- ${truncate(commit.message.split("\n")[0] ?? "", MAX_COMMIT_CHARS)}`);
  const hidden = commits.length - lines.length;
  return hidden > 0 ? [...lines, `- (${hidden} more commits)`].join("\n") : lines.join("\n");
};

const formatFileList = (files: readonly IncludedFile[]): string => {
  if (files.length === 0) {
    return "(no reviewable changes)";
  }
  const lines = files
    .slice(0, MAX_LISTED_FILES)
    .map((file) => `${file.status} ${file.path} (+${file.additions} -${file.deletions})`);
  const hidden = files.length - lines.length;
  return hidden > 0 ? [...lines, `(${hidden} more files)`].join("\n") : lines.join("\n");
};

const formatFindings = (findings: readonly Finding[]): string =>
  findings.length === 0
    ? NONE
    : findings
        .map(
          (finding) =>
            `- [${finding.severity}/${finding.category}] ${finding.path}:${finding.startLine} ${finding.title}: ${truncate(finding.explanation, EXPLANATION_EXCERPT_CHARS)}`,
        )
        .join("\n");

export const createReviewPrompt = (context: ReviewContext, config: Config): ReviewPrompt => {
  const { pr } = context;
  const systemTemplate = loadPrompt("review.system");
  const userTemplate = loadPrompt("review.user");

  const staticVariables = {
    repository: repoFullName(pr.ref),
    number: pr.ref.number,
    author: pr.author,
    base: pr.baseRef,
    head: pr.headRef,
    title: neutralizeTags(pr.title),
    description: neutralizeTags(orNone(truncate(pr.body.trim(), MAX_DESCRIPTION_CHARS))),
    commits: neutralizeTags(formatCommits(context.commits, config.describe.maxCommitMessages)),
    linkedIssues: neutralizeTags(orNone(context.linkedIssues)),
    repoRules: neutralizeTags(orNone(context.repoRules)),
    ciSummary: neutralizeTags(orNone(context.ciSummary)),
    priorFindings: neutralizeTags(orNone(context.priorFindings)),
  };

  const system = systemTemplate.render({ language: config.language });
  const overheadText = `${system}\n${userTemplate.render({ ...staticVariables, summary: "", diff: "" })}`;

  return {
    system: new SystemMessage(system),
    overheadText,
    hashes: { reviewSystem: systemTemplate.hash, reviewUser: userTemplate.hash },
    build: (unit, all) =>
      new HumanMessage(
        userTemplate.render({
          ...staticVariables,
          summary: neutralizeTags(formatFileList(all)),
          diff: neutralizeTags(unit.map((file) => file.text).join("\n\n")),
        }),
      ),
  };
};

export const createSummaryPrompt = (pr: PullRequest, config: Config): SummaryPrompt => {
  const systemTemplate = loadPrompt("summary.system");
  const userTemplate = loadPrompt("summary.user");
  const system = systemTemplate.render({ language: config.language });

  return {
    system: new SystemMessage(system),
    hashes: { summarySystem: systemTemplate.hash, summaryUser: userTemplate.hash },
    build: (input) => {
      const overview = [
        formatFileList(input.files),
        input.omittedFiles > 0
          ? `Not analyzed because of size limits: ${input.omittedFiles} files`
          : "",
        `Commits:\n${formatCommits(input.commits, MAX_OVERVIEW_COMMITS)}`,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      return new HumanMessage(
        userTemplate.render({
          repository: repoFullName(pr.ref),
          number: pr.ref.number,
          author: pr.author,
          title: neutralizeTags(pr.title),
          overview: neutralizeTags(overview),
          findings: neutralizeTags(formatFindings(input.findings)),
        }),
      );
    },
  };
};
