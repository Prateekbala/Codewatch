import type { Config } from "../config/schema.ts";

import { BudgetExceededError } from "./errors.ts";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface UsageRecord extends TokenUsage {
  readonly node: string;
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number | null;
}

export interface NodeUsage extends TokenUsage {
  readonly calls: number;
  readonly costUsd: number;
}

export interface CostSummary extends TokenUsage {
  readonly totalTokens: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly unpricedModels: readonly string[];
  readonly byNode: Readonly<Record<string, NodeUsage>>;
  readonly byModel: Readonly<Record<string, NodeUsage>>;
}

export interface CostLimits {
  readonly maxUsd: number | null;
  readonly maxTokens: number;
}

type Pricing = Config["llm"]["pricing"];

const TOKENS_PER_MILLION = 1_000_000;

const accumulate = (existing: NodeUsage | undefined, record: UsageRecord): NodeUsage => ({
  calls: (existing?.calls ?? 0) + 1,
  inputTokens: (existing?.inputTokens ?? 0) + record.inputTokens,
  outputTokens: (existing?.outputTokens ?? 0) + record.outputTokens,
  costUsd: (existing?.costUsd ?? 0) + (record.costUsd ?? 0),
});

export class CostTracker {
  readonly #pricing: Pricing;
  readonly #limits: CostLimits;
  readonly #records: UsageRecord[] = [];

  constructor(pricing: Pricing, limits: CostLimits) {
    this.#pricing = pricing;
    this.#limits = limits;
  }

  static fromConfig(config: Config): CostTracker {
    return new CostTracker(config.llm.pricing, {
      maxUsd: config.budgets.perRunUsd,
      maxTokens: config.budgets.perRunTokens,
    });
  }

  record(entry: { node: string; provider: string; model: string } & TokenUsage): UsageRecord {
    const price = this.#pricing[entry.model];
    const costUsd = price
      ? (entry.inputTokens * price.inputPerMTok + entry.outputTokens * price.outputPerMTok) /
        TOKENS_PER_MILLION
      : null;
    const record: UsageRecord = { ...entry, costUsd };
    this.#records.push(record);
    return record;
  }

  assertWithinBudget(): void {
    const summary = this.summary();
    if (summary.totalTokens >= this.#limits.maxTokens) {
      throw new BudgetExceededError("tokens", this.#limits.maxTokens, summary.totalTokens);
    }
    if (this.#limits.maxUsd !== null && summary.costUsd >= this.#limits.maxUsd) {
      throw new BudgetExceededError("cost", this.#limits.maxUsd, summary.costUsd);
    }
  }

  summary(): CostSummary {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const unpriced = new Set<string>();
    const byNode: Record<string, NodeUsage> = {};
    const byModel: Record<string, NodeUsage> = {};

    for (const record of this.#records) {
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
      costUsd += record.costUsd ?? 0;
      if (record.costUsd === null) {
        unpriced.add(record.model);
      }
      byNode[record.node] = accumulate(byNode[record.node], record);
      byModel[record.model] = accumulate(byModel[record.model], record);
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      calls: this.#records.length,
      costUsd,
      unpricedModels: [...unpriced],
      byNode,
      byModel,
    };
  }
}
