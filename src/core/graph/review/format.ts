import { findingMarker } from "../../github/markers.ts";
import type { CostSummary } from "../../llm/cost.ts";

import type { Finding, ReviewSummary, RiskLevel } from "./schema.ts";

export const REVIEW_SECTION_ID = "review";

const SEVERITY_ICON: Readonly<Record<RiskLevel, string>> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

const CATEGORY_LABEL: Readonly<Record<Finding["category"], string>> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  tests: "Tests",
  api: "API",
  style: "Style",
};

const confidencePercent = (finding: Finding): number => Math.round(finding.confidence * 100);

const location = (finding: Finding): string =>
  finding.endLine > finding.startLine
    ? `${finding.path}:${finding.startLine}-${finding.endLine}`
    : `${finding.path}:${finding.startLine}`;

const fenceFor = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
};

export const formatInlineComment = (finding: Finding): string => {
  const lines = [
    `${SEVERITY_ICON[finding.severity]} **${CATEGORY_LABEL[finding.category]} · ${finding.severity}** — ${finding.title}`,
    "",
    finding.explanation.trim(),
  ];
  if (
    finding.suggestion !== undefined &&
    finding.suggestion.trim() !== "" &&
    finding.side === "RIGHT"
  ) {
    const fence = fenceFor(finding.suggestion);
    lines.push("", `${fence}suggestion`, finding.suggestion.replace(/\n$/, ""), fence);
  }
  lines.push("", `<sub>Confidence ${confidencePercent(finding)}%</sub>`, findingMarker(finding.id));
  return lines.join("\n");
};

const formatFindingDetail = (finding: Finding): string[] => [
  `- ${SEVERITY_ICON[finding.severity]} **${finding.title}** — \`${location(finding)}\` · ${CATEGORY_LABEL[finding.category]} · ${confidencePercent(finding)}%`,
  `  ${finding.explanation.trim().replace(/\s*\n\s*/g, " ")}`,
  `  ${findingMarker(finding.id)}`,
];

const formatCostLine = (usage: CostSummary): string =>
  usage.unpricedModels.length > 0
    ? `${usage.totalTokens} tokens`
    : `${usage.totalTokens} tokens · ~$${usage.costUsd.toFixed(4)}`;

export interface FormatReviewInput {
  readonly summary: ReviewSummary;
  readonly findings: readonly Finding[];
  readonly notices: readonly string[];
  readonly inlineIds: ReadonlySet<string>;
  readonly usage?: CostSummary;
}

export const formatReview = ({
  summary,
  findings,
  notices,
  inlineIds,
  usage,
}: FormatReviewInput): string => {
  const lines: string[] = ["## Review", "", summary.overview.trim(), ""];
  lines.push(`**Risk:** ${SEVERITY_ICON[summary.riskLevel]} ${summary.riskLevel}`);

  const inline = findings.filter((finding) => inlineIds.has(finding.id));
  const remaining = findings.filter((finding) => !inlineIds.has(finding.id));

  const counts: string[] = [];
  if (inline.length > 0) {
    counts.push(`${inline.length} inline comment${inline.length === 1 ? "" : "s"}`);
  }
  if (remaining.length > 0) {
    counts.push(`${remaining.length} more below`);
  }
  if (counts.length > 0) {
    lines.push(`**Findings:** ${counts.join(" · ")}`);
  }

  if (summary.highlights.length > 0) {
    lines.push("", "### Highlights", "", ...summary.highlights.map((item) => `- ${item}`));
  }

  if (remaining.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>Additional findings (${remaining.length})</summary>`,
      "",
      ...remaining.flatMap(formatFindingDetail),
      "",
      "</details>",
    );
  }

  if (summary.fileGroups.length > 0) {
    lines.push("", "<details>", "<summary>Files reviewed</summary>", "");
    for (const group of summary.fileGroups) {
      lines.push(`**${group.group}**${group.notes === "" ? "" : ` — ${group.notes}`}`);
      lines.push(...group.files.map((file) => `- \`${file}\``), "");
    }
    lines.push("</details>");
  }

  if (notices.length > 0) {
    lines.push("", ...notices.map((notice) => `> ⚠️ ${notice}`));
  }

  if (usage !== undefined) {
    lines.push("", `<sub>Run cost: ${formatCostLine(usage)}</sub>`);
  }

  return lines.join("\n");
};
