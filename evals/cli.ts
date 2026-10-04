import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadEnv } from "../src/core/config/env.ts";
import { configLayerFromYaml, resolveConfigStrict } from "../src/core/config/loader.ts";
import { CostTracker } from "../src/core/llm/cost.ts";
import { LlmGateway } from "../src/core/llm/gateway.ts";
import { createLogger } from "../src/core/logging/logger.ts";
import { createRuntime } from "../src/core/runtime.ts";

import { compareReports, type EvalReport, formatReport, runEval } from "./runner.ts";
import { loadEvalCases } from "./types.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const root = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    config: { type: "string" },
    baseline: { type: "string" },
    label: { type: "string", default: "local" },
    concurrency: { type: "string", default: "2" },
    tolerance: { type: "string", default: "0.05" },
    out: { type: "string", default: join(root, "reports") },
  },
});

const env = loadEnv();
const logger = createLogger({ level: env.logLevel, pretty: process.stderr.isTTY });
const runtime = createRuntime({ env, logger });

const config = resolveConfigStrict(
  values.config === undefined
    ? []
    : [configLayerFromYaml("cli", values.config, readFileSync(values.config, "utf8"))],
);

const cases = loadEvalCases(join(root, "cases"), values.case);

const report = await runEval({
  cases,
  label: values.label,
  concurrency: Number.parseInt(values.concurrency, 10),
  createServices: (client) => {
    const tracker = CostTracker.fromConfig(config);
    return {
      services: {
        github: client,
        llm: new LlmGateway({
          config,
          tracker,
          adapterFactory: runtime.adapterFactory,
          logger,
        }),
        config,
        logger,
        counter: runtime.counter,
      },
      usage: () => tracker.summary(),
    };
  },
});

const baseline =
  values.baseline === undefined
    ? undefined
    : (JSON.parse(readFileSync(values.baseline, "utf8")) as EvalReport);
const comparison =
  baseline === undefined
    ? undefined
    : compareReports(report, baseline, Number.parseFloat(values.tolerance));

mkdirSync(values.out, { recursive: true });
const file = join(values.out, `${report.startedAt.replaceAll(":", "-")}-${report.label}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`${formatReport(report, comparison)}\n\nreport: ${file}\n`);
process.exitCode =
  comparison?.regressed === true ||
  report.totals.erroredCases > 0 ||
  report.totals.degradedCases > 0
    ? 1
    : 0;
