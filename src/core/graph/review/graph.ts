import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";

import { buildReviewContext, type ReviewContext } from "../../context/builder.ts";
import { toFileDiff } from "../../diff/classify.ts";
import { DiffLineIndex } from "../../diff/line-index.ts";
import { prepareDiff } from "../../diff/prepare.ts";
import type { IncludedFile, PreparedDiff, ReviewUnit } from "../../diff/types.ts";
import type { PullRequest } from "../../github/types.ts";
import type { CoreServices } from "../../services.ts";

import { findingsFromAnnotations } from "./ci-findings.ts";
import { deduplicateFindings, promoteFinding } from "./fingerprint.ts";
import { createInvestigator } from "./investigate.ts";
import { verifyFindings } from "./verify.ts";
import { createReviewPrompt, createSummaryPrompt } from "./prompt.ts";
import {
  ReviewSummarySchema,
  ReviewUnitOutputSchema,
  SEVERITY_RANK,
  type Finding,
  type ReviewResult,
  type ReviewStats,
  type ReviewSummary,
  type RiskLevel,
} from "./schema.ts";

export interface ReviewUnitInput {
  readonly unit: ReviewUnit;
  readonly allFiles: readonly IncludedFile[];
  readonly context: ReviewContext;
}

type Counters = Partial<
  Record<
    | "duplicates"
    | "ungrounded"
    | "belowConfidence"
    | "belowSeverity"
    | "ciImported"
    | "rejectedByVerifier"
    | "investigated"
    | "toolCalls"
    | "severityRevised",
    number
  >
>;

const concat = <T>(a: T[], b: T[]): T[] => [...a, ...b];

const ReviewState = Annotation.Root({
  pr: Annotation<PullRequest>(),
  context: Annotation<ReviewContext>(),
  prepared: Annotation<PreparedDiff>(),
  candidates: Annotation<Finding[]>({ reducer: concat, default: () => [] }),
  failures: Annotation<string[]>({ reducer: concat, default: () => [] }),
  counters: Annotation<Counters>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  findings: Annotation<Finding[]>(),
  result: Annotation<ReviewResult>(),
});

type State = typeof ReviewState.State;

const rankFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.confidence - a.confidence ||
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine,
  );

