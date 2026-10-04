/**
 * Rich TTY output — delta-style diff rendering, ANSI syntax highlighting,
 * cmd-table (rounded theme), chalk colours, boxen panels.
 *
 * Libraries used:
 *   chalk      — ANSI colour / style
 *   boxen      — bordered panels
 *   emphasize  — lowlight-based ANSI syntax highlighting (190+ languages)
 *   cmd-table  — modern zero-dep table (2026 replacement for cli-table3)
 */

import boxen from "boxen";
import chalk, { type ChalkInstance } from "chalk";
import { Table, THEME_Rounded } from "cmd-table";
import { common, createEmphasize, type Sheet } from "emphasize";

import type { DescribeOutcome, ReviewOutcome } from "../core/commands/run.ts";
import type { PullRequestType } from "../core/graph/describe/schema.ts";
import type { Finding, ReviewSummary, RiskLevel } from "../core/graph/review/schema.ts";
import type { CostSummary } from "../core/llm/cost.ts";


const emp = createEmphasize(common);

/** Chalk-based sheet passed to emphasize for suggestion code blocks. */
const CODE_SHEET: Sheet = {
  keyword: chalk.cyan.bold,
  "keyword literal": chalk.cyan,
  string: chalk.green,
  "string template-string": chalk.green,
  number: chalk.yellow,
  comment: chalk.gray.italic,
  "comment block": chalk.gray.italic,
  built_in: chalk.magenta,
  literal: chalk.yellow,
  type: chalk.blue,
  "class title": chalk.blue.bold,
  "function title": chalk.blue,
  operator: chalk.white,
  punctuation: chalk.white,
  attr: chalk.cyan,
  attribute: chalk.cyan,
  "meta keyword": chalk.magenta,
} as Sheet;

/** Highlight a code snippet, guessing the language from the file extension. */
const highlightCode = (code: string, filePath?: string): string => {
  const ext = filePath?.split(".").pop() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    java: "java",
    rs: "rust",
    rb: "ruby",
    sh: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    sql: "sql",
    md: "markdown",
  };
  const lang = langMap[ext] ?? "typescript";
  try {
    return emp.highlight(lang, code, CODE_SHEET).value;
  } catch {
    return code;
  }
};


const SEVERITY_COLOR: Record<RiskLevel, ChalkInstance> = {
  critical: chalk.bgRed.white.bold,
  high: chalk.red.bold,
  medium: chalk.yellow.bold,
  low: chalk.cyan.bold,
};

const SEVERITY_LABEL: Record<RiskLevel, string> = {
  critical: " CRITICAL ",
  high: "   HIGH   ",
  medium: " MEDIUM   ",
  low: "   LOW    ",
};

const CATEGORY_COLOR: Record<Finding["category"], ChalkInstance> = {
  bug: chalk.red,
  security: chalk.magenta,
  performance: chalk.yellow,
  tests: chalk.cyan,
  api: chalk.blue,
  style: chalk.gray,
};

const PR_TYPE_COLOR: Record<PullRequestType, ChalkInstance> = {
  feature: chalk.green.bold,
  bugfix: chalk.red.bold,
  refactor: chalk.blue.bold,
  performance: chalk.yellow.bold,
  security: chalk.magenta.bold,
  tests: chalk.cyan.bold,
  docs: chalk.white.bold,
  dependencies: chalk.gray.bold,
  chore: chalk.gray.bold,
  other: chalk.white.bold,
};

const severityTag = (s: RiskLevel): string => SEVERITY_COLOR[s](SEVERITY_LABEL[s]);
const categoryTag = (c: Finding["category"]): string => CATEGORY_COLOR[c](`[${c.toUpperCase()}]`);
const pct = (n: number): string => `${Math.round(n * 100)}%`;


const W = 80;
const hr = (ch = "─", w = W): string => chalk.dim(ch.repeat(w));
const sectionTitle = (title: string): string =>
  chalk.bold.white(title.toUpperCase()) + "  " + chalk.dim("─".repeat(W - title.length - 2));


