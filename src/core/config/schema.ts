import { z } from "zod";

import { DEFAULT_IGNORE_GLOBS } from "./defaults.ts";

export const ModelSpecSchema = z.strictObject({
  provider: z.enum(["openai", "anthropic", "groq"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().default(200_000),
});

export const ModelPriceSchema = z.strictObject({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);

const SpecialistSchema = z.enum(["bug", "security", "performance", "tests", "api"]);

const defaultModel = (model: string) => ({
  provider: "openai" as const,
  model,
  contextWindow: 400_000,
});

export const ConfigSchema = z.strictObject({
  language: z.string().min(2).default("en"),
  ignore: z
    .strictObject({
      globs: z.array(z.string()).default([...DEFAULT_IGNORE_GLOBS]),
      allowGlobs: z.array(z.string()).default([]),
    })
    .prefault({}),
  diff: z
    .strictObject({
      contextLinesBefore: z.number().int().min(0).max(100).default(5),
      contextLinesAfter: z.number().int().min(0).max(100).default(3),
      maxDynamicContextLines: z.number().int().min(0).max(200).default(25),
      maxFileBytes: z
        .number()
        .int()
        .positive()
        .default(512 * 1024),
      maxFiles: z.number().int().positive().default(300),
      promptBudgetRatio: z.number().min(0.1).max(0.95).default(0.6),
      reservedOutputTokens: z.number().int().positive().default(8_000),
      unitTokenBudget: z.number().int().positive().default(24_000),
      maxTotalTokens: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  review: z
    .strictObject({
      maxInlineComments: z.number().int().min(0).max(50).default(10),
      severityThreshold: SeveritySchema.default("low"),
      enabledSpecialists: z
        .array(SpecialistSchema)
        .default(["bug", "security", "performance", "tests", "api"]),
      minConfidence: z.number().min(0).max(1).default(0.5),
      maxConcurrency: z.number().int().min(1).max(16).default(4),
      maxLinkedIssues: z.number().int().min(0).max(10).default(5),
      maxToolCallsPerReviewer: z.number().int().min(0).max(20).default(5),
      nodeTimeoutMs: z.number().int().positive().default(120_000),
      maxGraphSteps: z.number().int().positive().default(40),
      enableVerifier: z.boolean().default(true),
    })
    .prefault({}),
  server: z
    .strictObject({
      autoReviewOnOpen: z.boolean().default(true),
      maxDeliveryCache: z.number().int().min(100).max(100_000).default(5_000),
    })
    .prefault({}),
  describe: z
    .strictObject({
      updateTitle: z.boolean().default(false),
      maxCommitMessages: z.number().int().min(0).max(100).default(30),
    })
    .prefault({}),
  models: z
    .strictObject({
      triage: ModelSpecSchema.default(defaultModel("gpt-5-mini")),
      reviewer: ModelSpecSchema.default(defaultModel("gpt-5")),
      verifier: ModelSpecSchema.default(defaultModel("gpt-5")),
      summarizer: ModelSpecSchema.default(defaultModel("gpt-5-mini")),
      embeddings: z
        .strictObject({
          provider: z.enum(["openai"]),
          model: z.string().min(1),
          dimensions: z.number().int().positive(),
        })
        .default({ provider: "openai", model: "text-embedding-3-large", dimensions: 1024 }),
      fallbacks: z.array(ModelSpecSchema).default([]),
    })
    .prefault({}),
  llm: z
    .strictObject({
      timeoutMs: z.number().int().positive().default(90_000),
      maxRetries: z.number().int().min(0).max(8).default(2),
      maxSchemaRepairs: z.number().int().min(0).max(5).default(2),
      pricing: z.record(z.string(), ModelPriceSchema).default({}),
    })
    .prefault({}),
  budgets: z
    .strictObject({
      perRunUsd: z.number().positive().nullable().default(null),
      perRunTokens: z.number().int().positive().default(2_000_000),
    })
    .prefault({}),
  commands: z
    .strictObject({
      allowedRoles: z
        .array(z.enum(["admin", "maintain", "write", "triage"]))
        .default(["admin", "maintain", "write", "triage"]),
    })
    .prefault({}),
  checkRun: z
    .strictObject({
      enabled: z.boolean().default(false),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
export type ModelRole = "triage" | "reviewer" | "verifier" | "summarizer";
export type Severity = z.infer<typeof SeveritySchema>;
