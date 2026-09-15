import type pg from "pg"

import { createContextSnapshotAdapter, type ContextSnapshotAdapter } from "./context-snapshot-adapter.js"
import { createPgContextSnapshotAdapterStore } from "./context-snapshot-pg-store.js"

export const DEFAULT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD = 12
export const DEFAULT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS = 4

const MIN_CONTEXT_COMPACTION_BOUND = 1
const MAX_CONTEXT_COMPACTION_BOUND = 64
const OBSERVATION_THRESHOLD_ENV = "AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD"
const KEEP_RECENT_OBSERVATIONS_ENV = "AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS"

type ProductionEnvironment = Readonly<Record<string, string | undefined>>

export type ProductionContextCompactionConfig = {
  readonly observationCountThreshold: number
  readonly keepRecentObservations: number
}

export type ProductionContextCompactionRuntimeOptions = {
  readonly contextSnapshotAdapter?: ContextSnapshotAdapter
}

function invalidConfiguration(name: string): TypeError {
  return new TypeError(`${name} must be an integer from ${MIN_CONTEXT_COMPACTION_BOUND} to ${MAX_CONTEXT_COMPACTION_BOUND}`)
}

function boundedInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw invalidConfiguration(name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < MIN_CONTEXT_COMPACTION_BOUND || value > MAX_CONTEXT_COMPACTION_BOUND) throw invalidConfiguration(name)
  return value
}

/** Resolve bounded server-owned settings only after the production gate is enabled. */
export function resolveProductionContextCompactionConfig(
  env: ProductionEnvironment = process.env,
): ProductionContextCompactionConfig {
  const observationCountThreshold = boundedInteger(
    OBSERVATION_THRESHOLD_ENV,
    env[OBSERVATION_THRESHOLD_ENV],
    DEFAULT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD,
  )
  const keepRecentObservations = boundedInteger(
    KEEP_RECENT_OBSERVATIONS_ENV,
    env[KEEP_RECENT_OBSERVATIONS_ENV],
    DEFAULT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS,
  )
  if (keepRecentObservations >= observationCountThreshold) {
    throw new TypeError(`${KEEP_RECENT_OBSERVATIONS_ENV} must be less than ${OBSERVATION_THRESHOLD_ENV}`)
  }
  return { observationCountThreshold, keepRecentObservations }
}

/** Build canonical runtime options without touching the database when disabled. */
export function createProductionContextCompactionOptions(input: {
  readonly enabled: boolean
  readonly pool: Pick<pg.Pool, "connect">
  readonly env?: ProductionEnvironment
}): ProductionContextCompactionRuntimeOptions {
  if (!input.enabled) return {}
  const config = resolveProductionContextCompactionConfig(input.env)
  const store = createPgContextSnapshotAdapterStore(input.pool)
  return {
    contextSnapshotAdapter: createContextSnapshotAdapter({
      store,
      observationCountThreshold: config.observationCountThreshold,
      keepRecentObservations: config.keepRecentObservations,
    }),
  }
}
