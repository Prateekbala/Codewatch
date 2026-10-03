import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";

import type { Env } from "../config/env.ts";
import type { ModelSpec } from "../config/schema.ts";

import type { TokenUsage } from "./cost.ts";
import { MissingApiKeyError } from "./errors.ts";

export interface StructuredCallOptions {
  readonly signal?: AbortSignal;
}

export interface StructuredCallResult {
  readonly parsed: unknown;
  readonly usage: TokenUsage | null;
}

export interface StructuredInvoker {
  invoke(messages: BaseMessage[], options: StructuredCallOptions): Promise<StructuredCallResult>;
}

export interface ChatModelAdapter {
  readonly spec: ModelSpec;
  structured(schema: z.ZodType, name: string): StructuredInvoker;
}

export interface AdapterSettings {
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export type ChatModelAdapterFactory = (
  spec: ModelSpec,
  settings: AdapterSettings,
) => ChatModelAdapter;

const buildChatModel = (spec: ModelSpec, settings: AdapterSettings, env: Env): BaseChatModel => {
  const common = {
    model: spec.model,
    timeout: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    ...(spec.maxOutputTokens === undefined ? {} : { maxTokens: spec.maxOutputTokens }),
  };

  switch (spec.provider) {
    case "openai": {
      const apiKey = env.llmKeys.openai;
      if (apiKey === undefined) {
        throw new MissingApiKeyError("openai");
      }
      return new ChatOpenAI({ ...common, apiKey });
    }
    case "anthropic": {
      const apiKey = env.llmKeys.anthropic;
      if (apiKey === undefined) {
        throw new MissingApiKeyError("anthropic");
      }
      return new ChatAnthropic({
        ...common,
        apiKey,
        clientOptions: { timeout: settings.timeoutMs },
      });
    }
    case "groq": {
      const apiKey = env.llmKeys.groq;
      if (apiKey === undefined) {
        throw new MissingApiKeyError("groq");
      }
      // Groq exposes an OpenAI-compatible API — use ChatOpenAI with a custom baseURL
      return new ChatOpenAI({
        ...common,
        apiKey,
        configuration: {
          baseURL: "https://api.groq.com/openai/v1",
        },
      });
    }
  }
};

interface RawStructuredOutput {
  readonly raw: BaseMessage;
  readonly parsed: unknown;
}

const extractUsage = (message: BaseMessage): TokenUsage | null => {
  const usage = (message as { usage_metadata?: { input_tokens: number; output_tokens: number } })
    .usage_metadata;
  return usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null;
};

export const createLangChainAdapterFactory =
  (env: Env): ChatModelAdapterFactory =>
  (spec, settings) => {
    const model = buildChatModel(spec, settings, env);
    return {
      spec,
      structured(schema, name) {
        const runnable = model.withStructuredOutput(schema as z.ZodObject, {
          name,
          includeRaw: true,
        });
        return {
          async invoke(messages, options) {
            const result = (await runnable.invoke(messages, {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })) as RawStructuredOutput;
            return { parsed: result.parsed, usage: extractUsage(result.raw) };
          },
        };
      },
    };
  };
