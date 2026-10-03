import type { IncludedFile, ReviewUnit } from "./types.ts";

const directoryOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

export const groupIntoUnits = (files: readonly IncludedFile[], maxTokens: number): ReviewUnit[] => {
  const ordered = [...files].sort(
    (a, b) =>
      directoryOf(a.path).localeCompare(directoryOf(b.path)) || a.path.localeCompare(b.path),
  );

  const units: ReviewUnit[] = [];
  let current: IncludedFile[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      units.push({ id: `unit-${units.length + 1}`, files: current, tokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
  };

  for (const file of ordered) {
    if (current.length > 0 && currentTokens + file.tokens > maxTokens) {
      flush();
    }
    current.push(file);
    currentTokens += file.tokens;
  }
  flush();

  return units;
};
