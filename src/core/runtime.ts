import { type ChatModelAdapterFactory, createLangChainAdapterFactory } from "./llm/adapters.ts";
import { createTokenCounter, type TokenCounter } from "./llm/tokens.ts";
import type { ConfigLayer } from "./config/loader.ts";
import { type Env, requireGitHubAuth } from "./config/env.ts";
import { DefaultGitHubClientFactory, type GitHubClientFactory } from "./github/factory.ts";
import type { Logger } from "./logging/logger.ts";

export interface Runtime {
  readonly env: Env;
  readonly logger: Logger;
  readonly github: GitHubClientFactory;
  readonly adapterFactory: ChatModelAdapterFactory;
  readonly counter: TokenCounter;
  readonly baseLayers: readonly ConfigLayer[];
}

export interface RuntimeOptions {
  readonly env: Env;
  readonly logger: Logger;
  readonly baseLayers?: readonly ConfigLayer[];
  readonly github?: GitHubClientFactory;
  readonly adapterFactory?: ChatModelAdapterFactory;
  readonly counter?: TokenCounter;
}

const lazyGitHubFactory = (create: () => GitHubClientFactory): GitHubClientFactory => {
  let instance: GitHubClientFactory | undefined;
  const resolve = (): GitHubClientFactory => (instance ??= create());
  return {
    forRepo: (repo) => resolve().forRepo(repo),
    forInstallation: (installationId) => resolve().forInstallation(installationId),
  };
};

export const createRuntime = (options: RuntimeOptions): Runtime => ({
  env: options.env,
  logger: options.logger,
  github:
    options.github ??
    lazyGitHubFactory(
      () => new DefaultGitHubClientFactory(requireGitHubAuth(options.env), options.logger),
    ),
  adapterFactory: options.adapterFactory ?? createLangChainAdapterFactory(options.env),
  counter: options.counter ?? createTokenCounter(),
  baseLayers: options.baseLayers ?? [],
});
