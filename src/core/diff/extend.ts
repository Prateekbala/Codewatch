import { firstLineNumbers, lastLineNumbers } from "./parse.ts";
import { splitLines } from "./text.ts";
import type { DiffLine, Hunk } from "./types.ts";

export interface ExtendOptions {
  readonly before: number;
  readonly after: number;
  readonly maxDynamicBefore: number;
}

interface Accumulator {
  lines: DiffLine[];
  section: string;
  oldStart: number;
  newStart: number;
  coveredNewEnd: number;
}

const contextLine = (content: string, newLine: number, shift: number): DiffLine => ({
  kind: "context",
  content,
  oldLine: newLine + shift,
  newLine,
  noNewlineAtEof: false,
});

export const matchesNewContent = (hunks: readonly Hunk[], newLines: readonly string[]): boolean =>
  hunks.every((hunk) =>
    hunk.lines.every(
      (line) => line.newLine === null || newLines[line.newLine - 1] === line.content,
    ),
  );

const dynamicBefore = (
  hunk: Hunk,
  newLines: readonly string[],
  floor: number,
  options: ExtendOptions,
): number => {
  const { newFirst } = firstLineNumbers(hunk);
  const available = Math.max(0, newFirst - floor);
  const base = Math.min(options.before, available);
  if (hunk.section === "" || options.maxDynamicBefore <= base) {
    return base;
  }
  const limit = Math.min(options.maxDynamicBefore, available);
  for (let distance = 1; distance <= limit; distance++) {
    const candidate = newLines[newFirst - distance - 1];
    if (candidate?.includes(hunk.section)) {
      return Math.max(base, distance);
    }
  }
  return base;
};

const sectionVisible = (section: string, lines: readonly DiffLine[]): boolean =>
  section !== "" && lines.some((line) => line.content.includes(section));

const finalize = (acc: Accumulator): Hunk => {
  const oldLines = acc.lines.filter((line) => line.oldLine !== null).length;
  const newLines = acc.lines.filter((line) => line.newLine !== null).length;
  const firstOld = acc.lines.find((line) => line.oldLine !== null)?.oldLine ?? null;
  const firstNew = acc.lines.find((line) => line.newLine !== null)?.newLine ?? null;
  const prefixLength = acc.lines.findIndex((line) => line.kind !== "context");
  const prefix = prefixLength < 0 ? acc.lines : acc.lines.slice(0, prefixLength);
  return {
    oldStart: firstOld ?? acc.oldStart,
    oldLines,
    newStart: firstNew ?? acc.newStart,
    newLines,
    section: sectionVisible(acc.section, prefix) ? "" : acc.section,
    lines: acc.lines,
  };
};

export const extendHunks = (
  hunks: readonly Hunk[],
  newContent: string,
  options: ExtendOptions,
): readonly Hunk[] => {
  if (hunks.length === 0 || (options.before === 0 && options.after === 0)) {
    return hunks;
  }
  const newLines = splitLines(newContent);
  if (newLines.length === 0 || !matchesNewContent(hunks, newLines)) {
    return hunks;
  }

  const total = newLines.length;
  const output: Accumulator[] = [];
  let shift = 0;

  hunks.forEach((hunk, index) => {
    const { newFirst } = firstLineNumbers(hunk);
    const { oldEnd, newEnd } = lastLineNumbers(hunk);
    const previous = output.at(-1);
    const floor = previous ? previous.coveredNewEnd + 1 : 1;
    const before = dynamicBefore(hunk, newLines, floor, options);
    const prefixStart = newFirst - before;

    let target: Accumulator;
    if (previous && prefixStart <= previous.coveredNewEnd + 1) {
      target = previous;
      for (let n = previous.coveredNewEnd + 1; n < newFirst; n++) {
        target.lines.push(contextLine(newLines[n - 1] ?? "", n, shift));
      }
    } else {
      target = {
        lines: [],
        section: hunk.section,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        coveredNewEnd: 0,
      };
      for (let n = prefixStart; n < newFirst; n++) {
        target.lines.push(contextLine(newLines[n - 1] ?? "", n, shift));
      }
      output.push(target);
    }

    target.lines.push(...hunk.lines);
    shift = oldEnd - newEnd;

    const next = hunks[index + 1];
    const nextFirst = next ? firstLineNumbers(next).newFirst : total + 1;
    const suffixEnd = Math.min(total, newEnd + options.after, nextFirst - 1);
    for (let n = newEnd + 1; n <= suffixEnd; n++) {
      target.lines.push(contextLine(newLines[n - 1] ?? "", n, shift));
    }
    target.coveredNewEnd = Math.max(newEnd, suffixEnd);
  });

  return output.map(finalize);
};
