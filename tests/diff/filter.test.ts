import { describe, expect, it } from "vitest";

import { DEFAULT_IGNORE_GLOBS } from "../../src/core/config/defaults.ts";
import { filterFiles } from "../../src/core/diff/filter.ts";
import { categorize, scoreFile } from "../../src/core/diff/priority.ts";
import { changedFile } from "../helpers/fixtures.ts";

const options = { ignoreGlobs: DEFAULT_IGNORE_GLOBS, allowGlobs: [] };

describe("filterFiles", () => {
  it("ignores lockfiles, vendored, generated, snapshot and minified files", () => {
    const paths = [
      "pnpm-lock.yaml",
      "packages/app/yarn.lock",
      "vendor/lib/x.go",
      "src/__snapshots__/a.test.ts.snap",
      "public/app.min.js",
      "src/api/schema.generated.ts",
      "proto/user.pb.go",
      "dist/index.js",
    ];
    const { kept, ignored } = filterFiles(
      paths.map((path) => changedFile({ path })),
      options,
    );
    expect(kept).toEqual([]);
    expect(ignored.map((file) => file.path)).toEqual(paths);
    expect(ignored.every((file) => file.reason === "ignored-glob")).toBe(true);
  });

  it("keeps ordinary source files including dotfiles", () => {
    const { kept } = filterFiles(
      [
        changedFile({ path: "src/index.ts" }),
        changedFile({ path: ".github/workflows/ci.yml" }),
        changedFile({ path: "lockfile-parser.ts" }),
      ],
      options,
    );
    expect(kept.map((file) => file.path)).toEqual([
      "src/index.ts",
      ".github/workflows/ci.yml",
      "lockfile-parser.ts",
    ]);
  });

  it("ignores binary assets by extension", () => {
    const { kept, ignored } = filterFiles(
      [changedFile({ path: "assets/logo.PNG" }), changedFile({ path: "src/a.ts" })],
      { ignoreGlobs: [], allowGlobs: [] },
    );
    expect(kept.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(ignored).toEqual([{ path: "assets/logo.PNG", reason: "binary", detail: "png" }]);
  });

  it("lets allow globs override ignore globs", () => {
    const { kept } = filterFiles([changedFile({ path: "vendor/internal/keep.go" })], {
      ignoreGlobs: DEFAULT_IGNORE_GLOBS,
      allowGlobs: ["vendor/internal/**"],
    });
    expect(kept).toHaveLength(1);
  });

  it("reports which glob matched", () => {
    const { ignored } = filterFiles([changedFile({ path: "a/b/Cargo.lock" })], options);
    expect(ignored[0]?.detail).toBe("**/Cargo.lock");
  });
});

describe("priority", () => {
  it("categorizes paths", () => {
    expect(categorize("src/core/engine.ts")).toBe("source");
    expect(categorize("src/core/engine.test.ts")).toBe("test");
    expect(categorize("tests/unit/a.py")).toBe("test");
    expect(categorize("docs/README.md")).toBe("docs");
    expect(categorize("deploy/values.yaml")).toBe("config");
  });

  it("scores core logic above tests and docs, and boosts sensitive paths", () => {
    const score = (path: string) =>
      scoreFile(changedFile({ path, additions: 10, deletions: 0 })).score;
    expect(score("src/service.ts")).toBeGreaterThan(score("src/service.test.ts"));
    expect(score("src/service.test.ts")).toBeGreaterThan(score("README.md"));
    expect(score("src/auth/session.ts")).toBeGreaterThan(score("src/service.ts"));
    expect(scoreFile(changedFile({ path: "src/a.ts", status: "removed" })).score).toBeLessThan(
      score("src/a.ts"),
    );
  });
});
