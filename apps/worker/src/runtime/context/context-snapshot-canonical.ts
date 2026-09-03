import { createHash } from "node:crypto"

import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ContextSnapshotError,
  type AgentContextSnapshot,
  type ContextSnapshotContent,
} from "./context-snapshot-types.js"
import { canonicalJson } from "./context-snapshot-json.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"

export { canonicalJson } from "./context-snapshot-json.js"

export function snapshotCanonicalJson(snapshot: Pick<AgentContextSnapshot, "sessionId" | "throughSequence" | "version" | "content">): string {
  return canonicalJson({
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    sessionId: snapshot.sessionId,
    throughSequence: snapshot.throughSequence,
    version: snapshot.version,
    content: snapshot.content,
  })
}

export function snapshotChecksum(snapshot: Pick<AgentContextSnapshot, "sessionId" | "throughSequence" | "version" | "content">): string {
  return createHash("sha256").update(snapshotCanonicalJson(snapshot), "utf8").digest("hex")
}

export function parseSnapshotContent(value: unknown): ContextSnapshotContent {
  return validateSnapshotContent(value)
}

export function assertSnapshotIntegrity(snapshot: AgentContextSnapshot): void {
  if (snapshot.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION || snapshot.content.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    throw new ContextSnapshotError("checksum_mismatch", "Unsupported context snapshot schema version")
  }
  try {
    validateSnapshotContent(snapshot.content)
  } catch (error: unknown) {
    if (error instanceof ContextSnapshotError && error.code === "checksum_mismatch") throw error
    throw new ContextSnapshotError("checksum_mismatch", "Context snapshot content validation failed")
  }
  if (snapshot.content.sessionId !== snapshot.sessionId || snapshot.content.throughSequence !== snapshot.throughSequence.toString()) {
    throw new ContextSnapshotError("checksum_mismatch", "Snapshot identity does not match its content")
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || typeof snapshot.throughSequence !== "bigint" || snapshot.throughSequence < 0n) {
    throw new ContextSnapshotError("checksum_mismatch", "Snapshot version or sequence is invalid")
  }
  if (typeof snapshot.summary !== "string" || snapshot.summary.trim().length === 0 || typeof snapshot.memorySummary !== "string" || snapshot.summary !== snapshot.memorySummary) {
    throw new ContextSnapshotError("checksum_mismatch", "Snapshot summary projection is invalid")
  }
  const expectedAccounting = snapshot.content.tokenAccounting
  if (canonicalJson(expectedAccounting) !== canonicalJson(snapshot.tokenAccounting)
    || snapshot.inputTokens !== expectedAccounting.totalInputTokens
    || snapshot.outputTokens !== expectedAccounting.totalOutputTokens
    || typeof snapshot.estimatedCostUsd !== "number"
    || !Number.isFinite(snapshot.estimatedCostUsd)
    || snapshot.estimatedCostUsd < 0
    || Number(snapshot.estimatedCostUsd.toFixed(8)) !== expectedAccounting.totalCostUsd) {
    throw new ContextSnapshotError("checksum_mismatch", "Snapshot token accounting is inconsistent")
  }
  const expectedCanonical = snapshotCanonicalJson(snapshot)
  if (snapshot.canonicalJson !== expectedCanonical) throw new ContextSnapshotError("checksum_mismatch", "Context snapshot canonical JSON mismatch")
  if (!/^[0-9a-f]{64}$/.test(snapshot.checksum) || snapshotChecksum(snapshot) !== snapshot.checksum) throw new ContextSnapshotError("checksum_mismatch", "Context snapshot checksum mismatch")
}
