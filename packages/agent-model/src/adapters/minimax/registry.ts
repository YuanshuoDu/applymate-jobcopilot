import { ModelAdapterRegistry } from "../../registry.js"
import { createMiniMaxAdapter } from "./adapter.js"
import { MINIMAX_DEFAULT_MODEL, type MiniMaxAdapterOptions, type MiniMaxConfig } from "./types.js"

/** Create the default model registry without changing legacy ModelRouter resolution. */
export function createMiniMaxModelRegistry(
  config: MiniMaxConfig = {},
  options: MiniMaxAdapterOptions = {},
): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry()
  registry.register(createMiniMaxAdapter({ ...config, model: config.model ?? MINIMAX_DEFAULT_MODEL }, options))
  return registry
}
