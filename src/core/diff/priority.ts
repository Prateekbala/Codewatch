import type { ChangedFile } from "../github/types.ts";

import type { FileCategory } from "./types.ts";

const TEST_PATTERN =
  /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
const DOCS_PATTERN =
  /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG)/i;
const CONFIG_PATTERN =
  /\.(ya?ml|json|toml|ini|cfg|conf|env|properties|tf|hcl)$|(^|\/)(Dockerfile|Makefile|\.github\/)|\.(config|rc)\.[a-z]+$/i;
const SENSITIVE_PATTERN =
  /auth|crypto|secret|token|password|credential|permission|session|security|migration|\.sql$/i;

const CATEGORY_BASE: Readonly<Record<FileCategory, number>> = {
  source: 100,
  config: 60,
  test: 40,
  docs: 20,
};

const CHURN_CAP = 200;
const SENSITIVE_BONUS = 25;
const DELETED_PENALTY = 30;

export const categorize = (path: string): FileCategory => {
  if (TEST_PATTERN.test(path)) {
    return "test";
  }
  if (DOCS_PATTERN.test(path)) {
    return "docs";
  }
  if (CONFIG_PATTERN.test(path)) {
    return "config";
  }
  return "source";
};

export const scoreFile = (file: ChangedFile): { category: FileCategory; score: number } => {
  const category = categorize(file.path);
  let score = CATEGORY_BASE[category];
  score += Math.min(file.additions + file.deletions, CHURN_CAP) / 10;
  if (category === "source" && SENSITIVE_PATTERN.test(file.path)) {
    score += SENSITIVE_BONUS;
  }
  if (file.status === "removed") {
    score -= DELETED_PENALTY;
  }
  return { category, score };
};
