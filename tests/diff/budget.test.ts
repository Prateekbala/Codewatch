import { describe, expect, it } from "vitest";

import { computeDiffBudget, fitFilesToBudget } from "../../src/core/diff/budget.ts";
import { groupIntoUnits } from "../../src/core/diff/chunk.ts";
import { toFileDiff } from "../../src/core/diff/classify.ts";
import { createTokenCounter, charEstimateCounter } from "../../src/core/llm/tokens.ts";
import { changedFile, hunkOnly, readDiffFixture } from "../helpers/fixtures.ts";

const counter = charEstimateCounter(4);

const syntheticPatch = (lines: number, seed: string): string => {
  const body = Array.from({ length: lines }, (_, i) => `+${seed} line ${i} ${"x".repeat(i % 40)}`);
  return [`@@ -0,0 +1,${lines} @@`, ...body].join("\n");
};

const syntheticDiffs = (count: number, linesEach: number) =>
  Array.from({ length: count }, (_, i) =>
    toFileDiff(
      changedFile({
        path: `src/module${i % 7}/file${i}.ts`,
        status: "added",
        additions: linesEach,
        deletions: 0,
        patch: syntheticPatch(linesEach, `f${i}`),
      }),
    ),
  );

describe("computeDiffBudget", () => {
  it("scales the usable window and respects the hard cap", () => {
    const base = {
      contextWindow: 100_000,
      ratio: 0.5,
      reservedOutputTokens: 10_000,
      overheadTokens: 5_000,
    };
    expect(computeDiffBudget(base)).toBe(42_500);
    expect(computeDiffBudget({ ...base, hardCap: 1_000 })).toBe(1_000);
    expect(computeDiffBudget({ ...base, contextWindow: 1_000 })).toBe(0);
  });
});

describe("fitFilesToBudget", () => {
  it("never exceeds the budget for oversized pull requests", () => {
    const diffs = syntheticDiffs(60, 200);
    for (const budget of [0, 10, 100, 500, 2_000, 10_000, 50_000]) {
      const result = fitFilesToBudget(diffs, { budget, perFileMax: 4_000, counter });
      expect(result.tokens).toBeLessThanOrEqual(budget);
      const joined = result.included.map((file) => file.text).join("\n\n");
      expect(counter.count(joined)).toBeLessThanOrEqual(budget);
      for (const file of result.included) {
        expect(file.tokens).toBeLessThanOrEqual(4_000);
      }
      expect(result.included.length + result.omitted.length).toBe(diffs.length);
    }
  });

  it("never exceeds the budget with the real tokenizer", () => {
    const real = createTokenCounter();
    const diffs = syntheticDiffs(30, 120);
    const budget = 3_000;
    const result = fitFilesToBudget(diffs, { budget, perFileMax: 1_500, counter: real });
    const joined = result.included.map((file) => file.text).join("\n\n");
    expect(result.tokens).toBeLessThanOrEqual(budget);
    expect(real.count(joined)).toBeLessThanOrEqual(budget);
  });

  it("clips a single huge hunk to fit", () => {
    const diff = toFileDiff(
      changedFile({
        path: "src/big.ts",
        additions: 2000,
        deletions: 2000,
        patch: hunkOnly(readDiffFixture("huge-hunk")),
      }),
    );
    const result = fitFilesToBudget([diff], { budget: 2_000, perFileMax: 2_000, counter });
    expect(result.included).toHaveLength(1);
    const [file] = result.included;
    expect(file?.clipped).toBe(true);
    expect(file?.tokens).toBeLessThanOrEqual(2_000);
    expect(file?.text).toContain("[hunk clipped]");
  });

  it("clips by whole hunks when some hunks fit", () => {
    const hunkBody = (start: number) =>
      [
        `@@ -${start},20 +${start},20 @@`,
        ...Array.from({ length: 20 }, (_, i) => ` context ${start + i} ${"y".repeat(20)}`),
      ].join("\n");
    const patch = [1, 100, 200, 300, 400, 500].map(hunkBody).join("\n");
    const diff = toFileDiff(changedFile({ path: "src/multi.ts", patch }));

    const full = fitFilesToBudget([diff], { budget: 100_000, perFileMax: 100_000, counter });
    const fullTokens = full.included[0]?.tokens ?? 0;
    const result = fitFilesToBudget([diff], {
      budget: Math.floor(fullTokens * 0.6),
      perFileMax: 100_000,
      counter,
    });
    const [file] = result.included;
    expect(file?.clipped).toBe(true);
    expect(file?.hunksShown).toBeGreaterThan(0);
    expect(file?.hunksShown).toBeLessThan(file?.hunksTotal ?? 0);
    expect(file?.text).toContain("[diff clipped:");
    expect(file?.tokens).toBeLessThanOrEqual(Math.floor(fullTokens * 0.6));
  });

  it("prioritizes source files over docs and tests when the budget is tight", () => {
    const patch = syntheticPatch(40, "p");
    const diffs = [
      toFileDiff(changedFile({ path: "docs/guide.md", patch, additions: 40, deletions: 0 })),
      toFileDiff(changedFile({ path: "tests/a.test.ts", patch, additions: 40, deletions: 0 })),
      toFileDiff(changedFile({ path: "src/core/engine.ts", patch, additions: 40, deletions: 0 })),
    ];
    const single = fitFilesToBudget([diffs[2]!], {
      budget: 100_000,
      perFileMax: 100_000,
      counter,
    }).tokens;
    const result = fitFilesToBudget(diffs, {
      budget: single + 5,
      perFileMax: 100_000,
      counter,
    });
    expect(result.included.map((file) => file.path)).toEqual(["src/core/engine.ts"]);
    expect(result.omitted.map((file) => file.reason)).toEqual(["budget", "budget"]);
  });

  it("lists deleted files cheaply and omits files whose patch GitHub withheld", () => {
    const diffs = [
      toFileDiff(
        changedFile({ path: "src/old.ts", status: "removed", additions: 0, deletions: 400 }),
      ),
      toFileDiff(
        changedFile({ path: "src/huge.ts", additions: 5000, deletions: 5000, patch: null }),
      ),
    ];
    const result = fitFilesToBudget(diffs, { budget: 1_000, perFileMax: 1_000, counter });
    expect(result.included.map((file) => file.path)).toEqual(["src/old.ts"]);
    expect(result.included[0]?.text).toContain("[file deleted; content omitted]");
    expect(result.omitted).toEqual([{ path: "src/huge.ts", reason: "patch-unavailable" }]);
  });
});

describe("groupIntoUnits", () => {
  it("packs files by directory without exceeding the unit budget", () => {
    const diffs = syntheticDiffs(40, 60);
    const { included } = fitFilesToBudget(diffs, {
      budget: 1_000_000,
      perFileMax: 1_000_000,
      counter,
    });
    const maxTokens = 2_500;
    const units = groupIntoUnits(included, maxTokens);

    expect(units.length).toBeGreaterThan(1);
    expect(units.flatMap((unit) => unit.files.map((file) => file.path)).sort()).toEqual(
      included.map((file) => file.path).sort(),
    );
    for (const unit of units) {
      expect(unit.tokens).toBeLessThanOrEqual(maxTokens);
      expect(unit.tokens).toBe(unit.files.reduce((sum, file) => sum + file.tokens, 0));
    }
    expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
  });

  it("returns no units for no files", () => {
    expect(groupIntoUnits([], 1_000)).toEqual([]);
  });
});
