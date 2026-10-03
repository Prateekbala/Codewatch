import { z } from "zod";

export const PR_TYPES = [
  "feature",
  "bugfix",
  "refactor",
  "performance",
  "security",
  "tests",
  "docs",
  "dependencies",
  "chore",
  "other",
] as const;

export const WalkthroughEntrySchema = z.object({
  group: z.string().describe("Short name for a set of related changes"),
  files: z.array(z.string()).describe("Paths of changed files in this group"),
  description: z.string().describe("One or two sentences on what changed in this group"),
});

export const DescribeOutputSchema = z.object({
  title: z.string().describe("Imperative, specific title of at most 72 characters"),
  type: z.enum(PR_TYPES).describe("Primary nature of the change"),
  summary: z.string().describe("Two to four sentences covering what changed and why"),
  walkthrough: z.array(WalkthroughEntrySchema).describe("Changes grouped by purpose"),
  risks: z
    .array(z.string())
    .describe("Concrete risks reviewers should check; empty when there are none"),
});

export type DescribeOutput = z.infer<typeof DescribeOutputSchema>;
export type PullRequestType = (typeof PR_TYPES)[number];
