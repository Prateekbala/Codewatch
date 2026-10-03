import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type PromptName =
  | "describe.system"
  | "describe.user"
  | "review.system"
  | "review.user"
  | "summary.system"
  | "summary.user"
  | "verifier.system"
  | "verifier.user";

export interface PromptTemplate {
  readonly name: PromptName;
  readonly hash: string;
  readonly raw: string;
  render(variables: Readonly<Record<string, string | number>>): string;
}

const TEMPLATE_ROOT = new URL("./templates/", import.meta.url);
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const HASH_LENGTH = 12;

const cache = new Map<PromptName, PromptTemplate>();

export class PromptRenderError extends Error {
  constructor(name: string, variable: string) {
    super(`Prompt "${name}" references missing variable "${variable}"`);
    this.name = "PromptRenderError";
  }
}

export const loadPrompt = (name: PromptName): PromptTemplate => {
  const cached = cache.get(name);
  if (cached) {
    return cached;
  }
  const raw = readFileSync(new URL(`${name}.md`, TEMPLATE_ROOT), "utf8").trimEnd();
  const template: PromptTemplate = {
    name,
    raw,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, HASH_LENGTH),
    render(variables) {
      return raw.replace(PLACEHOLDER, (_, variable: string) => {
        const value = variables[variable];
        if (value === undefined) {
          throw new PromptRenderError(name, variable);
        }
        return String(value);
      });
    },
  };
  cache.set(name, template);
  return template;
};

export const UNTRUSTED_TAGS = [
  "pull_request",
  "author_description",
  "commits",
  "change_summary",
  "diff",
  "repo_rules",
  "ci_summary",
  "prior_findings",
  "overview",
  "findings",
  "linked_issues",
  "finding",
  "explanation",
  "evidence",
] as const;

export const neutralizeTags = (text: string): string =>
  text.replace(new RegExp(`<(/?)(${UNTRUSTED_TAGS.join("|")})(?=[\\s>/])`, "gi"), "<\\$1$2");
