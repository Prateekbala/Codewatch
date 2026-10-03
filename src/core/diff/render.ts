import type { ChangedFile } from "../github/types.ts";

import type { DiffLine, FileKind, Hunk } from "./types.ts";

const MARKERS = { context: " ", add: "+", del: "-" } as const;

export const renderLine = (line: DiffLine): string => {
  const marker = MARKERS[line.kind];
  const label = line.kind === "del" ? `L${String(line.oldLine)}` : `R${String(line.newLine)}`;
  return `${label}:${marker}${line.content}`;
};

export const renderHunk = (hunk: Hunk): string => {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${
    hunk.section === "" ? "" : ` ${hunk.section}`
  }`;
  return [header, ...hunk.lines.map(renderLine)].join("\n");
};

export const renderFileHeader = (file: ChangedFile): string => {
  const parts: string[] = [file.status];
  if (file.previousPath !== null && file.previousPath !== file.path) {
    parts.push(`from ${file.previousPath}`);
  }
  parts.push(`+${file.additions} -${file.deletions}`);
  return `### ${file.path} (${parts.join(", ")})`;
};

export const renderFile = (
  file: ChangedFile,
  kind: FileKind,
  hunks: readonly Hunk[],
  note: string | null = null,
): string => {
  const lines = [renderFileHeader(file)];
  if (hunks.length === 0) {
    lines.push(emptyNote(kind));
  } else {
    lines.push(...hunks.map(renderHunk));
  }
  if (note !== null) {
    lines.push(note);
  }
  return lines.join("\n");
};

const emptyNote = (kind: FileKind): string => {
  switch (kind) {
    case "deleted":
      return "[file deleted; content omitted]";
    case "rename-only":
      return "[renamed without content changes]";
    case "patch-unavailable":
      return "[diff too large for GitHub to provide; content omitted]";
    case "empty":
    case "text":
      return "[no textual changes]";
  }
};
