import type pg from "pg"

import { ToolLifecycle, type ToolLifecycleOptions } from "./lifecycle.js"
import { createPostgresReadToolDataSource } from "./read-data-source.js"
import { createReadOnlyTools } from "./read-tools.js"
import { ToolRegistry } from "./registry.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import { ToolRouter } from "./router.js"

export * from "./lifecycle.js"
export * from "./read-data-source.js"
export * from "./read-tools.js"
export * from "./redaction.js"
export * from "./registry.js"
export * from "./router.js"
export * from "./schema-validator.js"
export * from "./types.js"

export function createWorkerToolRuntime(
  pool: pg.Pool,
  lifecycleOptions: Omit<ToolLifecycleOptions, "references"> & { references?: ToolLifecycleOptions["references"] },
): { registry: ToolRegistry; router: ToolRouter; references: ToolLifecycleOptions["references"] } {
  const references = lifecycleOptions.references ?? new InMemoryToolResultReferenceStore()
  const registry = new ToolRegistry(createReadOnlyTools(createPostgresReadToolDataSource(pool)))
  const lifecycle = new ToolLifecycle({ ...lifecycleOptions, references })
  return { registry, router: new ToolRouter(registry, lifecycle), references }
}
