import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadEnv } from "../../src/core/config/env.ts";
import { DescribeOutputSchema } from "../../src/core/graph/describe/schema.ts";
import { VerifierOutputSchema } from "../../src/core/graph/review/verify.ts";
import { ReviewSummarySchema, ReviewUnitOutputSchema } from "../../src/core/graph/review/schema.ts";
import { createLangChainAdapterFactory } from "../../src/core/llm/adapters.ts";
import { MissingApiKeyError } from "../../src/core/llm/errors.ts";

const settings = { timeoutMs: 1_000, maxRetries: 0 };
const openai = { provider: "openai", model: "gpt-5-mini", contextWindow: 100_000 } as const;
const anthropic = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  contextWindow: 100_000,
} as const;

const UNSUPPORTED_BY_STRICT_STRUCTURED_OUTPUT = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
  "format",
];

const collectKeys = (value: unknown, keys = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};

describe("LangChain adapter factory", () => {
  it("builds structured invokers for configured providers without network access", () => {
    const factory = createLangChainAdapterFactory(
      loadEnv({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" }),
    );
    for (const spec of [openai, anthropic]) {
      const adapter = factory(spec, settings);
      expect(adapter.spec).toBe(spec);
      expect(typeof adapter.structured(DescribeOutputSchema, "describe").invoke).toBe("function");
    }
  });

  it("fails with a clear error when the provider key is missing", () => {
    const factory = createLangChainAdapterFactory(loadEnv({ OPENAI_API_KEY: "sk-test" }));
    expect(() => factory(anthropic, settings)).toThrow(MissingApiKeyError);
    expect(() => createLangChainAdapterFactory(loadEnv({}))(openai, settings)).toThrow(
      MissingApiKeyError,
    );
  });

  it.each([
    ["describe", DescribeOutputSchema],
    ["review findings", ReviewUnitOutputSchema],
    ["review summary", ReviewSummarySchema],
    ["verifier", VerifierOutputSchema],
  ])("keeps the %s schema within the strict structured-output subset", (_name, schema) => {
    const keys = collectKeys(z.toJSONSchema(schema));
    for (const keyword of UNSUPPORTED_BY_STRICT_STRUCTURED_OUTPUT) {
      expect(keys.has(keyword), keyword).toBe(false);
    }
  });
});
