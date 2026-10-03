import { runReview } from "../src/core/graph/review/graph.ts";
import type { Finding } from "../src/core/graph/review/schema.ts";
import type { CostSummary } from "../src/core/llm/cost.ts";
import type { CoreServices } from "../src/core/services.ts";

import { MemoryGitHubClient } from "./memory-client.ts";
import { type CaseScore, ratios, type Ratios, scoreCase } from "./scoring.ts";
import type { EvalCase, ExpectedFinding } from "./types.ts";

export interface EvalServices {
  readonly services: CoreServices;
  readonly usage: () => CostSummary;
}

export type EvalServicesFactory = (client: MemoryGitHubClient) => EvalServices;

export interface ReportedCaseFinding {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly severity: Finding["severity"];
  readonly category: Finding["category"];
  readonly title: string;
}

export interface CaseReport {
  readonly id: string;
  readonly expected: number;
  readonly found: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly missed: readonly ExpectedFinding[];
  readonly unexpected: readonly ReportedCaseFinding[];
  readonly tokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly failedUnits: number;
  readonly error: string | null;
}

export interface Totals extends Ratios {
  readonly cases: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly costPerCaseUsd: number;
  readonly durationMs: number;
  readonly erroredCases: number;
}

export interface EvalReport {
  readonly startedAt: string;
  readonly label: string;
  readonly cases: readonly CaseReport[];
  readonly totals: Totals;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toReported = (finding: Finding): ReportedCaseFinding => ({
  path: finding.path,
  startLine: finding.startLine,
  endLine: finding.endLine,
  severity: finding.severity,
  category: finding.category,
  title: finding.title,
});

export const runEvalCase = async (
  item: EvalCase,
  createServices: EvalServicesFactory,
  signal?: AbortSignal,
): Promise<CaseReport> => {
  const startedAt = performance.now();
  const client = new MemoryGitHubClient(item);
  const { services, usage } = createServices(client);

  let score: CaseScore<ReportedCaseFinding>;
  let found = 0;
  let failedUnits = 0;
  let error: string | null = null;

  try {
    const result = await runReview(services, client.pullRequest, signal);
    const reported = result.findings.map(toReported);
    found = reported.length;
    failedUnits = result.stats.failedUnits;
    score = scoreCase(item.expected, reported);
  } catch (caught) {
    error = describeError(caught);
    score = scoreCase(item.expected, []);
  }

  const cost = usage();
  return {
    id: item.id,
    expected: item.expected.length,
    found,
    truePositives: score.truePositives,
    falsePositives: score.falsePositives,
    falseNegatives: score.falseNegatives,
    missed: score.missed,
    unexpected: score.unexpected,
    tokens: cost.totalTokens,
    costUsd: cost.costUsd,
    durationMs: Math.round(performance.now() - startedAt),
    failedUnits,
    error,
  };
};

export const summarize = (cases: readonly CaseReport[]): Totals => {
  const sum = (pick: (report: CaseReport) => number): number =>
    cases.reduce((total, report) => total + pick(report), 0);
  const truePositives = sum((report) => report.truePositives);
  const falsePositives = sum((report) => report.falsePositives);
  const falseNegatives = sum((report) => report.falseNegatives);
  const costUsd = sum((report) => report.costUsd);
  return {
    ...ratios({ truePositives, falsePositives, falseNegatives }),
    cases: cases.length,
    truePositives,
    falsePositives,
    falseNegatives,
    tokens: sum((report) => report.tokens),
    costUsd,
    costPerCaseUsd: cases.length === 0 ? 0 : costUsd / cases.length,
    durationMs: sum((report) => report.durationMs),
    erroredCases: cases.filter((report) => report.error !== null).length,
  };
};

export interface RunEvalOptions {
  readonly cases: readonly EvalCase[];
  readonly createServices: EvalServicesFactory;
  readonly label: string;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export const runEval = async (options: RunEvalOptions): Promise<EvalReport> => {
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const reports: (CaseReport | undefined)[] = Array.from({ length: options.cases.length });
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < options.cases.length) {
      const index = cursor++;
      const item = options.cases[index];
      if (item !== undefined) {
        reports[index] = await runEvalCase(item, options.createServices, options.signal);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const cases = reports.filter((report): report is CaseReport => report !== undefined);
  return { startedAt, label: options.label, cases, totals: summarize(cases) };
};

export interface Comparison {
  readonly precisionDelta: number;
  readonly recallDelta: number;
  readonly costPerCaseDeltaUsd: number;
  readonly regressed: boolean;
}

export const compareReports = (
  current: EvalReport,
  baseline: EvalReport,
  tolerance = 0.05,
): Comparison => {
  const precisionDelta = current.totals.precision - baseline.totals.precision;
  const recallDelta = current.totals.recall - baseline.totals.recall;
  return {
    precisionDelta,
    recallDelta,
    costPerCaseDeltaUsd: current.totals.costPerCaseUsd - baseline.totals.costPerCaseUsd,
    regressed: precisionDelta < -tolerance || recallDelta < -tolerance,
  };
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const formatReport = (report: EvalReport, comparison?: Comparison): string => {
  const lines = [
    `Eval ${report.label} (${report.startedAt})`,
    "",
    ...report.cases.map((item) => {
      const status =
        item.error !== null
          ? "ERROR"
          : item.falsePositives + item.falseNegatives === 0
            ? "ok"
            : "miss";
      const detail = [
        ...item.missed.map((miss) => `    missed ${miss.path}:${miss.startLine}`),
        ...item.unexpected.map(
          (extra) => `    extra  ${extra.path}:${extra.startLine} ${extra.title}`,
        ),
        ...(item.error === null ? [] : [`    error  ${item.error}`]),
      ];
      return [
        `${status.padEnd(5)} ${item.id} (tp ${item.truePositives}, fp ${item.falsePositives}, fn ${item.falseNegatives})`,
        ...detail,
      ].join("\n");
    }),
    "",
    `precision ${percent(report.totals.precision)} | recall ${percent(report.totals.recall)} | f1 ${percent(report.totals.f1)}`,
    `tokens ${report.totals.tokens} | cost $${report.totals.costUsd.toFixed(4)} ($${report.totals.costPerCaseUsd.toFixed(4)}/case) | ${report.totals.durationMs}ms`,
  ];
  if (comparison) {
    lines.push(
      `vs baseline: precision ${(comparison.precisionDelta * 100).toFixed(1)}pp | recall ${(comparison.recallDelta * 100).toFixed(1)}pp | cost/case ${comparison.costPerCaseDeltaUsd >= 0 ? "+" : "-"}$${Math.abs(comparison.costPerCaseDeltaUsd).toFixed(4)}`,
      comparison.regressed ? "REGRESSION" : "no regression",
    );
  }
  return lines.join("\n");
};
