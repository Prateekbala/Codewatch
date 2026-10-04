import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Command, Option } from "commander";
import ora from "ora";

import { formatConfigYaml, resolveEffectiveConfig } from "../core/commands/config.ts";
import { runCommand } from "../core/commands/run.ts";
import { loadEnv } from "../core/config/env.ts";
import { type ConfigLayer, configLayerFromYaml } from "../core/config/loader.ts";
import { parsePullRequestRef, parseRepoRef } from "../core/github/ref.ts";
import { createLogger } from "../core/logging/logger.ts";
import { createRuntime, type Runtime } from "../core/runtime.ts";

import {
  describeOutcomeToJson,
  describeOutcomeToText,
  formatIssues,
  reviewOutcomeToJson,
  reviewOutcomeToText,
} from "./output.ts";

interface GlobalOptions {
  readonly config?: string;
  readonly logLevel?: string;
}

const loadDotEnv = (): void => {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
};

const cliLayerFrom = (path: string | undefined): ConfigLayer | undefined => {
  if (path === undefined) {
    return undefined;
  }
  return configLayerFromYaml("cli", path, readFileSync(path, "utf8"));
};

const buildRuntime = (options: GlobalOptions, json: boolean): Runtime => {
  const env = loadEnv();
  const logger = createLogger({
    level: options.logLevel ?? env.logLevel,
    pretty: !json && process.stderr.isTTY,
  });
  return createRuntime({ env, logger });
};

const installAbortHandler = (): AbortSignal => {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort(new Error("interrupted"));
  });
  process.once("SIGTERM", () => {
    controller.abort(new Error("terminated"));
  });
  return controller.signal;
};

export const buildProgram = (): Command => {
  const program = new Command()
    .name("pr-agent")
    .description("Review and describe GitHub pull requests")
    .addOption(new Option("-c, --config <path>", "YAML file with configuration overrides"))
    .addOption(
      new Option("--log-level <level>", "log verbosity").choices([
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "silent",
      ]),
    )
    .showHelpAfterError();

  program
    .command("describe")
    .description("Generate a pull request title and description")
    .argument("<pr>", "pull request URL or owner/repo#number")
    .option("--dry-run", "print the result without updating the pull request", false)
    .option("--json", "print machine-readable JSON", false)
    .option("--update-title", "also replace the pull request title")
    .action(
      async (
        pr: string,
        options: { dryRun: boolean; json: boolean; updateTitle?: boolean },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<GlobalOptions>();
        const isTTY = !options.json && process.stdout.isTTY === true;
        const runtime = buildRuntime(globals, options.json);
        const spinner = isTTY
          ? ora({ text: `Generating description for ${pr} …`, color: "cyan" }).start()
          : null;
        try {
          const outcome = await runCommand(runtime, parsePullRequestRef(pr), "describe", {
            dryRun: options.dryRun,
            signal: installAbortHandler(),
            ...(options.updateTitle === undefined ? {} : { updateTitle: options.updateTitle }),
            ...optionalCliLayer(globals.config),
          });
          spinner?.succeed("Done");
          if (outcome.configIssues.length > 0) {
            process.stderr.write(`${formatIssues(outcome.configIssues)}\n`);
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(describeOutcomeToJson(outcome), null, 2)}\n`
              : `${describeOutcomeToText(outcome)}\n`,
          );
        } catch (err) {
          spinner?.fail("Failed");
          throw err;
        }
      },
    );

  program
    .command("review")
    .description("Review a pull request and post findings")
    .argument("<pr>", "pull request URL or owner/repo#number")
    .option("--dry-run", "print the review without posting anything", false)
    .option("--json", "print machine-readable JSON", false)
    .option("--record-dir <dir>", "write the run record as JSON into this directory")
    .action(
      async (
        pr: string,
        options: { dryRun: boolean; json: boolean; recordDir?: string },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<GlobalOptions>();
        const isTTY = !options.json && process.stdout.isTTY === true;
        const runtime = buildRuntime(globals, options.json);
        const spinner = isTTY ? ora({ text: `Reviewing ${pr} …`, color: "cyan" }).start() : null;
        try {
          const outcome = await runCommand(runtime, parsePullRequestRef(pr), "review", {
            dryRun: options.dryRun,
            signal: installAbortHandler(),
            ...optionalCliLayer(globals.config),
          });
          const count = outcome.review.findings.length;
          spinner?.succeed(
            count > 0 ? `Review complete — ${count} finding(s)` : "Review complete — no issues",
          );
          if (outcome.configIssues.length > 0) {
            process.stderr.write(`${formatIssues(outcome.configIssues)}\n`);
          }
          const record = reviewOutcomeToJson(outcome);
          if (options.recordDir !== undefined) {
            mkdirSync(options.recordDir, { recursive: true });
            writeFileSync(
              join(options.recordDir, `${outcome.runId}.json`),
              `${JSON.stringify(record, null, 2)}\n`,
            );
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(record, null, 2)}\n`
              : `${reviewOutcomeToText(outcome)}\n`,
          );
        } catch (err) {
          spinner?.fail("Review failed");
          throw err;
        }
      },
    );

  const config = program.command("config").description("Inspect configuration");
  config
    .command("show")
    .description("Print the effective configuration")
    .option("--repo <owner/name>", "include the repository's .pr-agent.yaml")
    .option("--json", "print JSON instead of YAML", false)
    .action(async (options: { repo?: string; json: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const runtime = buildRuntime(globals, true);
      const repo = options.repo === undefined ? null : parseRepoRef(options.repo);
      const layer = cliLayerFrom(globals.config);
      const effective = await resolveEffectiveConfig(runtime, repo, layer);
      if (effective.issues.length > 0) {
        process.stderr.write(`${formatIssues(effective.issues)}\n`);
      }
      process.stdout.write(
        options.json
          ? `${JSON.stringify(effective.config, null, 2)}\n`
          : formatConfigYaml(effective.config),
      );
    });

  return program;
};

const optionalCliLayer = (path: string | undefined): { cliLayer?: ConfigLayer } => {
  const layer = cliLayerFrom(path);
  return layer ? { cliLayer: layer } : {};
};

export const main = async (argv: readonly string[]): Promise<number> => {
  loadDotEnv();
  try {
    await buildProgram().parseAsync([...argv]);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    return error instanceof Error && error.name === "ConfigError" ? 2 : 1;
  }
};
