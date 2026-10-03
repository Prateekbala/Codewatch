import type { DiffLine, DiffSide, Hunk } from "./types.ts";

export interface LineRange {
  readonly side: DiffSide;
  readonly startLine: number;
  readonly endLine: number;
}

export type RangeValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "inverted" | "not-in-diff" | "spans-hunks" };

export class DiffLineIndex {
  readonly #left = new Map<number, { line: DiffLine; hunk: number }>();
  readonly #right = new Map<number, { line: DiffLine; hunk: number }>();

  constructor(hunks: readonly Hunk[]) {
    hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) {
        if (line.oldLine !== null) {
          this.#left.set(line.oldLine, { line, hunk: hunkIndex });
        }
        if (line.newLine !== null) {
          this.#right.set(line.newLine, { line, hunk: hunkIndex });
        }
      }
    });
  }

  lineAt(side: DiffSide, number: number): DiffLine | null {
    return this.#map(side).get(number)?.line ?? null;
  }

  hasLine(side: DiffSide, number: number): boolean {
    return this.#map(side).has(number);
  }

  isChanged(side: DiffSide, number: number): boolean {
    const line = this.lineAt(side, number);
    return line !== null && line.kind !== "context";
  }

  validateRange(range: LineRange): RangeValidation {
    if (range.endLine < range.startLine) {
      return { valid: false, reason: "inverted" };
    }
    const map = this.#map(range.side);
    const first = map.get(range.startLine);
    const last = map.get(range.endLine);
    if (!first || !last) {
      return { valid: false, reason: "not-in-diff" };
    }
    if (first.hunk !== last.hunk) {
      return { valid: false, reason: "spans-hunks" };
    }
    for (let line = range.startLine + 1; line < range.endLine; line++) {
      if (!map.has(line)) {
        return { valid: false, reason: "not-in-diff" };
      }
    }
    return { valid: true };
  }

  mapOldToNew(oldLine: number): number | null {
    return this.#left.get(oldLine)?.line.newLine ?? null;
  }

  mapNewToOld(newLine: number): number | null {
    return this.#right.get(newLine)?.line.oldLine ?? null;
  }

  #map(side: DiffSide): Map<number, { line: DiffLine; hunk: number }> {
    return side === "LEFT" ? this.#left : this.#right;
  }
}
