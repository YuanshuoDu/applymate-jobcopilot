import { types as nodeTypes } from "node:util"
import { isCanonicalTaskGraphJobId } from "./task-graph-result-page-contract.js"

export const DISCOVERY_RECOVERY_SCHEMA_VERSION = "agent-harness.v2.task-graph.discovery-recovery.v1" as const
export const MAX_DISCOVERY_RECOVERY_JOB_IDS = 24
const MAX_ATTEMPT_COUNT = 1_000_000

export type DiscoveryRecoverySnapshot = Readonly<{
  schemaVersion: typeof DISCOVERY_RECOVERY_SCHEMA_VERSION
  attemptCount: number
  jobIds: readonly string[]
  truncated: boolean
}>

/** Parses the closed server sidecar without accepting accessors, proxies, sparse arrays or non-canonical IDs. */
export function parseDiscoveryRecovery(value: unknown): DiscoveryRecoverySnapshot | undefined {
  const row = exactRecord(value, ["schemaVersion", "attemptCount", "jobIds", "truncated"])
  if (!row || row.schemaVersion !== DISCOVERY_RECOVERY_SCHEMA_VERSION
    || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 1 || Number(row.attemptCount) > MAX_ATTEMPT_COUNT
    || typeof row.truncated !== "boolean") return undefined
  const jobIds = denseJobIds(row.jobIds)
  if (!jobIds || row.truncated && jobIds.length !== MAX_DISCOVERY_RECOVERY_JOB_IDS) return undefined
  return {
    schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION,
    attemptCount: Number(row.attemptCount),
    jobIds,
    truncated: row.truncated,
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
    const row = value as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return row
  } catch { return undefined }
}

function denseJobIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > MAX_DISCOVERY_RECOVERY_JOB_IDS) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.every(key => key === "length"
      || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)) return undefined
    const ids: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor) || !isCanonicalTaskGraphJobId(descriptor.value)) return undefined
      ids.push(descriptor.value)
    }
    return new Set(ids).size === ids.length ? ids : undefined
  } catch { return undefined }
}
