import picomatch from "picomatch";

import { DEFAULT_BINARY_EXTENSIONS } from "../config/defaults.ts";
import type { ChangedFile } from "../github/types.ts";

import type { IgnoredFile } from "./types.ts";

export interface FilterOptions {
  readonly ignoreGlobs: readonly string[];
  readonly allowGlobs: readonly string[];
  readonly binaryExtensions?: readonly string[];
}

export interface FilterResult {
  readonly kept: ChangedFile[];
  readonly ignored: IgnoredFile[];
}

const MATCH_OPTIONS = { dot: true, nocase: false } as const;

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

const compile = (globs: readonly string[]): ((path: string) => boolean) | null =>
  globs.length === 0 ? null : picomatch([...globs], MATCH_OPTIONS);

export const isBinaryPath = (
  path: string,
  extensions: readonly string[] = DEFAULT_BINARY_EXTENSIONS,
): boolean => extensions.includes(extensionOf(path));

const firstMatchingGlob = (path: string, globs: readonly string[]): string | null =>
  globs.find((glob) => picomatch.isMatch(path, glob, MATCH_OPTIONS)) ?? null;

export const filterFiles = (
  files: readonly ChangedFile[],
  options: FilterOptions,
): FilterResult => {
  const isIgnored = compile(options.ignoreGlobs);
  const isAllowed = compile(options.allowGlobs);
  const binaryExtensions = options.binaryExtensions ?? DEFAULT_BINARY_EXTENSIONS;

  const kept: ChangedFile[] = [];
  const ignored: IgnoredFile[] = [];

  for (const file of files) {
    const allowed = isAllowed?.(file.path) ?? false;
    if (!allowed && isIgnored?.(file.path)) {
      ignored.push({
        path: file.path,
        reason: "ignored-glob",
        detail: firstMatchingGlob(file.path, options.ignoreGlobs),
      });
      continue;
    }
    if (isBinaryPath(file.path, binaryExtensions)) {
      ignored.push({ path: file.path, reason: "binary", detail: extensionOf(file.path) });
      continue;
    }
    kept.push(file);
  }

  return { kept, ignored };
};
