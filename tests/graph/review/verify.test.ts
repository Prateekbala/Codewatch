import { describe, expect, it } from "vitest";

import { verifyFindings } from "../../../src/core/graph/review/verify.ts";
import { CostTracker } from "../../../src/core/llm/cost.ts";
import { LlmGateway } from "../../../src/core/llm/gateway.ts";
import { ScriptedLlm, silentLogger, testConfig } from "../../helpers/fakes.ts";
import { finding } from "../../helpers/review.ts";

describe("verifyFindings", () => {
  it("drops llm findings the verifier rejects and keeps ci findings", async () => {
    const llm = new ScriptedLlm({
      "gpt-5": [{ parsed: { keep: false, reason: "not proven" } }],
    });
    const config = testConfig({ review: { enableVerifier: true } });
    const gateway = new LlmGateway({
      config,
      tracker: CostTracker.fromConfig(config),
      adapterFactory: llm.factory,
      logger: silentLogger,
    });

    const result = await verifyFindings(gateway, config, [
      finding({ title: "Maybe" }),
      { ...finding({ path: "src/ci.ts", title: "CI" }), source: "ci" },
    ]);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.source).toBe("ci");
    expect(result.rejected).toBe(1);
  });
});
