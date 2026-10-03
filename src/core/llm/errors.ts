export class MissingApiKeyError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`No API key configured for provider "${provider}"`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
  }
}

export class SchemaValidationError extends Error {
  readonly issues: readonly string[];

  constructor(schemaName: string, issues: readonly string[]) {
    super(`Model output did not match schema "${schemaName}": ${issues.join("; ")}`);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export class BudgetExceededError extends Error {
  readonly kind: "tokens" | "cost";
  readonly limit: number;
  readonly used: number;

  constructor(kind: "tokens" | "cost", limit: number, used: number) {
    super(`Run ${kind} budget exceeded: used ${used} of ${limit}`);
    this.name = "BudgetExceededError";
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

export interface ModelFailure {
  readonly model: string;
  readonly error: unknown;
}

export class AllModelsFailedError extends Error {
  readonly failures: readonly ModelFailure[];

  constructor(role: string, failures: readonly ModelFailure[]) {
    const detail = failures
      .map((failure) => {
        const reason =
          failure.error instanceof Error ? failure.error.message : String(failure.error);
        return `${failure.model}: ${reason}`;
      })
      .join(" | ");
    super(`All models failed for role "${role}": ${detail}`);
    this.name = "AllModelsFailedError";
    this.failures = failures;
  }
}
