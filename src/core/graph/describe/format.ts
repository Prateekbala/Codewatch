import type { DescribeOutput, PullRequestType } from "./schema.ts";

const TYPE_LABELS: Readonly<Record<PullRequestType, string>> = {
  feature: "Feature",
  bugfix: "Bug fix",
  refactor: "Refactor",
  performance: "Performance",
  security: "Security",
  tests: "Tests",
  docs: "Documentation",
  dependencies: "Dependencies",
  chore: "Chore",
  other: "Other",
};

export const DESCRIBE_SECTION_ID = "describe";

const MAX_TITLE_LENGTH = 120;
const MAX_GROUP_LENGTH = 80;

export const sanitizeDescribeOutput = (
  output: DescribeOutput,
  knownPaths: ReadonlySet<string>,
): DescribeOutput => ({
  ...output,
  title: output.title.trim().replace(/\.$/, "").slice(0, MAX_TITLE_LENGTH),
  summary: output.summary.trim(),
  walkthrough: output.walkthrough.flatMap((entry) => {
    const files = [...new Set(entry.files.filter((path) => knownPaths.has(path)))];
    const group = entry.group.trim().slice(0, MAX_GROUP_LENGTH);
    return files.length === 0 || group === "" ? [] : [{ ...entry, group, files }];
  }),
  risks: output.risks.map((risk) => risk.trim()).filter((risk) => risk !== ""),
});

export const formatDescription = (output: DescribeOutput, notices: readonly string[]): string => {
  const lines: string[] = [
    "## Summary",
    "",
    output.summary.trim(),
    "",
    `**Type:** ${TYPE_LABELS[output.type]}`,
  ];

  if (output.walkthrough.length > 0) {
    lines.push("", "## Walkthrough");
    for (const entry of output.walkthrough) {
      lines.push("", `### ${entry.group}`, "", entry.description.trim(), "");
      lines.push(...entry.files.map((path) => `- \`${path}\``));
    }
  }

  if (output.risks.length > 0) {
    lines.push("", "## Review focus", "", ...output.risks.map((risk) => `- ${risk.trim()}`));
  }

  if (notices.length > 0) {
    lines.push("", ...notices.map((notice) => `> ${notice}`));
  }

  return lines.join("\n");
};
