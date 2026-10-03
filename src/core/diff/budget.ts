import type { TokenCounter } from "../llm/tokens.ts";

import { scoreFile } from "./priority.ts";
import { renderFile } from "./render.ts";
import type { FileDiff, Hunk, IncludedFile, OmittedFile } from "./types.ts";

export interface BudgetInput {
  readonly contextWindow: number;
  readonly ratio: number;
  readonly reservedOutputTokens: number;
  readonly overheadTokens: number;
  readonly hardCap?: number;
}

export const computeDiffBudget = (input: BudgetInput): number => {
  const usable = input.contextWindow - input.reservedOutputTokens - input.overheadTokens;
  const scaled = Math.floor(Math.max(0, usable) * input.ratio);
  return input.hardCap === undefined ? scaled : Math.min(scaled, input.hardCap);
};

export interface FitOptions {
  readonly budget: number;
  readonly perFileMax: number;
  readonly counter: TokenCounter;
}

export interface FitResult {
  readonly included: IncludedFile[];
  readonly omitted: OmittedFile[];
  readonly tokens: number;
}

const SEPARATOR_TOKENS = 2;
const MIN_CLIP_TOKENS = 120;

interface Candidate {
  readonly diff: FileDiff;
  readonly score: number;
  readonly category: IncludedFile["category"];
}

const clippedNote = (shown: number, total: number): string =>
  `[diff clipped: showing ${shown} of ${total} hunks]`;

const buildIncluded = (
  candidate: Candidate,
  text: string,
  tokens: number,
  hunksShown: number,
  extended: boolean,
  clipped: boolean,
): IncludedFile => {
  const { file, kind, hunks } = candidate.diff;
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    kind,
    category: candidate.category,
    score: candidate.score,
    additions: file.additions,
    deletions: file.deletions,
    text,
    tokens,
    hunksTotal: hunks.length,
    hunksShown,
    clipped,
    extended,
  };
};

const clipHunkLines = (
  diff: FileDiff,
  hunk: Hunk,
  allowance: number,
  counter: TokenCounter,
): { hunk: Hunk; text: string; tokens: number } | null => {
  const render = (lines: number): { hunk: Hunk; text: string; tokens: number } => {
    const clippedHunk: Hunk = { ...hunk, lines: hunk.lines.slice(0, lines) };
    const text = renderFile(diff.file, diff.kind, [clippedHunk], "[hunk clipped]");
    return { hunk: clippedHunk, text, tokens: counter.count(text) + SEPARATOR_TOKENS };
  };

  let low = 1;
  let high = hunk.lines.length;
  let best: ReturnType<typeof render> | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const attempt = render(mid);
    if (attempt.tokens <= allowance) {
      best = attempt;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
};

const fitCandidate = (
  candidate: Candidate,
  allowance: number,
  counter: TokenCounter,
): IncludedFile | null => {
  const { diff } = candidate;
  const render = (hunks: readonly Hunk[], note: string | null = null) => {
    const text = renderFile(diff.file, diff.kind, hunks, note);
    return { text, tokens: counter.count(text) + SEPARATOR_TOKENS };
  };

  if (diff.extendedHunks) {
    const full = render(diff.extendedHunks);
    if (full.tokens <= allowance) {
      return buildIncluded(candidate, full.text, full.tokens, diff.hunks.length, true, false);
    }
  }

  const plain = render(diff.hunks);
  if (plain.tokens <= allowance) {
    return buildIncluded(candidate, plain.text, plain.tokens, diff.hunks.length, false, false);
  }

  if (allowance < MIN_CLIP_TOKENS) {
    return null;
  }

  let low = 1;
  let high = diff.hunks.length - 1;
  let keptCount = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const trial = render(diff.hunks.slice(0, mid), clippedNote(mid, diff.hunks.length));
    if (trial.tokens <= allowance) {
      keptCount = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (keptCount > 0) {
    const kept = diff.hunks.slice(0, keptCount);
    const result = render(kept, clippedNote(keptCount, diff.hunks.length));
    return buildIncluded(candidate, result.text, result.tokens, keptCount, false, true);
  }

  const first = diff.hunks[0];
  if (!first) {
    return null;
  }
  const clippedFirst = clipHunkLines(diff, first, allowance, counter);
  return clippedFirst
    ? buildIncluded(candidate, clippedFirst.text, clippedFirst.tokens, 1, false, true)
    : null;
};

export const fitFilesToBudget = (diffs: readonly FileDiff[], options: FitOptions): FitResult => {
  const candidates: Candidate[] = diffs
    .map((diff) => ({ diff, ...scoreFile(diff.file) }))
    .sort((a, b) => b.score - a.score || a.diff.file.path.localeCompare(b.diff.file.path));

  const included: IncludedFile[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const { kind } = candidate.diff;
    if (kind === "patch-unavailable") {
      omitted.push({ path: candidate.diff.file.path, reason: "patch-unavailable" });
      continue;
    }
    const allowance = Math.min(options.perFileMax, options.budget - used);
    const result = allowance > 0 ? fitCandidate(candidate, allowance, options.counter) : null;
    if (result) {
      included.push(result);
      used += result.tokens;
    } else {
      omitted.push({ path: candidate.diff.file.path, reason: "budget" });
    }
  }

  return { included, omitted, tokens: used };
};
