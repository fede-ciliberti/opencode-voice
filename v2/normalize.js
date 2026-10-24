// Normalización configurable: on/off + modelo/endpoint propios.
//
// Opciones (plugin options en opencode.json/cli.json):
//   normalize:          true|false  (default true)
//   normalizeModel:     string      (default: model)
//   normalizeEndpoint:  string      (default: endpoint)
//   normalizeApiKeyEnv: string      (default: apiKeyEnv)
//   normalizeFallbacks: array       (default: fallbacks)

import { createClient } from "../lib/llm-client.js";

export function createComplete(options = {}, log = () => {}) {
  const enabled = options.normalize !== false;
  const client = createClient({
    ...options,
    endpoint: options.normalizeEndpoint ?? options.endpoint,
    model: options.normalizeModel ?? options.model,
    apiKeyEnv: options.normalizeApiKeyEnv ?? options.apiKeyEnv,
    fallbacks: options.normalizeFallbacks ?? options.fallbacks,
  });

  async function complete(opts) {
    if (!enabled) return { text: null, error: "normalization disabled" };
    return client.complete(opts);
  }

  log("normalize.config", {
    enabled,
    model: options.normalizeModel ?? options.model ?? null,
    endpoint: options.normalizeEndpoint ?? options.endpoint ?? null,
    apiKeyEnv: options.normalizeApiKeyEnv ?? options.apiKeyEnv ?? null,
  });

  return { complete, enabled };
}