/**
 * Render a list of evidence lines (raw unified-diff lines from the finding)
 * in a delta-inspired style:
 *   - line numbers in the gutter
 *   - "+" lines: green background strip
 *   - "-" lines: red background strip
 *   - context lines: dimmed
 *
 * Evidence lines come in the model's own format: "R12:+code" / "L8:-code"
 * as produced by core/diff/render.ts renderLine().
 * We also handle raw "+"/"-"/" " prefix lines from plain unified diffs.
 */
const renderDiffSnippet = (evidence: readonly string[], filePath?: string): string => {
  if (evidence.length === 0) return "";

  // Attempt to parse R12:+code / L8:-code format
  const LABEL_RE = /^([LR])(\d+):([+ -])(.*)$/;
  const PLAIN_RE = /^([+ -])(.*)$/;

  const lines = evidence.map((raw) => {
    const lm = LABEL_RE.exec(raw);
    if (lm) {
      const side = lm[1] ?? "";
      const num = lm[2] ?? "";
      const marker = (lm[3] ?? " ") as "+" | "-" | " ";
      const code = lm[4] ?? "";
      return { lineNum: `${side}${num}`, marker, code };
    }
    const pm = PLAIN_RE.exec(raw);
    if (pm) {
      const marker = (pm[1] ?? " ") as "+" | "-" | " ";
      const code = pm[2] ?? "";
      return { lineNum: "", marker, code };
    }
    return { lineNum: "", marker: " " as " ", code: raw };
  });

  const gutterWidth = Math.max(...lines.map((l) => l.lineNum.length), 4);

  const rendered = lines.map(({ lineNum, marker, code }) => {
    const gutter = lineNum.padStart(gutterWidth);
    const highlighted = highlightCode(code, filePath);

    if (marker === "+") {
      return (
        chalk.green(gutter) +
        chalk.green.bold(" + ") +
        chalk.bgGreen.black(" ") +
        chalk.green(` ${highlighted}`)
      );
    } else if (marker === "-") {
      return (
        chalk.red(gutter) +
        chalk.red.bold(" - ") +
        chalk.bgRed.black(" ") +
        chalk.red(` ${highlighted}`)
      );
    } else {
      return chalk.dim(gutter) + chalk.dim("   ") + chalk.dim("  " + highlighted);
    }
  });

  const fileLabel = filePath
    ? chalk.dim("  diff ") +
      chalk.white.bold(filePath) +
      chalk.dim("  ") +
      "\n" +
      chalk.dim("  " + "─".repeat(W - 2)) +
      "\n"
    : "";

  return fileLabel + rendered.join("\n");
};


const renderSuggestion = (code: string, filePath?: string): string => {
  const highlighted = highlightCode(code, filePath);
  const lines = highlighted.split("\n").map((l) => chalk.dim("  │ ") + chalk.green(l));
  return [
    chalk.dim("  ┌─── ") + chalk.green.bold("suggested fix") + chalk.dim(" " + "─".repeat(40)),
    ...lines,
    chalk.dim("  └" + "─".repeat(55)),
  ].join("\n");
};


const renderFinding = (finding: Finding, index: number): string => {
  const loc =
    finding.endLine > finding.startLine
      ? `${finding.path}:${finding.startLine}–${finding.endLine}`
      : `${finding.path}:${finding.startLine}`;

  const parts: string[] = [
    // header line
    chalk.dim(`  ${String(index + 1).padStart(2)}.  `) +
      severityTag(finding.severity) +
      "  " +
      categoryTag(finding.category) +
      "  " +
      chalk.white.bold(finding.title),

    // location + meta
    chalk.dim(`        ${loc}`) +
      chalk.dim("  ·  ") +
      chalk.dim(`conf ${pct(finding.confidence)}`) +
      chalk.dim("  ·  ") +
      chalk.dim(finding.source),

    // explanation (indented, word-wrapped at 72 chars)
    ...wrapText(finding.explanation.trim(), 72).map((l) => chalk.white("        " + l)),
  ];

  // evidence diff
  if (finding.evidence.length > 0) {
    parts.push("", renderDiffSnippet(finding.evidence, finding.path));
  }

  // suggestion
  if (finding.suggestion && finding.suggestion.trim() !== "") {
    parts.push("", renderSuggestion(finding.suggestion.trim(), finding.path));
  }

  return parts.join("\n");
};


