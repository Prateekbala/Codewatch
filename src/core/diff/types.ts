import type { ChangedFile } from "../github/types.ts";

export type LineKind = "context" | "add" | "del";

export type DiffSide = "LEFT" | "RIGHT";

export interface DiffLine {
  readonly kind: LineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly noNewlineAtEof: boolean;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly section: string;
  readonly lines: readonly DiffLine[];
}

export type FileKind = "text" | "deleted" | "rename-only" | "patch-unavailable" | "empty";

export interface FileDiff {
  readonly file: ChangedFile;
  readonly kind: FileKind;
  readonly hunks: readonly Hunk[];
  readonly extendedHunks: readonly Hunk[] | null;
}

export type IgnoreReason = "ignored-glob" | "binary" | "empty";

export interface IgnoredFile {
  readonly path: string;
  readonly reason: IgnoreReason;
  readonly detail: string | null;
}

export type OmitReason = "file-limit" | "budget" | "patch-unavailable";

export interface OmittedFile {
  readonly path: string;
  readonly reason: OmitReason;
}

export type FileCategory = "source" | "config" | "test" | "docs";

export interface IncludedFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: ChangedFile["status"];
  readonly kind: FileKind;
  readonly category: FileCategory;
  readonly score: number;
  readonly additions: number;
  readonly deletions: number;
  readonly text: string;
  readonly tokens: number;
  readonly hunksTotal: number;
  readonly hunksShown: number;
  readonly clipped: boolean;
  readonly extended: boolean;
}

export interface ReviewUnit {
  readonly id: string;
  readonly files: readonly IncludedFile[];
  readonly tokens: number;
}

export interface PreparedDiff {
  readonly included: readonly IncludedFile[];
  readonly units: readonly ReviewUnit[];
  readonly omitted: readonly OmittedFile[];
  readonly ignored: readonly IgnoredFile[];
  readonly tokens: number;
  readonly budget: number;
}
