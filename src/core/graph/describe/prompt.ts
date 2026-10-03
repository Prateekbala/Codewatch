import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Config } from "../../config/schema.ts";
import { DESCRIBE_SECTION_ID } from "./format.ts";
import { stripManagedSection } from "../../github/markers.ts";
import type { CommitSummary, PullRequest } from "../../github/types.ts";
import { loadPrompt, neutralizeTags } from "../../prompts/loader.ts";
import { repoFullName } from "../../github/ref.ts";
import type { IncludedFile, PreparedDiff } from "../../diff/types.ts";

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMIT_CHARS = 300;
const MAX_SUMMARY_FILES = 80;

export interface DescribePrompt {
  readonly system: SystemMessage;
  readonly overheadText: string;
  readonly build: (prepared: PreparedDiff) => HumanMessage;
  readonly hashes: { readonly system: string; readonly user: string };
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

const describeFileLine = (file: IncludedFile): string =>
  `${file.status} ${file.path} (+${file.additions} -${file.deletions})${file.clipped ? " [clipped]" : ""}`;

const formatCommits = (commits: readonly CommitSummary[], limit: number): string => {
  if (commits.length === 0 || limit === 0) {
    return "(none)";
  }
  const shown = commits
    .slice(0, limit)
    .map((commit) => `- ${truncate(commit.message.split("\n")[0] ?? "", MAX_COMMIT_CHARS)}`);
  const hidden = commits.length - shown.length;
  return hidden > 0 ? [...shown, `- (${hidden} more commits)`].join("\n") : shown.join("\n");
};

const formatSummary = (prepared: PreparedDiff): string => {
  const lines = prepared.included.slice(0, MAX_SUMMARY_FILES).map(describeFileLine);
  const hidden = prepared.included.length - lines.length;
  if (hidden > 0) {
    lines.push(`(${hidden} more files)`);
  }
  if (prepared.omitted.length > 0) {
    lines.push(`Not shown due to size limits: ${prepared.omitted.length} files`);
  }
  return lines.length === 0 ? "(no reviewable changes)" : lines.join("\n");
};

export const createDescribePrompt = (
  pr: PullRequest,
  commits: readonly CommitSummary[],
  config: Config,
): DescribePrompt => {
  const systemTemplate = loadPrompt("describe.system");
  const userTemplate = loadPrompt("describe.user");

  const authorDescription = truncate(
    stripManagedSection(pr.body, DESCRIBE_SECTION_ID),
    MAX_DESCRIPTION_CHARS,
  );

  const baseVariables = {
    repository: repoFullName(pr.ref),
    number: pr.ref.number,
    author: pr.author,
    base: pr.baseRef,
    head: pr.headRef,
    title: neutralizeTags(pr.title),
    description: neutralizeTags(authorDescription === "" ? "(empty)" : authorDescription),
    commits: neutralizeTags(formatCommits(commits, config.describe.maxCommitMessages)),
  };

  const system = systemTemplate.render({ language: config.language });
  const overheadText = `${system}\n${userTemplate.render({ ...baseVariables, summary: "", diff: "" })}`;

  return {
    system: new SystemMessage(system),
    overheadText,
    hashes: { system: systemTemplate.hash, user: userTemplate.hash },
    build: (prepared) =>
      new HumanMessage(
        userTemplate.render({
          ...baseVariables,
          summary: neutralizeTags(formatSummary(prepared)),
          diff: neutralizeTags(prepared.included.map((file) => file.text).join("\n\n")),
        }),
      ),
  };
};
