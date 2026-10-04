import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

import type { Config } from "../../config/schema.ts";
import type { GitHubClient } from "../../github/client.ts";
import type { PullRequest } from "../../github/types.ts";
import type { ToolCallRequest, ToolDefinition } from "../../llm/adapters.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import type { Logger } from "../../logging/logger.ts";
import { loadPrompt, neutralizeTags } from "../../prompts/loader.ts";

import { FINDING_SEVERITIES, type Finding } from "./schema.ts";

const MAX_READ_LINES = 200;
const MAX_TOOL_OUTPUT_CHARS = 8_000;
const MAX_FIND_RESULTS = 40;
const MAX_SEARCH_RESULTS = 8;
const MAX_LOG_CHARS = 24_000;

export const InvestigationVerdictSchema = z.object({
  keep: z.boolean().describe("True only if the investigation shows the problem is real"),
  reason: z.string().describe("One or two sentences explaining the verdict"),
  revisedSeverity: z
    .enum(FINDING_SEVERITIES)
    .nullable()
    .describe("Corrected severity if the real impact differs from the stated one, otherwise null"),
  confirmingEvidence: z
    .array(z.string())
    .describe("Concrete facts seen via tools, as `path:line - what it shows`"),
});

export type InvestigationVerdict = z.infer<typeof InvestigationVerdictSchema>;

export interface InvestigationResult {
  readonly keep: boolean;
  /** The finding with any severity revision and new evidence applied. */
  readonly finding: Finding;
  readonly reason: string;
  readonly toolCalls: number;
  readonly revisedSeverity: boolean;
}

export type Investigator = (finding: Finding, signal?: AbortSignal) => Promise<InvestigationResult>;

const ReadFileArgs = z.object({
  path: z.string().describe("Repository-relative file path"),
  startLine: z.number().optional().describe("First line to read (1-based). Default 1"),
  endLine: z.number().optional().describe(`Last line to read. At most ${MAX_READ_LINES} lines`),
});
const FindFilesArgs = z.object({
  pattern: z
    .string()
    .describe("Case-insensitive substring of the file path, e.g. `auth` or `.sql`"),
});
const SearchCodeArgs = z.object({
  query: z.string().describe("Identifier or phrase to search for in the repository's code"),
});

export const INVESTIGATION_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a file (or a line range) from the pull request head commit. Lines are numbered.",
    schema: ReadFileArgs,
  },
  {
    name: "find_files",
    description: "List repository file paths at the pull request head that contain a substring.",
    schema: FindFilesArgs,
  },
  {
    name: "search_code",
    description:
      "Search repository code for an identifier or phrase. Searches the default branch, so it may miss code added by this pull request; use read_file for changed files.",
    schema: SearchCodeArgs,
  },
];

const clip = (text: string, max = MAX_TOOL_OUTPUT_CHARS): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ToolRuntime {
  execute(call: ToolCallRequest, signal?: AbortSignal): Promise<string>;
}

const createToolRuntime = (github: GitHubClient, pr: PullRequest): ToolRuntime => {
  // Fork PRs live in the head repository; fall back to the base repository.
  const headRepo = pr.headRepo ?? { owner: pr.ref.owner, repo: pr.ref.repo };
  const baseRepo = { owner: pr.ref.owner, repo: pr.ref.repo };
  let tree: Promise<string[]> | undefined;

  const readFile = async (args: z.infer<typeof ReadFileArgs>): Promise<string> => {
    const path = args.path.replace(/^\/+/, "");
    const file = await github.getFileContent(headRepo, path, pr.headSha);
    if (file === null) {
      return `File not found at the pull request head: ${path}`;
    }
    const lines = file.content.split("\n");
    const start = Math.max(1, Math.floor(args.startLine ?? 1));
    const requestedEnd = Math.floor(args.endLine ?? start + MAX_READ_LINES - 1);
    const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
    if (start > lines.length) {
      return `${path} has only ${lines.length} lines.`;
    }
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    return `${path} (lines ${start}-${end} of ${lines.length})\n${body}`;
  };

  const findFiles = async (args: z.infer<typeof FindFilesArgs>): Promise<string> => {
    tree ??= github.listTree(headRepo, pr.headSha);
    const needle = args.pattern.toLowerCase();
    const matches = (await tree).filter((path) => path.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return `No files match "${args.pattern}".`;
    }
    const shown = matches.slice(0, MAX_FIND_RESULTS);
    const more = matches.length - shown.length;
    return `${shown.join("\n")}${more > 0 ? `\n… and ${more} more` : ""}`;
  };

  const searchCode = async (args: z.infer<typeof SearchCodeArgs>): Promise<string> => {
    const hits = await github.searchCode(baseRepo, args.query, MAX_SEARCH_RESULTS);
    if (hits.length === 0) {
      return `No code search results for "${args.query}" on the default branch.`;
    }
    return hits
      .map((hit) =>
        hit.fragments.length === 0
          ? hit.path
          : `${hit.path}\n${hit.fragments.map((fragment) => `  ${fragment.trim()}`).join("\n")}`,
      )
      .join("\n---\n");
  };

  return {
    async execute(call, signal) {
      signal?.throwIfAborted();
      try {
        switch (call.name) {
          case "read_file": {
            const args = ReadFileArgs.safeParse(call.args);
            return args.success
              ? clip(await readFile(args.data))
              : "Invalid arguments: need `path`.";
          }
          case "find_files": {
            const args = FindFilesArgs.safeParse(call.args);
            return args.success
              ? clip(await findFiles(args.data))
              : "Invalid arguments: need `pattern`.";
          }
          case "search_code": {
            const args = SearchCodeArgs.safeParse(call.args);
            return args.success
              ? clip(await searchCode(args.data))
              : "Invalid arguments: need `query`.";
          }
          default:
            return `Unknown tool "${call.name}". Available: read_file, find_files, search_code.`;
        }
      } catch (error) {
        signal?.throwIfAborted();
        // Tool failures (rate limits, missing paths) are observations, not run failures.
        return `Tool error: ${describeError(error)}`;
      }
    },
  };
};

