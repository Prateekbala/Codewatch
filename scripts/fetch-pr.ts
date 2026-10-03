import { existsSync } from "node:fs";

import { loadEnv, requireGitHubAuth } from "../src/core/config/env.ts";
import { DefaultGitHubClientFactory } from "../src/core/github/factory.ts";
import { parsePullRequestRef } from "../src/core/github/ref.ts";
import { createLogger } from "../src/core/logging/logger.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const input = process.argv[2];
if (input === undefined) {
  console.error("usage: pnpm smoke:github <pr-url | owner/repo#number>");
  process.exit(2);
}

const env = loadEnv();
const logger = createLogger({ level: env.logLevel, pretty: process.stderr.isTTY });
const auth = requireGitHubAuth(env);
const ref = parsePullRequestRef(input);

const factory = new DefaultGitHubClientFactory(auth, logger);
const client = await factory.forRepo(ref);
const pr = await client.getPullRequest(ref);
const files = await client.listFiles(ref);

console.log(`auth: ${auth.kind}`);
console.log(`${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}: ${pr.title}`);
console.log(`author: ${pr.author} | ${pr.baseRef} <- ${pr.headRef} @ ${pr.headSha.slice(0, 7)}`);
console.log(`files: ${files.length} | +${pr.additions} -${pr.deletions} | draft: ${pr.draft}`);
for (const file of files.slice(0, 20)) {
  console.log(`  ${file.status.padEnd(9)} ${file.path}${file.patch === null ? " (no patch)" : ""}`);
}
