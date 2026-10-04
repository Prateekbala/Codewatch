import { describe, expect, it } from "vitest";

import { createInvestigator } from "../../../src/core/graph/review/investigate.ts";
import { verifyFindings } from "../../../src/core/graph/review/verify.ts";
import { CostTracker } from "../../../src/core/llm/cost.ts";
import { LlmGateway } from "../../../src/core/llm/gateway.ts";
import {
  FakeGitHubClient,
  fakePullRequest,
  ScriptedLlm,
  type ScriptStep,
  silentLogger,
  testConfig,
} from "../../helpers/fakes.ts";
import { finding } from "../../helpers/review.ts";

const setup = (steps: ScriptStep[], review: Record<string, unknown> = {}) => {
  const llm = new ScriptedLlm({ "gpt-5": steps });
  const config = testConfig({
    review: { enableVerifier: true, verifierMode: "agentic", ...review },
  });
  const gateway = new LlmGateway({
    config,
    tracker: CostTracker.fromConfig(config),
    adapterFactory: llm.factory,
    logger: silentLogger,
  });
  const github = new FakeGitHubClient({
    contents: {
      "src/auth.ts": "export const q = (id) => db.query(`select ${id}`);\n",
      "src/sanitize.ts": "export const clean = (v: string) => v.replace(/[^a-z0-9]/gi, '');\n",
    },
  });
  const investigator = createInvestigator({
    llm: gateway,
    github,
    config,
    logger: silentLogger,
    pr: fakePullRequest(),
    changedPaths: ["src/auth.ts"],
  });
  return { llm, gateway, config, investigator };
};

const verdict = (overrides: Record<string, unknown> = {}): ScriptStep => ({
  parsed: {
    keep: true,
    reason: "confirmed",
    revisedSeverity: null,
    confirmingEvidence: [],
    ...overrides,
  },
});

describe("agentic investigation", () => {
  it("reads files the model asks for and drops a finding refuted by that code", async () => {
    const { llm, investigator } = setup([
      { tools: [{ name: "search_code", args: { query: "clean" } }] },
      { tools: [{ name: "read_file", args: { path: "src/sanitize.ts" } }] },
      { tools: [], text: "Input is sanitized by clean()." },
      verdict({ keep: false, reason: "sanitized upstream" }),
    ]);

    const result = await investigator(finding());

    expect(result.keep).toBe(false);
    expect(result.toolCalls).toBe(2);
    const log = llm.calls.at(-1)?.messages.at(-1)?.text ?? "";
    expect(log).toContain("read_file");
    expect(log).toContain("replace(/[^a-z0-9]/gi");
  });

  it("applies revised severity and adds confirming evidence", async () => {
    const { investigator } = setup([
      { tools: [{ name: "read_file", args: { path: "src/auth.ts", startLine: 1, endLine: 1 } }] },
      { tools: [], text: "Interpolated into the query." },
      verdict({
        revisedSeverity: "critical",
        confirmingEvidence: ["src/auth.ts:1 - id interpolated into SQL"],
      }),
    ]);

    const result = await investigator(finding({ severity: "high" }));

    expect(result.keep).toBe(true);
    expect(result.revisedSeverity).toBe(true);
    expect(result.finding.severity).toBe("critical");
    expect(result.finding.evidence).toContain("src/auth.ts:1 - id interpolated into SQL");
  });

  it("stops executing tools once the per-finding budget is spent", async () => {
    const { llm, investigator } = setup(
      [
        {
          tools: [
            { name: "find_files", args: { pattern: "auth" } },
            { name: "find_files", args: { pattern: "sanitize" } },
          ],
        },
        { tools: [], text: "enough" },
        verdict(),
      ],
      { maxToolCallsPerReviewer: 1 },
    );

    const result = await investigator(finding());

    expect(result.toolCalls).toBe(1);
    expect(llm.calls.at(-1)?.messages.at(-1)?.text).toContain("Tool budget exhausted");
  });

  it("reports tool failures as observations instead of failing the run", async () => {
    const { investigator } = setup([
      { tools: [{ name: "read_file", args: { path: "missing.ts" } }] },
      { tools: [], text: "nothing" },
      verdict({ keep: true }),
    ]);

    const result = await investigator(finding());

    expect(result.keep).toBe(true);
    expect(result.toolCalls).toBe(1);
  });
});

describe("verifyFindings in agentic mode", () => {
  it("investigates only the top findings and single-passes the rest", async () => {
    const { llm, gateway, config, investigator } = setup(
      [
        { tools: [], text: "looks real" },
        verdict(),
        { parsed: { keep: false, reason: "speculative" } },
      ],
      { maxInvestigations: 1, maxConcurrency: 1 },
    );

    const result = await verifyFindings(
      gateway,
      config,
      [finding({ title: "First" }), finding({ title: "Second", startLine: 9, endLine: 9 })],
      { investigator },
    );

    expect(result.investigated).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.kept.map((item) => item.title)).toEqual(["First"]);
    expect(llm.calls.map((call) => call.schemaName)).toEqual([
      "tools",
      "investigation_verdict",
      "verifier_decision",
    ]);
  });

  it("falls back to the single-pass verifier when an investigation breaks", async () => {
    const { gateway, config, investigator } = setup([
      { error: new Error("tool turn exploded") },
      { parsed: { keep: true, reason: "ok" } },
    ]);

    const result = await verifyFindings(gateway, config, [finding()], { investigator });

    expect(result.kept).toHaveLength(1);
    expect(result.investigated).toBe(0);
  });
});