const renderFindingsTable = (findings: readonly Finding[]): string => {
  const table = new Table({ theme: THEME_Rounded });
  table.addColumn({ name: "#", minWidth: 3 });
  table.addColumn({ name: "Severity", minWidth: 10 });
  table.addColumn({ name: "Category", minWidth: 10 });
  table.addColumn({ name: "Title", minWidth: 38 });
  table.addColumn({ name: "Location", minWidth: 24 });
  table.addColumn({ name: "Conf", minWidth: 6 });

  for (const [i, f] of findings.entries()) {
    const loc =
      f.endLine > f.startLine
        ? `${f.path}:${f.startLine}–${f.endLine}`
        : `${f.path}:${f.startLine}`;
    table.addRow({
      "#": chalk.dim(String(i + 1)),
      Severity: SEVERITY_COLOR[f.severity](f.severity.toUpperCase()),
      Category: CATEGORY_COLOR[f.category](f.category),
      Title: f.title,
      Location: chalk.dim(loc),
      Conf: chalk.dim(pct(f.confidence)),
    });
  }

  return table.render();
};


const renderSummaryPanel = (summary: ReviewSummary): string => {
  const lines: string[] = [
    chalk.white(summary.overview.trim()),
    "",
    chalk.bold("Risk:   ") + severityTag(summary.riskLevel),
  ];

  if (summary.highlights.length > 0) {
    lines.push("", chalk.bold.white("Highlights"));
    for (const h of summary.highlights) {
      lines.push(chalk.green("  > ") + chalk.white(h));
    }
  }

  if (summary.fileGroups.length > 0) {
    lines.push("", chalk.bold.white("Files reviewed"));
    for (const g of summary.fileGroups) {
      lines.push(
        chalk.cyan("  + ") + chalk.white.bold(g.group) + (g.notes ? chalk.dim("  " + g.notes) : ""),
      );
      for (const f of g.files) {
        lines.push(chalk.dim("      " + f));
      }
    }
  }

  const borderColor =
    summary.riskLevel === "critical" || summary.riskLevel === "high" ? "red" : "cyan";

  return boxen(lines.join("\n"), {
    padding: { top: 1, bottom: 1, left: 3, right: 3 },
    borderStyle: "round",
    borderColor,
    title: chalk.bold.cyan(" PR REVIEW SUMMARY "),
    titleAlignment: "center",
  });
};

// ─── stats bar ────────────────────────────────────────────────────────────────

const renderStats = (stats: ReviewOutcome["review"]["stats"], total: number): string => {
  const items: Array<[string, string | number]> = [
    ["findings", chalk.white.bold(String(total))],
    ["units", chalk.dim(String(stats.units))],
    ["candidates", chalk.dim(String(stats.candidates))],
    ["filtered", chalk.dim(String(stats.belowConfidence + stats.belowSeverity))],
    ["ungrounded", chalk.dim(String(stats.ungrounded))],
    ["ci imported", chalk.dim(String(stats.ciImported))],
  ];
  return chalk.dim("  ") + items.map(([k, v]) => chalk.dim(k + " ") + v).join(chalk.dim("  ·  "));
};

// ─── footer ───────────────────────────────────────────────────────────────────

const renderFooter = (usage: CostSummary, durationMs: number): string => {
  const cost =
    usage.unpricedModels.length > 0
      ? chalk.dim("cost unavailable")
      : chalk.dim(`~$${usage.costUsd.toFixed(4)}`);
  return (
    chalk.dim(`  ${usage.totalTokens.toLocaleString()} tokens`) +
    chalk.dim("  ·  ") +
    cost +
    chalk.dim("  ·  ") +
    chalk.dim(`${(durationMs / 1000).toFixed(1)}s`)
  );
};

