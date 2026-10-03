import type { ChangedFile } from "../github/types.ts";

import { parsePatch } from "./parse.ts";
import type { FileDiff, FileKind } from "./types.ts";

const isRename = (file: ChangedFile): boolean =>
  file.status === "renamed" || file.status === "copied";

const classify = (file: ChangedFile, hasHunks: boolean): FileKind => {
  if (file.status === "removed") {
    return "deleted";
  }
  if (hasHunks) {
    return "text";
  }
  if (file.patch === null && file.additions + file.deletions > 0) {
    return "patch-unavailable";
  }
  return isRename(file) ? "rename-only" : "empty";
};

export const toFileDiff = (file: ChangedFile): FileDiff => {
  const hunks = file.patch === null ? [] : parsePatch(file.patch);
  return { file, kind: classify(file, hunks.length > 0), hunks, extendedHunks: null };
};
