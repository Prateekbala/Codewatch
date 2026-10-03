import type { Config } from "./config/schema.ts";
import type { GitHubClient } from "./github/client.ts";
import type { LlmGateway } from "./llm/gateway.ts";
import type { TokenCounter } from "./llm/tokens.ts";
import type { Logger } from "./logging/logger.ts";

export interface CoreServices {
  readonly github: GitHubClient;
  readonly llm: LlmGateway;
  readonly config: Config;
  readonly logger: Logger;
  readonly counter: TokenCounter;
}
