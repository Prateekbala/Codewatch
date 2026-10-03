import type { Config } from "../config/schema.ts";
import type { ChangedFile } from "../github/types.ts";
import type { TokenCounter } from "../llm/tokens.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";

import { computeDiffBudget, fitFilesToBudget } from "./budget.ts";
import { toFileDiff } from "./classify.ts";
import { groupIntoUnits } from "./chunk.ts";
import { extendHunks } from "./extend.ts";
import { filterFiles } from "./filter.ts";
import { scoreFile } from "./priority.ts";
import type { FileDiff, OmittedFile, PreparedDiff } from "./types.ts";

export type ContentLoader = (file: ChangedFile) => Promise<string | null>;

export interface PrepareDiffInput {
  readonly files: readonly ChangedFile[];
  readonly config: Config;
  readonly counter: TokenCounter;
  readonly contextWindow: number;
  readonly overheadTokens: number;
  readonly loadContent?: ContentLoader;
  readonly signal?: AbortSignal;
}

const CONTENT_FETCH_CONCURRENCY = 8;

const withExtension = async (
  diff: FileDiff,
  config: Config,
  loadContent: ContentLoader,
): Promise<FileDiff> => {
  if (diff.kind !== "text") {
    return diff;
  }
  const content = await loadContent(diff.file);
  if (content === null || content.length > config.diff.maxFileBytes) {
    return diff;
  }
  const extended = extendHunks(diff.hunks, content, {
    before: config.diff.contextLinesBefore,
    after: config.diff.contextLinesAfter,
    maxDynamicBefore: config.diff.maxDynamicContextLines,
  });
  return extended === diff.hunks ? diff : { ...diff, extendedHunks: extended };
};

export const prepareDiff = async (input: PrepareDiffInput): Promise<PreparedDiff> => {
  const { config, counter } = input;

  const { kept, ignored } = filterFiles(input.files, {
    ignoreGlobs: config.ignore.globs,
    allowGlobs: config.ignore.allowGlobs,
  });

  const ranked = [...kept].sort(
    (a, b) => scoreFile(b).score - scoreFile(a).score || a.path.localeCompare(b.path),
  );
  const accepted = ranked.slice(0, config.diff.maxFiles);
  const overLimit: OmittedFile[] = ranked
    .slice(config.diff.maxFiles)
    .map((file) => ({ path: file.path, reason: "file-limit" }));

  const parsed = accepted.map(toFileDiff);
  const loader = input.loadContent;
  const diffs = loader
    ? await mapWithConcurrency(
        parsed,
        CONTENT_FETCH_CONCURRENCY,
        (diff) => withExtension(diff, config, loader),
        input.signal,
      )
    : parsed;

  const budget = computeDiffBudget({
    contextWindow: input.contextWindow,
    ratio: config.diff.promptBudgetRatio,
    reservedOutputTokens: config.diff.reservedOutputTokens,
    overheadTokens: input.overheadTokens,
    hardCap: config.diff.maxTotalTokens,
  });

  const fitted = fitFilesToBudget(diffs, {
    budget,
    perFileMax: config.diff.unitTokenBudget,
    counter,
  });

  return {
    included: fitted.included,
    units: groupIntoUnits(fitted.included, config.diff.unitTokenBudget),
    omitted: [...fitted.omitted, ...overLimit],
    ignored,
    tokens: fitted.tokens,
    budget,
  };
};
