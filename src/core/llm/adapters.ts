import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
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

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject;
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolStepResult {
  /** The raw assistant turn, to be appended to the transcript. */
  readonly message: AIMessage;
  readonly text: string;
  readonly toolCalls: readonly ToolCallRequest[];
  readonly usage: TokenUsage | null;
}

export interface ToolInvoker {
  invoke(messages: BaseMessage[], options: StructuredCallOptions): Promise<ToolStepResult>;
}

export interface ChatModelAdapter {
  readonly spec: ModelSpec;
  structured(schema: z.ZodType, name: string): StructuredInvoker;
  /** One model turn that may request tool calls. The caller owns the loop. */
  withTools(tools: readonly ToolDefinition[]): ToolInvoker;
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
      withTools(tools) {
        // The executors are never called by LangChain; they only carry the schema for binding.
        const definitions = tools.map((definition) =>
          tool(() => "", {
            name: definition.name,
            description: definition.description,
            schema: definition.schema,
          }),
        );
        const bound = model.bindTools?.(definitions);
        if (bound === undefined) {
          throw new Error(`model ${spec.model} does not support tool calling`);
        }
        return {
          async invoke(messages, options) {
            const message = (await bound.invoke(messages, {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })) as AIMessage;
            return {
              message,
              text: typeof message.content === "string" ? message.content : "",
              toolCalls: (message.tool_calls ?? []).map((call, index) => ({
                id: call.id ?? `call_${index}`,
                name: call.name,
                args: call.args,
              })),
              usage: extractUsage(message),
            };
          },
        };
      },
    };
  };
