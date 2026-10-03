import { describe, expect, it } from "vitest";

import { DiffLineIndex } from "../../src/core/diff/line-index.ts";
import { parsePatch } from "../../src/core/diff/parse.ts";
import { hunkOnly, readDiffFixture } from "../helpers/fixtures.ts";

describe("parsePatch", () => {
  it("parses multiple hunks with accurate old and new line numbers", () => {
    const hunks = parsePatch(readDiffFixture("multi-hunk"));

    expect(hunks).toHaveLength(3);
    const [first, second, third] = hunks;
    expect(first).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(second).toMatchObject({ oldStart: 47, oldLines: 7, newStart: 47, newLines: 8 });
    expect(third).toMatchObject({ oldStart: 86, oldLines: 7, newStart: 87, newLines: 6 });

    const added = second?.lines.filter((line) => line.kind === "add");
    expect(added?.map((line) => line.newLine)).toEqual([50, 51]);
    const deleted = third?.lines.find((line) => line.kind === "del");
    expect(deleted).toMatchObject({ oldLine: 89, newLine: null, content: "line 89" });
  });

  it("produces identical hunks for GitHub-style hunk-only patches", () => {
    const full = readDiffFixture("multi-hunk");
    expect(parsePatch(hunkOnly(full))).toEqual(parsePatch(full));
  });

  it("keeps section headers", () => {
    const [hunk] = parsePatch(readDiffFixture("function-context"));
    expect(hunk?.section).toBe("class Service:");
  });

  it("marks lines that precede a no-newline-at-eof marker", () => {
    const [hunk] = parsePatch(readDiffFixture("no-newline-at-eof"));
    const flagged = hunk?.lines.filter((line) => line.noNewlineAtEof);
    expect(flagged?.map((line) => [line.kind, line.content])).toEqual([
      ["del", "three"],
      ["add", "three changed"],
    ]);
    expect(hunk?.lines.map((line) => line.content)).not.toContain("\\ No newline at end of file");
  });

  it("treats content lines that look like file headers as content", () => {
    const [hunk] = parsePatch(readDiffFixture("dash-prefixed-content"));
    expect(hunk?.lines.map((line) => [line.kind, line.content])).toEqual([
      ["context", "keep"],
      ["del", "-- old comment"],
      ["del", "++ plus plus"],
      ["add", "-- new comment"],
      ["add", "++ plus plus changed"],
      ["context", "end"],
    ]);
  });

  it("strips carriage returns from CRLF content", () => {
    const [hunk] = parsePatch(readDiffFixture("crlf"));
    expect(hunk?.lines.every((line) => !line.content.includes("\r"))).toBe(true);
    expect(hunk?.lines.find((line) => line.kind === "add")?.content).toBe("C");
  });

  it("parses zero-context hunks with the git convention for empty ranges", () => {
    const hunks = parsePatch(readDiffFixture("zero-context"));
    expect(hunks).toHaveLength(3);
    const [, , pureDeletion] = hunks;
    expect(pureDeletion).toMatchObject({ oldStart: 89, oldLines: 1, newStart: 89, newLines: 0 });
    expect(pureDeletion?.lines).toEqual([
      { kind: "del", content: "line 89", oldLine: 89, newLine: null, noNewlineAtEof: false },
    ]);
  });

  it("parses a deleted file as a single all-deletion hunk", () => {
    const [hunk] = parsePatch(readDiffFixture("deleted"));
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 });
    expect(hunk?.lines.every((line) => line.kind === "del")).toBe(true);
  });

  it("parses an added file as a single all-addition hunk", () => {
    const [hunk] = parsePatch(readDiffFixture("added"));
    expect(hunk).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(hunk?.lines.map((line) => line.newLine)).toEqual([1, 2]);
  });

  it("returns no hunks for binary and rename-only diffs", () => {
    expect(parsePatch(readDiffFixture("binary"))).toEqual([]);
    expect(parsePatch(readDiffFixture("pure-rename"))).toEqual([]);
    expect(parsePatch("")).toEqual([]);
  });

  it("parses a rename with changes using the new path numbering", () => {
    const [hunk] = parsePatch(readDiffFixture("rename-with-change"));
    expect(hunk).toMatchObject({ oldStart: 12, newStart: 12 });
    expect(hunk?.lines.find((line) => line.kind === "add")).toMatchObject({
      newLine: 15,
      content: "r15 changed",
    });
  });

  it("handles a huge hunk without losing lines", () => {
    const [hunk, extra] = parsePatch(readDiffFixture("huge-hunk"));
    expect(extra).toBeUndefined();
    expect(hunk?.lines).toHaveLength(4000);
    expect(hunk?.lines.filter((line) => line.kind === "del")).toHaveLength(2000);
    expect(hunk?.lines.filter((line) => line.kind === "add")).toHaveLength(2000);
    expect(hunk?.lines.at(-1)).toMatchObject({ kind: "add", newLine: 2000 });
  });

  it("tolerates a truncated hunk by keeping the lines that exist", () => {
    const [hunk] = parsePatch("@@ -1,5 +1,5 @@\n a\n-b\n+c");
    expect(hunk?.lines).toHaveLength(3);
    expect(hunk).toMatchObject({ oldLines: 2, newLines: 2 });
  });
});

describe("DiffLineIndex", () => {
  const index = new DiffLineIndex(parsePatch(readDiffFixture("multi-hunk")));

  it("accepts added and context lines on the right side", () => {
    expect(index.hasLine("RIGHT", 5)).toBe(true);
    expect(index.hasLine("RIGHT", 50)).toBe(true);
    expect(index.hasLine("RIGHT", 51)).toBe(true);
    expect(index.isChanged("RIGHT", 5)).toBe(true);
    expect(index.isChanged("RIGHT", 3)).toBe(false);
  });

  it("accepts deleted lines only on the left side", () => {
    expect(index.hasLine("LEFT", 89)).toBe(true);
    expect(index.lineAt("LEFT", 89)?.kind).toBe("del");
    expect(index.lineAt("RIGHT", 89)?.content).toBe("line 88");
    expect(index.lineAt("RIGHT", 90)?.content).toBe("line 90");
  });

  it("rejects lines outside every hunk", () => {
    expect(index.hasLine("RIGHT", 1)).toBe(false);
    expect(index.hasLine("RIGHT", 20)).toBe(false);
    expect(index.hasLine("LEFT", 200)).toBe(false);
  });

  it("validates ranges", () => {
    expect(index.validateRange({ side: "RIGHT", startLine: 48, endLine: 52 })).toEqual({
      valid: true,
    });
    expect(index.validateRange({ side: "RIGHT", startLine: 52, endLine: 48 })).toEqual({
      valid: false,
      reason: "inverted",
    });
    expect(index.validateRange({ side: "RIGHT", startLine: 8, endLine: 20 })).toEqual({
      valid: false,
      reason: "not-in-diff",
    });
    expect(index.validateRange({ side: "RIGHT", startLine: 8, endLine: 47 })).toEqual({
      valid: false,
      reason: "spans-hunks",
    });
  });

  it("maps old lines to new lines across shifted hunks", () => {
    expect(index.mapOldToNew(90)).toBe(90);
    expect(index.mapOldToNew(89)).toBeNull();
    expect(index.mapOldToNew(88)).toBe(89);
    expect(index.mapNewToOld(51)).toBeNull();
    expect(index.mapNewToOld(52)).toBe(51);
  });
});
