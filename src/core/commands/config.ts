import { stringify } from "yaml";

import { loadRepoConfigLayer } from "../context/repo-config.ts";
import { type ConfigIssue, type ConfigLayer, resolveConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import type { RepoRef } from "../github/types.ts";
import type { Runtime } from "../runtime.ts";

export interface EffectiveConfig {
  readonly config: Config;
  readonly appliedLayers: readonly string[];
  readonly issues: readonly ConfigIssue[];
}

export const resolveEffectiveConfig = async (
  runtime: Runtime,
  repo: RepoRef | null,
  cliLayer?: ConfigLayer,
): Promise<EffectiveConfig> => {
  const layers: ConfigLayer[] = [...runtime.baseLayers];

  if (repo !== null) {
    const client = await runtime.github.forRepo(repo);
    const defaultBranch = await client.getDefaultBranch(repo);
    const layer = await loadRepoConfigLayer(client, repo, defaultBranch);
    if (layer) {
      layers.push(layer);
    }
  }
  if (cliLayer) {
    layers.push(cliLayer);
  }

  const resolved = resolveConfig(layers);
  return {
    config: resolved.config,
    appliedLayers: resolved.appliedLayers,
    issues: resolved.issues,
  };
};

export const formatConfigYaml = (config: Config): string => stringify(config, { lineWidth: 100 });