const wrapResult = (text: string): string =>
  `<tool_result>\n${neutralizeTags(text)}\n</tool_result>`;

const formatArgs = (args: Record<string, unknown>): string => JSON.stringify(args);

export interface InvestigatorDeps {
  readonly llm: LlmGateway;
  readonly github: GitHubClient;
  readonly config: Config;
  readonly logger: Logger;
  readonly pr: PullRequest;
  readonly changedPaths: readonly string[];
}

/**
 * Builds a per-run investigator: a bounded tool-use loop where the model decides what to read
 * or search before ruling on one finding.
 */
export const createInvestigator = (deps: InvestigatorDeps): Investigator => {
  const { llm, github, config, logger, pr, changedPaths } = deps;
  const maxToolCalls = config.review.maxToolCallsPerReviewer;
  const runtime = createToolRuntime(github, pr);

  const investigatorSystem = loadPrompt("investigator.system");
  const userTemplate = loadPrompt("investigator.user");
  const verdictTemplate = loadPrompt("investigator.verdict");
  const verifierSystem = loadPrompt("verifier.system");

  const changedFiles = changedPaths
    .slice(0, 60)
    .map((path) => `- ${neutralizeTags(path)}`)
    .join("\n");

  return async (finding, signal) => {
    const userMessage = new HumanMessage(
      userTemplate.render({
        category: finding.category,
        severity: finding.severity,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: neutralizeTags(finding.title),
        explanation: neutralizeTags(finding.explanation),
        evidence: neutralizeTags(
          finding.evidence.length === 0 ? "(none)" : finding.evidence.join("\n"),
        ),
        changedFiles: changedFiles === "" ? "(none)" : changedFiles,
      }),
    );
    const messages: BaseMessage[] = [
      new SystemMessage(investigatorSystem.render({ maxToolCalls, language: config.language })),
      userMessage,
    ];

    const log: string[] = [];
    let toolCalls = 0;

    // Each turn the model either asks for tools or stops; a final turn lets it answer after the
    // last allowed call.
    for (let turn = 0; turn <= maxToolCalls; turn++) {
      const step = await llm.invokeWithTools({
        role: "verifier",
        node: "review.investigate",
        tools: INVESTIGATION_TOOLS,
        messages,
        ...(signal === undefined ? {} : { signal }),
      });

      if (step.toolCalls.length === 0) {
        if (step.text.trim() !== "") {
          log.push(`Your note: ${neutralizeTags(step.text.trim())}`);
        }
        break;
      }

      messages.push(step.message);
      for (const call of step.toolCalls) {
        let output: string;
        if (toolCalls >= maxToolCalls) {
          output = "Tool budget exhausted. Do not call more tools; give your final note.";
        } else {
          toolCalls += 1;
          output = await runtime.execute(call, signal);
        }
        const wrapped = wrapResult(output);
        messages.push(
          new ToolMessage({ content: wrapped, tool_call_id: call.id, name: call.name }),
        );
        log.push(`Tool call: ${call.name}(${formatArgs(call.args)})\n${wrapped}`);
      }
    }

    const verdict = await llm.invokeStructured({
      role: "verifier",
      node: "review.investigate.verdict",
      schema: InvestigationVerdictSchema,
      schemaName: "investigation_verdict",
      messages: [
        new SystemMessage(verifierSystem.render({ language: config.language })),
        userMessage,
        new HumanMessage(
          verdictTemplate.render({
            log: clip(log.length === 0 ? "(no tools were used)" : log.join("\n\n"), MAX_LOG_CHARS),
          }),
        ),
      ],
      ...(signal === undefined ? {} : { signal }),
    });

    const severityChanged =
      verdict.keep &&
      verdict.revisedSeverity !== null &&
      verdict.revisedSeverity !== finding.severity;
    const confirming = verdict.confirmingEvidence
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const updated: Finding = verdict.keep
      ? {
          ...finding,
          severity: verdict.revisedSeverity ?? finding.severity,
          evidence: [...finding.evidence, ...confirming],
        }
      : finding;

    logger.debug(
      {
        path: finding.path,
        startLine: finding.startLine,
        keep: verdict.keep,
        toolCalls,
        reason: verdict.reason,
      },
      "finding investigated",
    );
    return {
      keep: verdict.keep,
      finding: updated,
      reason: verdict.reason,
      toolCalls,
      revisedSeverity: severityChanged,
    };
  };
};
