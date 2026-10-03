import { readFileSync } from "node:fs";

import type { ChangedFile } from "../../src/core/github/types.ts";

const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

export const readDiffFixture = (name: string): string =>
  readFileSync(new URL(`diffs/${name}.diff`, FIXTURE_ROOT), "utf8");

export const readFileFixture = (name: string): string =>
  readFileSync(new URL(`files/${name}`, FIXTURE_ROOT), "utf8");

export const hunkOnly = (diff: string): string => {
  const index = diff.search(/^@@/m);
  return index < 0 ? "" : diff.slice(index);
};

export const changedFile = (overrides: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: null,
  sha: "abc123",
  ...overrides,
});