const worstSeverity = (findings: readonly Finding[]): RiskLevel =>
  findings.reduce<RiskLevel>(
    (worst, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst,
    "low",
  );

const higherRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

const fallbackSummary = (
  findings: readonly Finding[],
  files: readonly IncludedFile[],
): ReviewSummary => ({
  overview:
    findings.length === 0
      ? "No problems were found in the reviewed changes."
      : `${findings.length} potential problem${findings.length === 1 ? "" : "s"} found across ${new Set(findings.map((finding) => finding.path)).size} file(s).`,
  riskLevel: worstSeverity(findings),
  highlights: findings
    .slice(0, 3)
    .map((finding) => `${finding.title} (${finding.path}:${finding.startLine})`),
  fileGroups:
    files.length === 0
      ? []
      : [{ group: "Changed files", files: files.map((file) => file.path), notes: "" }],
});

const sanitizeSummary = (
  summary: ReviewSummary,
  findings: readonly Finding[],
  knownPaths: ReadonlySet<string>,
): ReviewSummary => ({
  overview: summary.overview.trim(),
  riskLevel: higherRisk(summary.riskLevel, worstSeverity(findings)),
  highlights: summary.highlights.map((item) => item.trim()).filter((item) => item !== ""),
  fileGroups: summary.fileGroups.flatMap((group) => {
    const files = [...new Set(group.files.filter((path) => knownPaths.has(path)))];
    const name = group.group.trim();
    return files.length === 0 || name === ""
      ? []
      : [{ group: name, files, notes: group.notes.trim() }];
  }),
});

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createReviewGraph = (services: CoreServices) => {
  const { github, llm, config, logger, counter } = services;

  const fetchContext = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const context = await buildReviewContext({ client: github, pr: state.pr, config, logger });
    return { context };
  };

  const prepare = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const { pr, context } = state;
    const repo = { owner: pr.ref.owner, repo: pr.ref.repo };
    const prompt = createReviewPrompt(context, config);
    const prepared = await prepareDiff({
      files: [...context.files],
      config,
      counter,
      contextWindow: llm.contextWindowFor("reviewer"),
      overheadTokens: counter.count(prompt.overheadText),
      loadContent: async (file) => {
        try {
          const content = await github.getFileContent(repo, file.path, pr.headSha);
          return content?.content ?? null;
        } catch (error) {
          logger.debug({ err: error, path: file.path }, "could not load file for context");
          return null;
        }
      },
      ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
    });
    logger.info(
      {
        files: context.files.length,
        included: prepared.included.length,
        omitted: prepared.omitted.length,
        ignored: prepared.ignored.length,
        units: prepared.units.length,
        tokens: prepared.tokens,
        budget: prepared.budget,
      },
      "review diff prepared",
    );
    return { prepared };
  };

  const fanOut = (state: State): Send[] | "mergeFindings" =>
    state.prepared.units.length === 0
      ? "mergeFindings"
      : state.prepared.units.map(
          (unit) =>
            new Send("reviewUnit", {
              unit,
              allFiles: state.prepared.included,
              context: state.context,
            } satisfies ReviewUnitInput),
        );

  const reviewUnit = async (
    input: ReviewUnitInput,
    runnable: RunnableConfig,
  ): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const prompt = createReviewPrompt(input.context, config);
    try {
      const output = await llm.invokeStructured({
        role: "reviewer",
        node: "review.unit",
        schema: ReviewUnitOutputSchema,
        schemaName: "review_findings",
        messages: [prompt.system, prompt.build(input.unit.files, input.allFiles)],
        ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
      });
      return { candidates: output.findings.map(promoteFinding) };
    } catch (error) {
      if (runnable.signal?.aborted === true) {
        throw error;
      }
      logger.error({ err: error, unit: input.unit.id }, "review unit failed");
      return { failures: [`${input.unit.id}: ${describeFailure(error)}`] };
    }
  };

  const mergeFindings = (state: State): Partial<State> => {
    const findings = deduplicateFindings(state.candidates);
    return { findings, counters: { duplicates: state.candidates.length - findings.length } };
  };

  const mergeCiFindings = (state: State): Partial<State> => {
    const changed = new Set(state.context.files.map((file) => file.path));
    const ci = findingsFromAnnotations(state.context.checkAnnotations, changed);
    const merged = deduplicateFindings([...state.findings, ...ci]);
    return { findings: merged, counters: { ciImported: ci.length } };
  };

  const groundFindings = (state: State): Partial<State> => {
    const shown = new Set(state.prepared.included.map((file) => file.path));
    const indexes = new Map(
      state.context.files.map(
        (file) => [file.path, new DiffLineIndex(toFileDiff(file).hunks)] as const,
      ),
    );

    const grounded: Finding[] = [];
    for (const finding of state.findings) {
      const index = indexes.get(finding.path);
      if (!shown.has(finding.path) || index === undefined) {
        continue;
      }
      const range = { startLine: finding.startLine, endLine: finding.endLine };
      const other = finding.side === "RIGHT" ? "LEFT" : "RIGHT";
      const sideValid = index.validateRange({ ...range, side: finding.side }).valid;
      const flipped = !sideValid && index.validateRange({ ...range, side: other }).valid;
      if (sideValid) {
        grounded.push(finding);
      } else if (flipped) {
        grounded.push({ ...finding, side: other });
      }
    }
    return {
      findings: grounded,
      counters: { ungrounded: state.findings.length - grounded.length },
    };
  };

  const filterFindings = (state: State): Partial<State> => {
    const minSeverity = SEVERITY_RANK[config.review.severityThreshold];
    const confident = state.findings.filter(
      (finding) => finding.confidence >= config.review.minConfidence || finding.source === "ci",
    );
    const kept = confident.filter((finding) => SEVERITY_RANK[finding.severity] >= minSeverity);
    return {
      findings: rankFindings(kept),
      counters: {
        belowConfidence: state.findings.length - confident.length,
        belowSeverity: confident.length - kept.length,
      },
    };
  };

  const verify = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const agentic =
      config.review.verifierMode === "agentic" &&
      config.review.maxToolCallsPerReviewer > 0 &&
      config.review.maxInvestigations > 0;
    const investigator = agentic
      ? createInvestigator({
          llm,
          github,
          config,
          logger,
          pr: state.pr,
          changedPaths: state.context.files.map((file) => file.path),
        })
      : undefined;
    const verified = await verifyFindings(llm, config, state.findings, {
      ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
      ...(investigator === undefined ? {} : { investigator }),
      logger,
    });
    // An investigation can lower severity; honour the configured floor again.
    const minSeverity = SEVERITY_RANK[config.review.severityThreshold];
    const kept = verified.kept.filter((finding) => SEVERITY_RANK[finding.severity] >= minSeverity);
    return {
      findings: rankFindings(kept),
      counters: {
        rejectedByVerifier: verified.rejected + (verified.kept.length - kept.length),
        investigated: verified.investigated,
        toolCalls: verified.toolCalls,
        severityRevised: verified.severityRevised,
      },
    };
  };

  const summarize = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const { prepared, context, findings } = state;
    const prompt = createSummaryPrompt(state.pr, config);
    const reviewPrompt = createReviewPrompt(context, config);

    let summary: ReviewSummary;
    try {
      summary = await llm.invokeStructured({
        role: "summarizer",
        node: "review.summarize",
        schema: ReviewSummarySchema,
        schemaName: "review_summary",
        messages: [
          prompt.system,
          prompt.build({
            files: prepared.included,
            commits: context.commits,
            findings,
            omittedFiles: prepared.omitted.length,
          }),
        ],
        ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
      });
    } catch (error) {
      if (runnable.signal?.aborted === true) {
        throw error;
      }
      logger.error({ err: error }, "summary generation failed; using deterministic summary");
      summary = fallbackSummary(findings, prepared.included);
    }

    const notices: string[] = [];
    if (prepared.omitted.length > 0) {
      notices.push(
        `${prepared.omitted.length} file(s) were too large to analyze and are not covered by this review.`,
      );
    }
    if (state.failures.length > 0) {
      notices.push(
        `${state.failures.length} of ${prepared.units.length} review unit(s) failed, so some files may not have been reviewed.`,
      );
    }

    const stats: ReviewStats = {
      candidates: state.candidates.length,
      duplicates: state.counters.duplicates ?? 0,
      ungrounded: state.counters.ungrounded ?? 0,
      belowConfidence: state.counters.belowConfidence ?? 0,
      belowSeverity: state.counters.belowSeverity ?? 0,
      rejectedByVerifier: state.counters.rejectedByVerifier ?? 0,
      investigated: state.counters.investigated ?? 0,
      investigationToolCalls: state.counters.toolCalls ?? 0,
      severityRevised: state.counters.severityRevised ?? 0,
      ciImported: state.counters.ciImported ?? 0,
      failedUnits: state.failures.length,
      units: prepared.units.length,
    };

    const result: ReviewResult = {
      findings,
      summary: sanitizeSummary(
        summary,
        findings,
        new Set(prepared.included.map((file) => file.path)),
      ),
      notices,
      stats,
      promptHashes: { ...reviewPrompt.hashes, ...prompt.hashes },
    };
    return { result };
  };

  return new StateGraph(ReviewState)
    .addNode("fetchContext", fetchContext)
    .addNode("prepareDiff", prepare)
    .addNode("reviewUnit", reviewUnit)
    .addNode("mergeFindings", mergeFindings)
    .addNode("mergeCiFindings", mergeCiFindings)
    .addNode("groundFindings", groundFindings)
    .addNode("filterFindings", filterFindings)
    .addNode("verifyFindings", verify)
    .addNode("summarize", summarize)
    .addEdge(START, "fetchContext")
    .addEdge("fetchContext", "prepareDiff")
    .addConditionalEdges("prepareDiff", fanOut, ["reviewUnit", "mergeFindings"])
    .addEdge("reviewUnit", "mergeFindings")
    .addEdge("mergeFindings", "mergeCiFindings")
    .addEdge("mergeCiFindings", "groundFindings")
    .addEdge("groundFindings", "filterFindings")
    .addEdge("filterFindings", "verifyFindings")
    .addEdge("verifyFindings", "summarize")
    .addEdge("summarize", END)
    .compile();
};

export const runReview = async (
  services: CoreServices,
  pr: PullRequest,
  signal?: AbortSignal,
): Promise<ReviewResult> => {
  const graph = createReviewGraph(services);
  const state = await graph.invoke(
    { pr },
    {
      recursionLimit: services.config.review.maxGraphSteps,
      maxConcurrency: services.config.review.maxConcurrency,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return state.result;
};
