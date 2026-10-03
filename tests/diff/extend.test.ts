import { describe, expect, it } from "vitest";

import { extendHunks } from "../../src/core/diff/extend.ts";
import { parsePatch } from "../../src/core/diff/parse.ts";
import type { Hunk } from "../../src/core/diff/types.ts";
import { readDiffFixture, readFileFixture } from "../helpers/fixtures.ts";

const oldMulti = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);

const newMulti = (() => {
  const lines = [...oldMulti];
  lines[4] = "line 5 changed";
  lines[49] = "line 50 changed";
  lines.splice(50, 0, "inserted after 50");
  lines.splice(89, 1);
  return lines;
})();

const expectConsistent = (
  hunks: readonly Hunk[],
  oldLines: readonly string[],
  newLines: readonly string[],
): void => {
  let previousNewEnd = 0;
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((line) => line.oldLine !== null).length;
    const newCount = hunk.lines.filter((line) => line.newLine !== null).length;
    expect(hunk.oldLines).toBe(oldCount);
    expect(hunk.newLines).toBe(newCount);

    for (const line of hunk.lines) {
      if (line.kind !== "add") {
        expect(oldLines[line.oldLine! - 1]).toBe(line.content);
      }
      if (line.kind !== "del") {
        expect(newLines[line.newLine! - 1]).toBe(line.content);
        expect(line.newLine!).toBeGreaterThan(previousNewEnd);
        previousNewEnd = line.newLine!;
      }
    }
  }
};

describe("extendHunks", () => {
  it("keeps old and new line numbers consistent for every context size", () => {
    for (const fixture of ["multi-hunk", "zero-context"]) {
      const hunks = parsePatch(readDiffFixture(fixture));
      for (const before of [0, 1, 3, 10, 40, 200]) {
        for (const after of [0, 1, 3, 10, 40, 200]) {
          const extended = extendHunks(hunks, newMulti.join("\n") + "\n", {
            before,
            after,
            maxDynamicBefore: 0,
          });
          expectConsistent(extended, oldMulti, newMulti);
        }
      }
    }
  });

  it("merges hunks whose extended context touches", () => {
    const hunks = parsePatch(readDiffFixture("zero-context"));
    const extended = extendHunks(hunks, newMulti.join("\n") + "\n", {
      before: 60,
      after: 60,
      maxDynamicBefore: 0,
    });
    expect(extended).toHaveLength(1);
    expect(extended[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expectConsistent(extended, oldMulti, newMulti);
  });

  it("keeps separate hunks when context does not reach the neighbour", () => {
    const hunks = parsePatch(readDiffFixture("multi-hunk"));
    const extended = extendHunks(hunks, newMulti.join("\n") + "\n", {
      before: 5,
      after: 5,
      maxDynamicBefore: 0,
    });
    expect(extended).toHaveLength(3);
    expect(extended[0]?.lines.length).toBeGreaterThan(hunks[0]?.lines.length ?? 0);
  });

  it("extends backwards to the enclosing section when the header is nearby", () => {
    const hunks = parsePatch(readDiffFixture("function-context"));
    const content = readFileFixture("function-context.new.py");

    const dynamic = extendHunks(hunks, content, { before: 1, after: 1, maxDynamicBefore: 25 });
    expect(dynamic[0]?.lines[0]).toMatchObject({ newLine: 4, content: "class Service:" });
    expect(dynamic[0]?.section).toBe("");

    const fixed = extendHunks(hunks, content, { before: 1, after: 1, maxDynamicBefore: 0 });
    expect(fixed[0]?.lines[0]?.newLine).toBe(8);
    expect(fixed[0]?.section).toBe("class Service:");
  });

  it("never extends past the start or end of the file", () => {
    const hunks = parsePatch(readDiffFixture("function-context"));
    const content = readFileFixture("function-context.new.py");
    const total = content.split("\n").length - 1;
    const [hunk] = extendHunks(hunks, content, { before: 500, after: 500, maxDynamicBefore: 0 });
    expect(hunk?.lines[0]?.newLine).toBe(1);
    expect(hunk?.lines.at(-1)?.newLine).toBe(total);
  });

  it("returns the original hunks when the file content does not match the patch", () => {
    const hunks = parsePatch(readDiffFixture("multi-hunk"));
    const result = extendHunks(hunks, "completely\ndifferent\ncontent\n", {
      before: 5,
      after: 5,
      maxDynamicBefore: 10,
    });
    expect(result).toBe(hunks);
  });

  it("returns the original hunks when no extension is requested", () => {
    const hunks = parsePatch(readDiffFixture("multi-hunk"));
    expect(
      extendHunks(hunks, newMulti.join("\n"), { before: 0, after: 0, maxDynamicBefore: 5 }),
    ).toBe(hunks);
  });

  it("handles CRLF file content", () => {
    const hunks = parsePatch(readDiffFixture("crlf"));
    const extended = extendHunks(hunks, "a\r\nb\r\nC\r\nd\r\ne\r\nf\r\n", {
      before: 2,
      after: 2,
      maxDynamicBefore: 0,
    });
    expect(extended[0]?.lines.at(-1)).toMatchObject({ newLine: 6, content: "f" });
  });
});
