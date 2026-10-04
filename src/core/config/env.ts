import { readFileSync } from "node:fs";

import { z } from "zod";

import { ConfigError } from "./loader.ts";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
  GITHUB_TOKEN: optionalString,
  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
});

export type GitHubAuthConfig =
  | { readonly kind: "app"; readonly appId: string; readonly privateKey: string }
  | { readonly kind: "token"; readonly token: string };

export interface Env {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  readonly github: GitHubAuthConfig | null;
  readonly webhookSecret: string | undefined;
  readonly llmKeys: {
    readonly openai: string | undefined;
    readonly anthropic: string | undefined;
    readonly groq: string | undefined;
  };
}

const normalizePrivateKey = (key: string): string => key.replaceAll("\\n", "\n");

const resolveGitHubAuth = (parsed: z.infer<typeof EnvSchema>): GitHubAuthConfig | null => {
  const inlineKey = parsed.GITHUB_APP_PRIVATE_KEY;
  const keyPath = parsed.GITHUB_APP_PRIVATE_KEY_PATH;
  const privateKey =
    inlineKey ?? (keyPath === undefined ? undefined : readFileSync(keyPath, "utf8"));
  if (parsed.GITHUB_APP_ID !== undefined && privateKey !== undefined) {
    return {
      kind: "app",
      appId: parsed.GITHUB_APP_ID,
      privateKey: normalizePrivateKey(privateKey),
    };
  }
  if (parsed.GITHUB_TOKEN !== undefined) {
    return { kind: "token", token: parsed.GITHUB_TOKEN };
  }
  return null;
};

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      "Invalid environment",
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    github: resolveGitHubAuth(parsed),
    webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    llmKeys: {
      openai: parsed.OPENAI_API_KEY,
      anthropic: parsed.ANTHROPIC_API_KEY,
      groq: parsed.GROQ_API_KEY,
    },
  };
};

export const requireGitHubAuth = (env: Env): GitHubAuthConfig => {
  if (env.github === null) {
    throw new ConfigError("GitHub credentials are not configured", [
      "set GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH",
      "or set GITHUB_TOKEN for local development only",
    ]);
  }
  return env.github;
};
