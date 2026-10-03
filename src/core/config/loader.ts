import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";

import { type Config, ConfigSchema } from "./schema.ts";

export const REPO_CONFIG_PATH = ".pr-agent.yaml";

export type ConfigLayerName = "org" | "repo" | "directory" | "cli";

export interface ConfigLayer {
  readonly name: ConfigLayerName;
  readonly source: string;
  readonly value: unknown;
  readonly parseError?: string;
}

export interface ConfigIssue {
  readonly layer: ConfigLayerName;
  readonly source: string;
  readonly messages: readonly string[];
}

export interface ResolvedConfig {
  readonly config: Config;
  readonly appliedLayers: readonly ConfigLayerName[];
  readonly issues: readonly ConfigIssue[];
}

export class ConfigError extends Error {
  readonly messages: readonly string[];

  constructor(message: string, messages: readonly string[]) {
    super(`${message}\n${messages.map((m) => `  - ${m}`).join("\n")}`);
    this.name = "ConfigError";
    this.messages = messages;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const deepMerge = (base: unknown, override: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
};

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

export const parseConfigYaml = (content: string, source: string): unknown => {
  try {
    const parsed: unknown = parseYaml(content);
    return parsed ?? {};
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigError(`Invalid YAML in ${source}`, [detail]);
  }
};

export const resolveConfig = (layers: readonly ConfigLayer[] = []): ResolvedConfig => {
  let merged: unknown = {};
  const applied: ConfigLayerName[] = [];
  const issues: ConfigIssue[] = [];

  for (const layer of layers) {
    if (layer.parseError !== undefined) {
      issues.push({ layer: layer.name, source: layer.source, messages: [layer.parseError] });
      continue;
    }
    if (!isPlainObject(layer.value)) {
      issues.push({
        layer: layer.name,
        source: layer.source,
        messages: ["configuration must be a mapping at the top level"],
      });
      continue;
    }
    const candidate = deepMerge(merged, layer.value);
    const result = ConfigSchema.safeParse(candidate);
    if (result.success) {
      merged = candidate;
      applied.push(layer.name);
    } else {
      issues.push({
        layer: layer.name,
        source: layer.source,
        messages: formatIssues(result.error),
      });
    }
  }

  return { config: ConfigSchema.parse(merged), appliedLayers: applied, issues };
};

export const resolveConfigStrict = (layers: readonly ConfigLayer[] = []): Config => {
  const resolved = resolveConfig(layers);
  const [first] = resolved.issues;
  if (first) {
    throw new ConfigError(`Invalid configuration (${first.source})`, first.messages);
  }
  return resolved.config;
};

export const configLayerFromYaml = (
  name: ConfigLayerName,
  source: string,
  content: string,
): ConfigLayer => {
  try {
    return { name, source, value: parseConfigYaml(content, source) };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { name, source, value: null, parseError: error.messages.join("; ") };
    }
    throw error;
  }
};

export const repoConfigLayer = (content: string | null): ConfigLayer | null =>
  content === null ? null : configLayerFromYaml("repo", REPO_CONFIG_PATH, content);
