import type { DiffLine, Hunk } from "./types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NO_NEWLINE_MARKER = "\\";

interface HunkBuilder {
  oldStart: number;
  newStart: number;
  declaredOld: number;
  declaredNew: number;
  section: string;
  lines: DiffLine[];
  oldCursor: number;
  newCursor: number;
  seenOld: number;
  seenNew: number;
}

const startHunk = (match: RegExpExecArray): HunkBuilder => {
  const oldStart = Number.parseInt(match[1] ?? "0", 10);
  const declaredOld = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newStart = Number.parseInt(match[3] ?? "0", 10);
  const declaredNew = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  return {
    oldStart,
    newStart,
    declaredOld,
    declaredNew,
    section: (match[5] ?? "").trim(),
    lines: [],
    oldCursor: declaredOld === 0 ? oldStart + 1 : oldStart,
    newCursor: declaredNew === 0 ? newStart + 1 : newStart,
    seenOld: 0,
    seenNew: 0,
  };
};

const isComplete = (builder: HunkBuilder): boolean =>
  builder.seenOld >= builder.declaredOld && builder.seenNew >= builder.declaredNew;

const finishHunk = (builder: HunkBuilder): Hunk => ({
  oldStart: builder.oldStart,
  oldLines: builder.seenOld,
  newStart: builder.newStart,
  newLines: builder.seenNew,
  section: builder.section,
  lines: builder.lines,
});

const appendLine = (builder: HunkBuilder, raw: string): void => {
  const marker = raw.charAt(0);
  const content = raw.slice(1).replace(/\r$/, "");
  switch (marker) {
    case " ":
    case "":
      builder.lines.push({
        kind: "context",
        content,
        oldLine: builder.oldCursor++,
        newLine: builder.newCursor++,
        noNewlineAtEof: false,
      });
      builder.seenOld++;
      builder.seenNew++;
      return;
    case "-":
      builder.lines.push({
        kind: "del",
        content,
        oldLine: builder.oldCursor++,
        newLine: null,
        noNewlineAtEof: false,
      });
      builder.seenOld++;
      return;
    case "+":
      builder.lines.push({
        kind: "add",
        content,
        oldLine: null,
        newLine: builder.newCursor++,
        noNewlineAtEof: false,
      });
      builder.seenNew++;
      return;
    default:
      return;
  }
};

const markNoNewline = (builder: HunkBuilder): void => {
  const last = builder.lines.at(-1);
  if (last) {
    builder.lines[builder.lines.length - 1] = { ...last, noNewlineAtEof: true };
  }
};

export const parsePatch = (patch: string): Hunk[] => {
  const hunks: Hunk[] = [];
  let current: HunkBuilder | null = null;

  const flush = (): void => {
    if (current) {
      hunks.push(finishHunk(current));
      current = null;
    }
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith(NO_NEWLINE_MARKER)) {
      if (current) {
        markNoNewline(current);
      }
      continue;
    }

    const header = raw.startsWith("@@") ? HUNK_HEADER.exec(raw.replace(/\r$/, "")) : null;
    if (header) {
      flush();
      current = startHunk(header);
      continue;
    }

    if (current && !isComplete(current)) {
      appendLine(current, raw);
    }
  }

  flush();
  return hunks;
};

export const lastLineNumbers = (hunk: Hunk): { oldEnd: number; newEnd: number } => ({
  oldEnd: hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldLines - 1,
  newEnd: hunk.newLines === 0 ? hunk.newStart : hunk.newStart + hunk.newLines - 1,
});

export const firstLineNumbers = (hunk: Hunk): { oldFirst: number; newFirst: number } => ({
  oldFirst: hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart,
  newFirst: hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart,
});
