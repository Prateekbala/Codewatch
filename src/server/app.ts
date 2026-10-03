import { Hono } from "hono";

import { loadEnv, requireGitHubAuth } from "../core/config/env.ts";
import { resolveConfig } from "../core/config/loader.ts";
import { DefaultGitHubClientFactory } from "../core/github/factory.ts";
import { createLogger } from "../core/logging/logger.ts";
import { createRuntime } from "../core/runtime.ts";

import { DeliveryCache } from "./delivery-cache.ts";
import {
  issueCommentRefFromWebhook,
  parseIssueCommentWebhook,
  parsePullRequestWebhook,
  pullRequestRefFromWebhook,
} from "./github-payload.ts";
import { RunSupervisor } from "./run-supervisor.ts";
import {
  isReviewablePullRequestAction,
  parseSlashCommand,
  shouldSkipAutomaticReview,
} from "./skip-rules.ts";
import { verifyGitHubSignature } from "./webhook-signature.ts";
import { runPullRequestJob } from "./worker.ts";

export interface ServerOptions {
  readonly port: number;
}

export const createApp = (options: ServerOptions): Hono => {
  const env = loadEnv();
  const config = resolveConfig([]).config;
  const logger = createLogger({ level: env.logLevel, pretty: env.nodeEnv !== "production" });
  const runtime = createRuntime({ env, logger });
  const githubAuth = requireGitHubAuth(env);
  const factory = new DefaultGitHubClientFactory(githubAuth, logger);
  const deliveries = new DeliveryCache(config.server.maxDeliveryCache);
  const supervisor = new RunSupervisor();
  const webhookSecret = env.webhookSecret;

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/webhooks/github", async (c) => {
    if (webhookSecret === undefined) {
      return c.text("webhook secret not configured", 503);
    }
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyGitHubSignature(webhookSecret, rawBody, signature)) {
      return c.text("invalid signature", 401);
    }

    const deliveryId = c.req.header("x-github-delivery");
    if (deliveryId === undefined) {
      return c.text("missing delivery id", 400);
    }
    if (deliveries.has(deliveryId)) {
      return c.body(null, 202);
    }
    deliveries.remember(deliveryId);

    const event = c.req.header("x-github-event");
    const payload: unknown = JSON.parse(rawBody);

    if (event === "pull_request") {
      const parsed = parsePullRequestWebhook(payload);
      if (parsed === null || !isReviewablePullRequestAction(parsed.action)) {
        return c.body(null, 202);
      }
      if (!config.server.autoReviewOnOpen) {
        return c.body(null, 202);
      }
      const installationId = parsed.installation?.id;
      if (installationId === undefined) {
        return c.text("missing installation", 422);
      }
      const ref = pullRequestRefFromWebhook(parsed);
      const client = factory.forInstallation(installationId);
      const pr = await client.getPullRequest(ref);
      const skip = shouldSkipAutomaticReview(pr);
      if (skip !== null) {
        logger.info({ ref, skip }, "skipped automatic review");
        return c.body(null, 202);
      }
      void runPullRequestJob(
        runtime,
        supervisor,
        client,
        {
          ref,
          headSha: pr.headSha,
          installationId,
          command: "review",
          reason: `pull_request.${parsed.action}`,
        },
        logger,
      );
      return c.body(null, 202);
    }

    if (event === "issue_comment") {
      const parsed = parseIssueCommentWebhook(payload);
      if (parsed?.issue.pull_request === undefined) {
        return c.body(null, 202);
      }
      const command = parseSlashCommand(parsed.comment.body);
      if (command === null) {
        return c.body(null, 202);
      }
      const installationId = parsed.installation?.id;
      if (installationId === undefined) {
        return c.text("missing installation", 422);
      }
      const ref = issueCommentRefFromWebhook(parsed);
      const client = factory.forInstallation(installationId);
      const allowed = await client.isCollaborator(ref, parsed.comment.user.login);
      if (!allowed) {
        logger.warn(
          { ref, user: parsed.comment.user.login },
          "ignored slash command from non-collaborator",
        );
        return c.body(null, 202);
      }
      const pr = await client.getPullRequest(ref);
      void runPullRequestJob(
        runtime,
        supervisor,
        client,
        {
          ref,
          headSha: pr.headSha,
          installationId,
          command,
          reason: `issue_comment.${command}`,
        },
        logger,
      );
      return c.body(null, 202);
    }

    return c.body(null, 202);
  });

  app.get("/", (c) =>
    c.json({
      service: "pr-review-agent",
      port: options.port,
      endpoints: ["/healthz", "/webhooks/github"],
    }),
  );

  return app;
};
