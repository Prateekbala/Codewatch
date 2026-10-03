import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { prepareDiff } from "../../diff/prepare.ts";
import type { PreparedDiff } from "../../diff/types.ts";
import type { ChangedFile, CommitSummary, PullRequest } from "../../github/types.ts";
import type { CoreServices } from "../../services.ts";

import { DESCRIBE_SECTION_ID, formatDescription, sanitizeDescribeOutput } from "./format.ts";
import { createDescribePrompt } from "./prompt.ts";
import { DescribeOutputSchema, type DescribeOutput } from "./schema.ts";

export interface DescribeResult {
  readonly title: string;
  readonly output: DescribeOutput;
  readonly sectionId: string;
  readonly sectionBody: string;
  readonly prepared: PreparedDiff;
  readonly promptHashes: { readonly system: string; readonly user: string };
}

const DescribeState = Annotation.Root({
  pr: Annotation<PullRequest>(),
  files: Annotation<ChangedFile[]>(),
  commits: Annotation<CommitSummary[]>(),
  prepared: Annotation<PreparedDiff>(),
  output: Annotation<DescribeOutput>(),
  result: Annotation<DescribeResult>(),
});

type State = typeof DescribeState.State;

const buildNotices = (prepared: PreparedDiff): string[] => {
  if (prepared.omitted.length === 0) {
    return [];
  }
  return [
    `${prepared.omitted.length} file(s) were too large to analyze and are not covered by this description.`,
  ];
};

export const createDescribeGraph = (services: CoreServices) => {
  const { github, llm, config, logger, counter } = services;

  const fetchContext = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    runnable.signal?.throwIfAborted();
    const [files, commits] = await Promise.all([
      github.listFiles(state.pr.ref),
      github.listCommits(state.pr.ref),
    ]);
    return { files, commits };
  };

  const prepare = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    const { pr } = state;
    const prompt = createDescribePrompt(pr, state.commits, config);
    const repo = { owner: pr.ref.owner, repo: pr.ref.repo };
    const prepared = await prepareDiff({
      files: state.files,
      config,
      counter,
      contextWindow: llm.contextWindowFor("summarizer"),
      overheadTokens: counter.count(prompt.overheadText),
      loadContent: async (file) => {
        try {
          const content = await github.getFileContent(repo, file.path, pr.headSha);
          return content?.content ?? null;
        } catch (error) {
          logger.debug({ err: error, path: file.path }, "could not load file for context");
          return null;
        }
      },
      ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
    });
    logger.info(
      {
        files: state.files.length,
        included: prepared.included.length,
        omitted: prepared.omitted.length,
        ignored: prepared.ignored.length,
        tokens: prepared.tokens,
        budget: prepared.budget,
      },
      "diff prepared",
    );
    return { prepared };
  };

  const generate = async (state: State, runnable: RunnableConfig): Promise<Partial<State>> => {
    const prompt = createDescribePrompt(state.pr, state.commits, config);
    const output = await llm.invokeStructured({
      role: "summarizer",
      node: "describe.generate",
      schema: DescribeOutputSchema,
      schemaName: "pull_request_description",
      messages: [prompt.system, prompt.build(state.prepared)],
      ...(runnable.signal === undefined ? {} : { signal: runnable.signal }),
    });
    return { output };
  };

  const compose = (state: State): Partial<State> => {
    const prompt = createDescribePrompt(state.pr, state.commits, config);
    const known = new Set(state.files.map((file) => file.path));
    const output = sanitizeDescribeOutput(state.output, known);
    const result: DescribeResult = {
      title: output.title,
      output,
      sectionId: DESCRIBE_SECTION_ID,
      sectionBody: formatDescription(output, buildNotices(state.prepared)),
      prepared: state.prepared,
      promptHashes: prompt.hashes,
    };
    return { output, result };
  };

  return new StateGraph(DescribeState)
    .addNode("fetchContext", fetchContext)
    .addNode("prepareDiff", prepare)
    .addNode("generate", generate)
    .addNode("compose", compose)
    .addEdge(START, "fetchContext")
    .addEdge("fetchContext", "prepareDiff")
    .addEdge("prepareDiff", "generate")
    .addEdge("generate", "compose")
    .addEdge("compose", END)
    .compile();
};

export const runDescribe = async (
  services: CoreServices,
  pr: PullRequest,
  signal?: AbortSignal,
): Promise<DescribeResult> => {
  const graph = createDescribeGraph(services);
  const state = await graph.invoke(
    { pr },
    {
      recursionLimit: services.config.review.maxGraphSteps,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return state.result;
};
