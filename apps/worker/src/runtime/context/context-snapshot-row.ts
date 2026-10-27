import {
  assertSnapshotIntegrity,
  parseSnapshotContent,
  snapshotCanonicalJson,
} from "./context-snapshot-canonical.js"
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ContextSnapshotError,
  type AgentContextSnapshot,
} from "./context-snapshot-types.js"

export type ContextSnapshotRow = Readonly<{
  id: unknown
  sessionId: unknown
  throughSequence: unknown
  version: unknown
  schemaVersion: unknown
  content: unknown
  summary: unknown
  checksum: unknown
  inputTokens: unknown
  outputTokens: unknown
  estimatedCostUsd: unknown
  tokenAccounting: unknown
  createdAt: unknown
}>

const SNAPSHOT_COLUMN_NAMES = [
  "id", "sessionId", "throughSequence", "version", "schemaVersion", "content", "summary", "checksum",
  "inputTokens", "outputTokens", "estimatedCostUsd", "tokenAccounting", "createdAt",
] as const

export const CONTEXT_SNAPSHOT_COLUMNS = SNAPSHOT_COLUMN_NAMES.map(column => `"${column}"`).join(", ")
export const CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED = SNAPSHOT_COLUMN_NAMES
  .map(column => `snapshot."${column}" AS "${column}"`).join(", ")

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
    throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  }
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return result
}

function decimal(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(result) || result < 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return Number(result.toFixed(8))
}

function sequence(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new ContextSnapshotError("store_conflict", "Invalid throughSequence")
  }
  let result: bigint
  try {
    result = BigInt(value)
  } catch {
    throw new ContextSnapshotError("store_conflict", "Invalid throughSequence")
  }
  if (result < 0n || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new ContextSnapshotError("store_conflict", "Invalid throughSequence")
  }
  return result
}

function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== "string") throw new ContextSnapshotError("store_conflict", "Invalid createdAt")
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new ContextSnapshotError("store_conflict", "Invalid createdAt")
  return result
}

export function mapContextSnapshotRow(row: ContextSnapshotRow): AgentContextSnapshot {
  const sessionId = nonEmpty(row.sessionId, "sessionId")
  const throughSequence = sequence(row.throughSequence)
  if (row.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) throw new ContextSnapshotError("store_conflict", "Unsupported context snapshot schema version")
  const content = parseSnapshotContent(row.content)
  const base = { sessionId, throughSequence, version: integer(row.version, "version"), content }
  const summary = nonEmpty(row.summary, "summary")
  const snapshot: AgentContextSnapshot = {
    id: nonEmpty(row.id, "id"),
    ...base,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    summary,
    memorySummary: summary,
    checksum: nonEmpty(row.checksum, "checksum"),
    inputTokens: integer(row.inputTokens, "inputTokens"),
    outputTokens: integer(row.outputTokens, "outputTokens"),
    estimatedCostUsd: decimal(row.estimatedCostUsd, "estimatedCostUsd"),
    tokenAccounting: row.tokenAccounting as AgentContextSnapshot["tokenAccounting"],
    canonicalJson: snapshotCanonicalJson(base),
    createdAt: date(row.createdAt),
  }
  assertSnapshotIntegrity(snapshot)
  return snapshot
}
