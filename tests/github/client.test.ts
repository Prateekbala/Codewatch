import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OctokitGitHubClient } from "../../src/core/github/client.ts";
import { createOctokit } from "../../src/core/github/octokit.ts";
import { createLogger } from "../../src/core/logging/logger.ts";

const API = "https://api.github.com";
const ref = { owner: "acme", repo: "widgets", number: 5 };

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const client = () =>
  new OctokitGitHubClient(
    createOctokit({
      auth: { kind: "token", token: "test-token" },
      logger: createLogger({ level: "silent" }),
    }),
  );

const fileFixture = (n: number) => ({
  sha: `sha${n}`,
  filename: `src/file${n}.ts`,
  status: n === 3 ? "renamed" : "modified",
  additions: n,
  deletions: 0,
  changes: n,
  previous_filename: n === 3 ? "src/old.ts" : undefined,
  patch: n === 2 ? undefined : `@@ -1 +1 @@\n-a\n+b${n}`,
});

describe("OctokitGitHubClient", () => {
  it("paginates changed files and maps patches, renames and missing patches", async () => {
    server.use(
      http.get(`${API}/repos/acme/widgets/pulls/5/files`, ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "1");
        const files =
          page === 1 ? [1, 2, 3].map(fileFixture) : page === 2 ? [4].map(fileFixture) : [];
        const headers: Record<string, string> =
          page === 1
            ? {
                link: `<${API}/repos/acme/widgets/pulls/5/files?per_page=100&page=2>; rel="next"`,
              }
            : {};
        return HttpResponse.json(files, { headers });
      }),
    );

    const files = await client().listFiles(ref);

    expect(files.map((file) => file.path)).toEqual([
      "src/file1.ts",
      "src/file2.ts",
      "src/file3.ts",
      "src/file4.ts",
    ]);
    expect(files[1]?.patch).toBeNull();
    expect(files[2]).toMatchObject({ status: "renamed", previousPath: "src/old.ts" });
    expect(files[0]?.patch).toBe("@@ -1 +1 @@\n-a\n+b1");
  });

  it("returns raw file content and null for missing files", async () => {
    const seen: { ref: string | null; accept: string | null }[] = [];
    server.use(
      http.get(`${API}/repos/acme/widgets/contents/:path+`, ({ params, request }) => {
        const raw = params["path"];
        const path = Array.isArray(raw) ? raw.join("/") : String(raw);
        seen.push({
          ref: new URL(request.url).searchParams.get("ref"),
          accept: request.headers.get("accept"),
        });
        return path === "AGENTS.md"
          ? new HttpResponse("# rules\n", { headers: { "content-type": "text/plain" } })
          : HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }),
    );

    const github = client();
    await expect(github.getFileContent(ref, "AGENTS.md", "main")).resolves.toEqual({
      path: "AGENTS.md",
      ref: "main",
      content: "# rules\n",
    });
    await expect(github.getFileContent(ref, "missing.md", "main")).resolves.toBeNull();
    expect(seen.every((request) => request.ref === "main")).toBe(true);
    expect(seen.every((request) => /vnd\.github(\.v3)?\.raw/.test(request.accept ?? ""))).toBe(
      true,
    );
  });

  it("only sends the fields that changed when updating a pull request", async () => {
    let received: unknown;
    server.use(
      http.patch(`${API}/repos/acme/widgets/pulls/5`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({});
      }),
    );
    await client().updatePullRequest(ref, { body: "new body" });
    expect(received).toEqual({ body: "new body" });
  });

  it("maps pull request metadata", async () => {
    server.use(
      http.get(`${API}/repos/acme/widgets/pulls/5`, () =>
        HttpResponse.json({
          id: 99,
          title: "Add thing",
          body: null,
          user: { login: "octo", type: "User" },
          state: "open",
          draft: true,
          merged: false,
          labels: [{ name: "bug" }],
          base: { ref: "main", sha: "b", repo: { default_branch: "main" } },
          head: { ref: "feat", sha: "h", repo: { name: "widgets", owner: { login: "fork" } } },
          html_url: "https://github.com/acme/widgets/pull/5",
          changed_files: 2,
          additions: 3,
          deletions: 1,
          commits: 1,
        }),
      ),
    );
    const pr = await client().getPullRequest(ref);
    expect(pr).toMatchObject({
      title: "Add thing",
      body: "",
      draft: true,
      labels: ["bug"],
      headRepo: { owner: "fork", repo: "widgets" },
      defaultBranch: "main",
    });
  });
});
