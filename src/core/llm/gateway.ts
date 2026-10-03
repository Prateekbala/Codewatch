import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";

import type { Config, ModelRole, ModelSpec } from "../config/schema.ts";
import type { Logger } from "../logging/logger.ts";

import type { ChatModelAdapter, ChatModelAdapterFactory, StructuredInvoker } from "./adapters.ts";
import type { CostTracker } from "./cost.ts";
import {
  AllModelsFailedError,
  BudgetExceededError,
  MissingApiKeyError,
  SchemaValidationError,
  type ModelFailure,
} from "./errors.ts";

export interface StructuredRequest<S extends z.ZodType> {
  readonly role: ModelRole;
  readonly node: string;
  readonly schema: S;
  readonly schemaName: string;
  readonly messages: readonly BaseMessage[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface LlmGatewayDeps {
  readonly config: Config;
  readonly tracker: CostTracker;
  readonly adapterFactory: ChatModelAdapterFactory;
  readonly logger: Logger;
}

const specKey = (spec: ModelSpec): string => `${spec.provider}:${spec.model}`;

const formatIssues = (issues: readonly z.core.$ZodIssue[]): string[] =>
  issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);

const repairMessage = (issues: readonly string[]): HumanMessage =>
  new HumanMessage(
    `Your previous response did not satisfy the required schema:\n${issues
      .map((issue) => `- ${issue}`)
      .join("\n")}\nRespond again with output that strictly conforms to the schema.`,
  );

export class LlmGateway {
  readonly #deps: LlmGatewayDeps;
  readonly #adapters = new Map<string, ChatModelAdapter>();

  constructor(deps: LlmGatewayDeps) {
    this.#deps = deps;
  }

  get tracker(): CostTracker {
    return this.#deps.tracker;
  }

  candidatesFor(role: ModelRole): ModelSpec[] {
    const { models } = this.#deps.config;
    return [models[role], ...models.fallbacks];
  }

  contextWindowFor(role: ModelRole): number {
    return Math.min(...this.candidatesFor(role).map((spec) => spec.contextWindow));
  }

  async invokeStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<z.output<S>> {
    const failures: ModelFailure[] = [];

    for (const spec of this.candidatesFor(request.role)) {
      request.signal?.throwIfAborted();
      try {
        return await this.#attempt(spec, request);
      } catch (error) {
        if (request.signal?.aborted === true || error instanceof BudgetExceededError) {
          throw error;
        }
        failures.push({ model: spec.model, error });
        this.#deps.logger.warn(
          { node: request.node, model: spec.model, err: error },
          "model attempt failed",
        );
      }
    }

    if (failures.length === 1 && failures[0]?.error instanceof MissingApiKeyError) {
      throw failures[0].error;
    }
    throw new AllModelsFailedError(request.role, failures);
  }

  #adapter(spec: ModelSpec): ChatModelAdapter {
    const key = specKey(spec);
    let adapter = this.#adapters.get(key);
    if (!adapter) {
      const { llm } = this.#deps.config;
      adapter = this.#deps.adapterFactory(spec, {
        timeoutMs: llm.timeoutMs,
        maxRetries: llm.maxRetries,
      });
      this.#adapters.set(key, adapter);
    }
    return adapter;
  }

  async #attempt<S extends z.ZodType>(
    spec: ModelSpec,
    request: StructuredRequest<S>,
  ): Promise<z.output<S>> {
    const { config, tracker, logger } = this.#deps;
    const invoker: StructuredInvoker = this.#adapter(spec).structured(
      request.schema,
      request.schemaName,
    );
    const timeoutMs = request.timeoutMs ?? config.review.nodeTimeoutMs;
    let messages: BaseMessage[] = [...request.messages];
    let lastIssues: string[] = [];

    for (let attempt = 0; attempt <= config.llm.maxSchemaRepairs; attempt++) {
      tracker.assertWithinBudget();

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      const result = await invoker.invoke(messages, { signal });

      if (result.usage) {
        tracker.record({
          node: request.node,
          provider: spec.provider,
          model: spec.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      }

      const parsed = request.schema.safeParse(result.parsed);
      if (parsed.success) {
        return parsed.data;
      }

      lastIssues =
        result.parsed === null || result.parsed === undefined
          ? ["the model returned no structured output"]
          : formatIssues(parsed.error.issues);
      logger.warn(
        { node: request.node, model: spec.model, attempt, issues: lastIssues },
        "structured output failed validation",
      );
      messages = [...request.messages, repairMessage(lastIssues)];
    }

    throw new SchemaValidationError(request.schemaName, lastIssues);
  }
}
