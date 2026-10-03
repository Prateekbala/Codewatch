import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CostTracker } from "../../src/core/llm/cost.ts";
import { LlmGateway } from "../../src/core/llm/gateway.ts";
import { charEstimateCounter } from "../../src/core/llm/tokens.ts";
import { toFileDiff } from "../../src/core/diff/classify.ts";
import { DiffLineIndex } from "../../src/core/diff/line-index.ts";
import { MemoryGitHubClient } from "../../evals/memory-client.ts";
import {
  compareReports,
  runEval,
  summarize,
  type EvalServicesFactory,
} from "../../evals/runner.ts";
import { ratios, scoreCase } from "../../evals/scoring.ts";
import { loadEvalCases } from "../../evals/types.ts";
import { ScriptedLlm, silentLogger, testConfig } from "../helpers/fakes.ts";
import { llmFinding, summaryOutput } from "../helpers/review.ts";

const casesDir = join(import.meta.dirname, "../../evals/cases");

describe("scoreCase", () => {
  const expected = [{ path: "a.ts", startLine: 10, endLine: 10 }];

  it("matches within the line tolerance", () => {
    const score = scoreCase(expected, [{ path: "a.ts", startLine: 12, endLine: 12 }]);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("rejects other files and distant lines", () => {
    const score = scoreCase(expected, [
      { path: "b.ts", startLine: 10, endLine: 10 },
      { path: "a.ts", startLine: 20, endLine: 20 },
    ]);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 2, falseNegatives: 1 });
    expect(score.missed).toEqual(expected);
  });

  it("lets one expected finding absorb only one reported finding", () => {
    const score = scoreCase(expected, [
      { path: "a.ts", startLine: 10, endLine: 10 },
      { path: "a.ts", startLine: 11, endLine: 11 },
    ]);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 1 });
  });

  it("treats clean cases as perfect only when nothing is reported", () => {
    expect(ratios(scoreCase([], []))).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(ratios(scoreCase([], [{ path: "a.ts", startLine: 1, endLine: 1 }])).precision).toBe(0);
  });
});

describe("bundled eval cases", () => {
  const cases = loadEvalCases(casesDir);

  it("has a mix of defective and clean cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.some((item) => item.expected.length === 0)).toBe(true);
    expect(cases.some((item) => item.expected.length > 0)).toBe(true);
  });

  it.each(cases.map((item) => [item.id, item] as const))(
    "%s: expected findings point at lines inside the diff",
    async (_id, item) => {
      const files = await new MemoryGitHubClient(item).listFiles();
      const indexes = new Map(
        files.map((file) => [file.path, new DiffLineIndex(toFileDiff(file).hunks)]),
      );
      for (const target of item.expected) {
        const index = indexes.get(target.path);
        expect(index, target.path).toBeDefined();
        expect(
          index?.validateRange({
            side: "RIGHT",
            startLine: target.startLine,
            endLine: target.endLine,
          }),
        ).toEqual({ valid: true });
      }
    },
  );

  it("rejects unknown case ids", () => {
    expect(() => loadEvalCases(casesDir, ["nope"])).toThrow("unknown eval case");
  });
});

describe("runEval", () => {
  const cases = loadEvalCases(casesDir, ["missing-await", "clean-docs"]);

  const factoryFor = (llm: ScriptedLlm): EvalServicesFactory => {
    const config = testConfig({ review: { enableVerifier: false } });
    return (client) => {
      const tracker = CostTracker.fromConfig(config);
      return {
        services: {
          github: client,
          llm: new LlmGateway({
            config,
            tracker,
            adapterFactory: llm.factory,
            logger: silentLogger,
          }),
          config,
          logger: silentLogger,
          counter: charEstimateCounter(4),
        },
        usage: () => tracker.summary(),
      };
    };
  };

  it("scores a perfect run, including a noisy clean case", async () => {
    const llm = new ScriptedLlm({
      "gpt-5": [
        { parsed: { findings: [] } },
        {
          parsed: { findings: [llmFinding({ path: "src/users.ts", startLine: 14, endLine: 14 })] },
        },
      ],
      "gpt-5-mini": [{ parsed: summaryOutput }, { parsed: summaryOutput }],
    });

    const report = await runEval({
      cases,
      createServices: factoryFor(llm),
      label: "test",
      concurrency: 1,
    });

    expect(report.totals).toMatchObject({
      cases: 2,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      erroredCases: 0,
    });
    expect(report.totals.tokens).toBeGreaterThan(0);
  });

  it("records provider errors as misses instead of aborting the run", async () => {
    const llm = new ScriptedLlm({
      "gpt-5": [{ error: new Error("down") }],
      "gpt-5-mini": [{ error: new Error("down") }],
    });

    const report = await runEval({
      cases: cases.filter((item) => item.id === "missing-await"),
      createServices: factoryFor(llm),
      label: "test",
      concurrency: 1,
    });

    expect(report.cases[0]).toMatchObject({ falseNegatives: 1, failedUnits: 1 });
    expect(report.totals.recall).toBe(0);
  });

  it("flags regressions beyond the tolerance", () => {
    const good = summarize([
      {
        id: "a",
        expected: 1,
        found: 1,
        truePositives: 1,
        falsePositives: 0,
        falseNegatives: 0,
        missed: [],
        unexpected: [],
        tokens: 10,
        costUsd: 0.01,
        durationMs: 1,
        failedUnits: 0,
        error: null,
      },
    ]);
    const base = { startedAt: "t", label: "x", cases: [] };
    const worse = { ...good, precision: 0.8, recall: 1 };
    expect(compareReports({ ...base, totals: worse }, { ...base, totals: good }).regressed).toBe(
      true,
    );
    expect(compareReports({ ...base, totals: good }, { ...base, totals: good }).regressed).toBe(
      false,
    );
  });
});
