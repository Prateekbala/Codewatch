import type { CheckAnnotation } from "../../github/types.ts";

import { fingerprintFinding } from "./fingerprint.ts";
import type { Finding } from "./schema.ts";

const ANNOTATION_SEVERITY: Readonly<Record<CheckAnnotation["level"], Finding["severity"]>> = {
  failure: "high",
  warning: "medium",
  notice: "low",
};

const annotationTitle = (annotation: CheckAnnotation): string => {
  const title = annotation.title?.trim();
  if (title !== undefined && title !== "") {
    return title.slice(0, 120);
  }
  const line = annotation.message.trim().split("\n")[0] ?? "CI reported a problem";
  return line.slice(0, 120);
};

export const findingsFromAnnotations = (
  annotations: readonly CheckAnnotation[],
  changedPaths: ReadonlySet<string>,
): Finding[] => {
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const annotation of annotations) {
    if (!changedPaths.has(annotation.path) || annotation.level === "notice") {
      continue;
    }
    const title = annotationTitle(annotation);
    const base = {
      category: "bug" as const,
      severity: ANNOTATION_SEVERITY[annotation.level],
      confidence: 1,
      path: annotation.path,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      side: "RIGHT" as const,
      title,
      explanation: annotation.message.trim(),
      evidence: [`CI ${annotation.level}: ${annotation.message.trim()}`],
      source: "ci" as const,
    };
    const id = fingerprintFinding(base);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    findings.push({ ...base, id });
  }

  return findings;
};
