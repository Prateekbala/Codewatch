import { describe, expect, it } from "vitest";

import {
  hasManagedSection,
  stripManagedSection,
  upsertManagedSection,
  wrapManagedSection,
} from "../../src/core/github/markers.ts";
import {
  InvalidReferenceError,
  formatPullRequestRef,
  parsePullRequestRef,
  parseRepoRef,
} from "../../src/core/github/ref.ts";

describe("parsePullRequestRef", () => {
  it.each([
    ["https://github.com/acme/widgets/pull/42", { owner: "acme", repo: "widgets", number: 42 }],
    [
      "https://github.com/acme/widgets/pull/42/files",
      { owner: "acme", repo: "widgets", number: 42 },
    ],
    [
      "https://github.com/acme/widgets/pull/42#issuecomment-1",
      { owner: "acme", repo: "widgets", number: 42 },
    ],
    ["acme/widgets#7", { owner: "acme", repo: "widgets", number: 7 }],
    ["  acme/my.repo-x#7  ", { owner: "acme", repo: "my.repo-x", number: 7 }],
  ])("parses %s", (input, expected) => {
    expect(parsePullRequestRef(input)).toEqual(expected);
  });

  it.each(["", "acme/widgets", "https://gitlab.com/a/b/pull/1", "https://github.com/a/b/issues/1"])(
    "rejects %j",
    (input) => {
      expect(() => parsePullRequestRef(input)).toThrow(InvalidReferenceError);
    },
  );

  it("formats and parses repositories", () => {
    expect(formatPullRequestRef({ owner: "a", repo: "b", number: 3 })).toBe("a/b#3");
    expect(parseRepoRef("a/b")).toEqual({ owner: "a", repo: "b" });
    expect(() => parseRepoRef("nope")).toThrow(InvalidReferenceError);
  });
});

describe("managed sections", () => {
  const content = "## Summary\nHello";

  it("appends a section to an existing body", () => {
    const body = upsertManagedSection("My own text", "describe", content);
    expect(body.startsWith("My own text\n\n<!-- pr-agent:describe:start -->")).toBe(true);
    expect(body.endsWith("<!-- pr-agent:describe:end -->")).toBe(true);
  });

  it("creates a section for an empty body", () => {
    expect(upsertManagedSection("", "describe", content)).toBe(
      wrapManagedSection("describe", content),
    );
  });

  it("replaces an existing section in place and is idempotent", () => {
    const first = upsertManagedSection("Intro\n\nOutro", "describe", "v1");
    const second = upsertManagedSection(first, "describe", "v2");
    const third = upsertManagedSection(second, "describe", "v2");
    expect(second).toContain("v2");
    expect(second).not.toContain("v1");
    expect(third).toBe(second);
    expect(second.startsWith("Intro")).toBe(true);
  });

  it("preserves text on both sides of the section", () => {
    const body = `Before\n\n${wrapManagedSection("describe", "old")}\n\nAfter`;
    const updated = upsertManagedSection(body, "describe", "new");
    expect(updated).toBe(`Before\n\n${wrapManagedSection("describe", "new")}\n\nAfter`);
  });

  it("collapses duplicate sections into one", () => {
    const body = `${wrapManagedSection("describe", "a")}\n\n${wrapManagedSection("describe", "b")}`;
    const updated = upsertManagedSection(body, "describe", "c");
    expect(updated.match(/pr-agent:describe:start/g)).toHaveLength(1);
  });

  it("only touches sections with the same id", () => {
    const body = wrapManagedSection("summary", "keep");
    const updated = upsertManagedSection(body, "describe", "new");
    expect(hasManagedSection(updated, "summary")).toBe(true);
    expect(hasManagedSection(updated, "describe")).toBe(true);
  });

  it("strips a section", () => {
    const body = `Before\n\n${wrapManagedSection("describe", "gone")}\n\nAfter`;
    expect(stripManagedSection(body, "describe")).toBe("Before\n\nAfter");
    expect(stripManagedSection("plain", "describe")).toBe("plain");
  });
});
