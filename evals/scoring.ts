import type { ExpectedFinding } from "./types.ts";

export const LINE_TOLERANCE = 2;

export interface ReportedFinding {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface CaseScore<F extends ReportedFinding = ReportedFinding> {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly missed: readonly ExpectedFinding[];
  readonly unexpected: readonly F[];
}

export interface Ratios {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

const matches = (expected: ExpectedFinding, found: ReportedFinding): boolean =>
  expected.path === found.path &&
  found.startLine <= expected.endLine + LINE_TOLERANCE &&
  found.endLine >= expected.startLine - LINE_TOLERANCE;

export const scoreCase = <F extends ReportedFinding>(
  expected: readonly ExpectedFinding[],
  found: readonly F[],
): CaseScore<F> => {
  const claimed = new Set<number>();
  const missed: ExpectedFinding[] = [];

  for (const target of expected) {
    const index = found.findIndex(
      (candidate, position) => !claimed.has(position) && matches(target, candidate),
    );
    if (index < 0) {
      missed.push(target);
    } else {
      claimed.add(index);
    }
  }

  const unexpected = found.filter((_, position) => !claimed.has(position));
  return {
    truePositives: claimed.size,
    falsePositives: unexpected.length,
    falseNegatives: missed.length,
    missed,
    unexpected,
  };
};

export const ratios = (
  counts: Pick<CaseScore, "truePositives" | "falsePositives" | "falseNegatives">,
): Ratios => {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = counts;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
};
