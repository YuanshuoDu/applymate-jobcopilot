import type pg from "pg"

import { ToolLifecycle, type ToolLifecycleOptions } from "./lifecycle.js"
import { createPostgresReadToolDataSource } from "./read-data-source.js"
import { createReadOnlyTools } from "./read-tools.js"
import { ToolRegistry } from "./registry.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import { ToolRouter } from "./router.js"
import type { PolicyEngine } from "../policy/index.js"
import { createCoordinationTools } from "./coordination-tools.js"
import { createArtifactTools, type ArtifactToolStore } from "./artifact-tools.js"
import type { CoordinationRuntimeOptions, DurableWaitPort, CoordinationStore } from "./coordination-types.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import type { AgentTreeManager } from "../subagents/manager.js"
import { createGmailTools } from "./gmail-tools.js"
import type { GmailToolOptions } from "./gmail-types.js"
import { createWriteTools, type WriteToolOptions } from "./write-tools.js"

export * from "./lifecycle.js"
export * from "./read-data-source.js"
export * from "./read-tools.js"
export * from "./redaction.js"
export * from "./registry.js"
export * from "./router.js"
export * from "./schema-validator.js"
export * from "./types.js"
export * from "./coordination-types.js"
export * from "./coordination-tools.js"
export * from "./coordination-executors.js"
export * from "./gmail-client.js"
export * from "./gmail-store.js"
export * from "./gmail-tools.js"
export * from "./gmail-types.js"
export * from "./artifact-tools.js"
export * from "./application-submit-tool.js"
export * from "./write-tools.js"
export * from "../policy/index.js"

export type WorkerCoordinationOptions = {
  readonly manager: AgentTreeManager
  readonly store?: CoordinationStore
  readonly wait?: DurableWaitPort
}

export type WorkerGmailOptions = GmailToolOptions
export type WorkerArtifactOptions = { readonly store: ArtifactToolStore }
export type WorkerWriteOptions = Omit<WriteToolOptions, "pool">

export function createWorkerToolRuntime(
  pool: pg.Pool,
  lifecycleOptions: Omit<ToolLifecycleOptions, "references"> & { references?: ToolLifecycleOptions["references"] },
  policy?: PolicyEngine,
  coordination?: WorkerCoordinationOptions,
  gmail?: WorkerGmailOptions,
  artifacts?: WorkerArtifactOptions,
  write?: WorkerWriteOptions,
): { registry: ToolRegistry; router: ToolRouter; references: ToolLifecycleOptions["references"] } {
  const references = lifecycleOptions.references ?? new InMemoryToolResultReferenceStore()
  const definitions = createReadOnlyTools(createPostgresReadToolDataSource(pool))
  if (coordination) {
    const options: CoordinationRuntimeOptions = {
      manager: coordination.manager,
      store: coordination.store ?? new PgCoordinationStore(pool),
      wait: coordination.wait,
    }
    definitions.push(...createCoordinationTools(options))
  }
  if (gmail) definitions.push(...createGmailTools(gmail))
  if (artifacts) definitions.push(...createArtifactTools(artifacts.store))
  if (write) definitions.push(...createWriteTools({ pool, ...write }))
  const registry = new ToolRegistry(definitions)
  const lifecycle = new ToolLifecycle({ ...lifecycleOptions, references })
  return { registry, router: new ToolRouter(registry, lifecycle, policy), references }
}
