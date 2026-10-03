import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

export const ExpectedFindingSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  category: z.enum(["bug", "security", "performance", "tests", "api", "style"]).optional(),
});

export const EvalCaseSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  pr: z.strictObject({
    title: z.string(),
    body: z.string().default(""),
    author: z.string().default("octo"),
  }),
  commits: z.array(z.string()).default([]),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        patch: z.string(),
        status: z.enum(["added", "modified", "removed", "renamed"]).default("modified"),
      }),
    )
    .min(1),
  contents: z.record(z.string(), z.string()).default({}),
  expected: z.array(ExpectedFindingSchema),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

export const loadEvalCases = (directory: string, only?: readonly string[]): EvalCase[] => {
  const cases = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = EvalCaseSchema.safeParse(
        JSON.parse(readFileSync(join(directory, name), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(`invalid eval case ${name}: ${parsed.error.message}`);
      }
      return parsed.data;
    });
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) {
    throw new Error("eval case ids must be unique");
  }
  if (only === undefined || only.length === 0) {
    return cases;
  }
  const selected = cases.filter((item) => only.includes(item.id));
  const unknown = only.filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown eval case(s): ${unknown.join(", ")}`);
  }
  return selected;
};
