import { randomUUID } from "node:crypto";

import {
  destination,
  pino,
  stdTimeFunctions,
  type Logger as PinoLogger,
  type LoggerOptions,
} from "pino";

export type Logger = PinoLogger;

export interface RunContext {
  readonly runId: string;
  readonly installationId?: number;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
}

export interface CreateLoggerOptions {
  readonly level?: string;
  readonly pretty?: boolean;
  readonly destination?: NodeJS.WritableStream;
}

export const newRunId = (): string => randomUUID();

const REDACT_PATHS = [
  "token",
  "privateKey",
  "apiKey",
  "authorization",
  "*.token",
  "*.privateKey",
  "*.apiKey",
  "*.authorization",
  "headers.authorization",
];

export const createLogger = (options: CreateLoggerOptions = {}): Logger => {
  const config: LoggerOptions = {
    level: options.level ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: null,
    timestamp: stdTimeFunctions.isoTime,
  };
  if (options.pretty === true) {
    return pino({
      ...config,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, destination: 2, translateTime: "HH:MM:ss" },
      },
    });
  }
  return options.destination
    ? pino(config, options.destination)
    : pino(config, destination({ fd: 2, sync: false }));
};

export const withRunContext = (logger: Logger, context: RunContext): Logger =>
  logger.child(context);
