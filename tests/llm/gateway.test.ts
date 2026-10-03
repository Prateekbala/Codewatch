import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CostTracker } from "../../src/core/llm/cost.ts";
import {
  AllModelsFailedError,
  BudgetExceededError,
  MissingApiKeyError,
  SchemaValidationError,
} from "../../src/core/llm/errors.ts";
import { LlmGateway } from "../../src/core/llm/gateway.ts";
import { ScriptedLlm, silentLogger, testConfig } from "../helpers/fakes.ts";

const Schema = z.object({ answer: z.string(), score: z.number() });
const valid = { answer: "ok", score: 1 };

const PRIMARY = { provider: "openai", model: "primary", contextWindow: 100_000 };
const BACKUP = { provider: "anthropic", model: "backup", contextWindow: 50_000 };

const setup = (
  scripts: ConstructorParameters<typeof ScriptedLlm>[0],
  overrides: Record<string, unknown> = {},
) => {
  const config = testConfig({
    models: { summarizer: PRIMARY, fallbacks: [BACKUP] },
    llm: {
      maxSchemaRepairs: 1,
      pricing: { primary: { inputPerMTok: 1, outputPerMTok: 2 } },
    },
    review: { nodeTimeoutMs: 50 },
    ...overrides,
  });
  const llm = new ScriptedLlm(scripts);
  const tracker = CostTracker.fromConfig(config);
  const gateway = new LlmGateway({
    config,
    tracker,
    adapterFactory: llm.factory,
    logger: silentLogger,
  });
  return { gateway, llm, tracker };
};

const request = (signal?: AbortSignal) => ({
  role: "summarizer" as const,
  node: "test.node",
  schema: Schema,
  schemaName: "test_schema",
  messages: [new HumanMessage("hello")],
  ...(signal === undefined ? {} : { signal }),
});

describe("LlmGateway", () => {
  it("returns validated output and records usage and cost per node", async () => {
    const { gateway, tracker } = setup({
      primary: [{ parsed: valid, usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }],
    });

    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);

    const summary = tracker.summary();
    expect(summary.totalTokens).toBe(1_500_000);
    expect(summary.costUsd).toBeCloseTo(2);
    expect(summary.byNode["test.node"]).toMatchObject({ calls: 1, inputTokens: 1_000_000 });
    expect(summary.unpricedModels).toEqual([]);
  });

  it("asks the model to repair output that fails schema validation", async () => {
    const { gateway, llm, tracker } = setup({
      primary: [{ parsed: { answer: 5 } }, { parsed: valid }],
    });

    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);

    expect(llm.calls).toHaveLength(2);
    const repair = llm.calls[1]?.messages.at(-1)?.content;
    expect(repair).toContain("answer");
    expect(repair).toContain("score");
    expect(tracker.summary().calls).toBe(2);
  });

  it("treats a null parse as a schema failure", async () => {
    const { gateway, llm } = setup({ primary: [{ parsed: null }, { parsed: valid }] });
    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);
    expect(llm.calls[1]?.messages.at(-1)?.content).toContain("no structured output");
  });

  it("falls back to the next model after repairs are exhausted", async () => {
    const { gateway, llm } = setup({
      primary: [{ parsed: {} }, { parsed: {} }],
      backup: [{ parsed: valid }],
    });
    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);
    expect(llm.calls.map((call) => call.model)).toEqual(["primary", "primary", "backup"]);
  });

  it("falls back when the primary provider errors", async () => {
    const { gateway, llm } = setup({
      primary: [{ error: new Error("503 upstream") }],
      backup: [{ parsed: valid }],
    });
    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);
    expect(llm.calls.map((call) => call.model)).toEqual(["primary", "backup"]);
  });

  it("falls back when a call exceeds the node timeout", async () => {
    const { gateway, llm } = setup({ primary: [{ hang: true }], backup: [{ parsed: valid }] });
    await expect(gateway.invokeStructured(request())).resolves.toEqual(valid);
    expect(llm.calls.map((call) => call.model)).toEqual(["primary", "backup"]);
  });

  it("reports every failure when all models fail", async () => {
    const { gateway } = setup({
      primary: [{ error: new Error("boom") }],
      backup: [{ parsed: {} }, { parsed: {} }],
    });
    const error = await gateway.invokeStructured(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllModelsFailedError);
    const failures = (error as AllModelsFailedError).failures;
    expect(failures).toHaveLength(2);
    expect(failures[1]?.error).toBeInstanceOf(SchemaValidationError);
  });

  it("stops immediately and does not fall back when the token budget is exhausted", async () => {
    const { gateway, llm } = setup(
      {
        primary: [
          { parsed: {}, usage: { inputTokens: 600, outputTokens: 600 } },
          { parsed: valid },
        ],
        backup: [{ parsed: valid }],
      },
      { budgets: { perRunTokens: 1_000 } },
    );
    await expect(gateway.invokeStructured(request())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(llm.calls).toHaveLength(1);
  });

  it("enforces the dollar budget for priced models", async () => {
    const { gateway } = setup(
      { primary: [{ parsed: {}, usage: { inputTokens: 1_000_000, outputTokens: 0 } }] },
      { budgets: { perRunUsd: 0.5 } },
    );
    await expect(gateway.invokeStructured(request())).rejects.toMatchObject({
      name: "BudgetExceededError",
      kind: "cost",
    });
  });

  it("propagates cancellation instead of falling back", async () => {
    const controller = new AbortController();
    const { gateway, llm } = setup({ primary: [{ parsed: valid }], backup: [{ parsed: valid }] });
    controller.abort(new Error("superseded"));
    await expect(gateway.invokeStructured(request(controller.signal))).rejects.toThrow(
      "superseded",
    );
    expect(llm.calls).toHaveLength(0);
  });

  it("surfaces a missing API key as itself", async () => {
    const config = testConfig({ models: { summarizer: PRIMARY } });
    const gateway = new LlmGateway({
      config,
      tracker: CostTracker.fromConfig(config),
      adapterFactory: () => {
        throw new MissingApiKeyError("openai");
      },
      logger: silentLogger,
    });
    await expect(gateway.invokeStructured(request())).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("uses the smallest context window across the model and its fallbacks", () => {
    const { gateway } = setup({});
    expect(gateway.contextWindowFor("summarizer")).toBe(50_000);
  });

  it("reports unpriced models instead of inventing a cost", async () => {
    const { gateway, tracker } = setup({
      primary: [{ error: new Error("down") }],
      backup: [{ parsed: valid }],
    });
    await gateway.invokeStructured(request());
    expect(tracker.summary().unpricedModels).toEqual(["backup"]);
    expect(tracker.summary().costUsd).toBe(0);
  });
});
