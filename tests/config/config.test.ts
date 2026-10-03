import { describe, expect, it } from "vitest";

import { loadEnv, requireGitHubAuth } from "../../src/core/config/env.ts";
import {
  ConfigError,
  configLayerFromYaml,
  deepMerge,
  repoConfigLayer,
  resolveConfig,
  resolveConfigStrict,
} from "../../src/core/config/loader.ts";

describe("deepMerge", () => {
  it("merges objects recursively and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
      e: 2,
    });
  });

  it("ignores prototype pollution keys", () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"safe":1}')) as Record<
      string,
      unknown
    >;
    expect(merged["safe"]).toBe(1);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("resolveConfig", () => {
  it("returns validated defaults with no layers", () => {
    const { config, issues, appliedLayers } = resolveConfig();
    expect(issues).toEqual([]);
    expect(appliedLayers).toEqual([]);
    expect(config.review.maxInlineComments).toBe(10);
    expect(config.ignore.globs).toContain("**/pnpm-lock.yaml");
    expect(config.models.reviewer.provider).toBe("openai");
    expect(config.budgets.perRunUsd).toBeNull();
  });

  it("applies layers in order with later layers winning", () => {
    const { config, appliedLayers } = resolveConfig([
      {
        name: "org",
        source: "org",
        value: { review: { maxInlineComments: 5, severityThreshold: "high" } },
      },
      { name: "repo", source: ".pr-agent.yaml", value: { review: { maxInlineComments: 3 } } },
      { name: "cli", source: "cli", value: { language: "de" } },
    ]);
    expect(config.review.maxInlineComments).toBe(3);
    expect(config.review.severityThreshold).toBe("high");
    expect(config.language).toBe("de");
    expect(appliedLayers).toEqual(["org", "repo", "cli"]);
  });

  it("skips an invalid repo layer, reports why, and keeps the rest", () => {
    const { config, issues, appliedLayers } = resolveConfig([
      { name: "org", source: "org", value: { review: { maxInlineComments: 5 } } },
      {
        name: "repo",
        source: ".pr-agent.yaml",
        value: { review: { maxInlineComments: 500, unknownKey: true } },
      },
    ]);
    expect(config.review.maxInlineComments).toBe(5);
    expect(appliedLayers).toEqual(["org"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.layer).toBe("repo");
    expect(issues[0]?.messages.join("\n")).toContain("review.maxInlineComments");
  });

  it("rejects unknown top-level keys", () => {
    const { issues } = resolveConfig([{ name: "repo", source: "r", value: { reveiw: {} } }]);
    expect(issues[0]?.messages.join("\n")).toMatch(/reveiw|Unrecognized/);
  });

  it("reports YAML syntax errors as an issue", () => {
    const layer = repoConfigLayer("review: [unclosed");
    expect(layer).not.toBeNull();
    const { issues } = resolveConfig(layer ? [layer] : []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.layer).toBe("repo");
  });

  it("treats an empty YAML document as no overrides", () => {
    const layer = configLayerFromYaml("repo", ".pr-agent.yaml", "");
    expect(resolveConfig([layer]).issues).toEqual([]);
  });

  it("rejects non-mapping documents", () => {
    const layer = configLayerFromYaml("repo", ".pr-agent.yaml", "- a\n- b\n");
    expect(resolveConfig([layer]).issues[0]?.messages[0]).toContain("mapping");
  });

  it("throws a ConfigError in strict mode", () => {
    expect(() =>
      resolveConfigStrict([{ name: "cli", source: "cli", value: { language: 1 } }]),
    ).toThrow(ConfigError);
  });
});

describe("loadEnv", () => {
  it("parses defaults and prefers GitHub App credentials over a token", () => {
    const env = loadEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
      GITHUB_TOKEN: "ghp_x",
      OPENAI_API_KEY: "sk-test",
    });
    expect(env.logLevel).toBe("info");
    expect(env.github).toEqual({
      kind: "app",
      appId: "123",
      privateKey: "-----BEGIN-----\nabc\n-----END-----",
    });
    expect(env.llmKeys.openai).toBe("sk-test");
    expect(env.llmKeys.anthropic).toBeUndefined();
  });

  it("falls back to a token and treats blank values as unset", () => {
    const env = loadEnv({ GITHUB_TOKEN: "ghp_x", GITHUB_APP_ID: "  ", OPENAI_API_KEY: "" });
    expect(env.github).toEqual({ kind: "token", token: "ghp_x" });
    expect(env.llmKeys.openai).toBeUndefined();
  });

  it("fails loudly on invalid values and missing GitHub credentials", () => {
    expect(() => loadEnv({ LOG_LEVEL: "loud" })).toThrow(ConfigError);
    expect(() => requireGitHubAuth(loadEnv({}))).toThrow(ConfigError);
  });
});