// ─── text utilities ───────────────────────────────────────────────────────────

const wrapText = (text: string, width: number): string[] => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
};

// ─── public renderers ─────────────────────────────────────────────────────────

export const prettyReviewOutcome = (outcome: ReviewOutcome): string => {
  const { review, usage, publish, dryRun, durationMs } = outcome;
  const { findings, summary, notices, stats } = review;

  const parts: string[] = [""];

  // summary panel
  parts.push(renderSummaryPanel(summary), "");

  // publish status
  const statusLine = dryRun
    ? chalk.yellow("  dry run — nothing posted to GitHub")
    : publish?.status === "stale"
      ? chalk.red("  skipped — PR changed during review (head SHA moved)")
      : chalk.green(`  posted ${publish?.inlineCount ?? 0} inline comment(s) + sticky summary`);
  parts.push(statusLine, "");

  // stats
  parts.push(renderStats(stats, findings.length), "", hr(), "");

  // findings
  if (findings.length === 0) {
    parts.push(
      boxen(chalk.green("  No issues found — this change looks good.  "), {
        padding: 1,
        borderStyle: "round",
        borderColor: "green",
      }),
    );
  } else if (findings.length > 6) {
    parts.push(sectionTitle(`findings  (${findings.length})`), "", renderFindingsTable(findings));
  } else {
    parts.push(sectionTitle(`findings  (${findings.length})`), "");
    for (const [i, f] of findings.entries()) {
      parts.push(renderFinding(f, i));
      if (i < findings.length - 1) parts.push("", hr("╌", 72), "");
    }
  }

  // notices
  if (notices.length > 0) {
    parts.push("", ...notices.map((n) => chalk.yellow("  ! " + n)));
  }

  // footer
  parts.push("", hr(), renderFooter(usage, durationMs), "");

  return parts.join("\n");
};

export const prettyDescribeOutcome = (outcome: DescribeOutcome): string => {
  const { describe, usage, dryRun, durationMs } = outcome;
  const { output, title } = describe;

  const lines: string[] = [
    chalk.bold.white("Title") + "   " + chalk.cyan(title),
    "",
    chalk.bold.white("Type ") +
      "   " +
      PR_TYPE_COLOR[output.type](`[ ${output.type.toUpperCase()} ]`),
    "",
    chalk.bold.white("Summary"),
    ...wrapText(output.summary.trim(), 72).map((l) => chalk.white("  " + l)),
  ];

  if (output.walkthrough.length > 0) {
    lines.push("", chalk.bold.white("Walkthrough"));
    for (const entry of output.walkthrough) {
      lines.push(chalk.cyan("  + ") + chalk.white.bold(entry.group));
      lines.push(...wrapText(entry.description.trim(), 68).map((l) => chalk.dim("      " + l)));
      for (const f of entry.files) {
        lines.push(chalk.dim("      · " + f));
      }
    }
  }

  if (output.risks.length > 0) {
    lines.push("", chalk.bold.white("Risks"));
    for (const risk of output.risks) {
      lines.push(chalk.red("  ! ") + chalk.white(risk));
    }
  }

  const borderColor = output.risks.length > 0 ? "yellow" : "cyan";

  const panel = boxen(lines.join("\n"), {
    padding: { top: 1, bottom: 1, left: 3, right: 3 },
    borderStyle: "round",
    borderColor,
    title: chalk.bold.cyan(" PR DESCRIBE "),
    titleAlignment: "center",
  });

  const statusLine = dryRun
    ? chalk.yellow("  dry run — nothing written to GitHub")
    : outcome.published
      ? chalk.green("  pull request updated")
      : chalk.dim("  pull request already up to date");

  return ["\n", panel, "", statusLine, "", hr(), renderFooter(usage, durationMs), ""].join("\n");
};
