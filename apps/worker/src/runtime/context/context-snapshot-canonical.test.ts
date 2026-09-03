import { describe, expect, it } from "vitest"

import {
  assertSnapshotIntegrity,
  snapshotCanonicalJson,
  snapshotChecksum,
} from "./context-snapshot-canonical.js"
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, type AgentContextSnapshot } from "./context-snapshot-types.js"

const content = {
  schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ownerId: "user-a",
  sessionId: "session-a",
  throughSequence: "2",
  goal: "Find a role",
  userConstraints: [],
  confirmedDecisions: [],
  completedWork: [],
  openWork: [],
  pendingApprovals: [],
  artifacts: [],
  facts: [],
  failedAttempts: [],
  references: [],
  consumedInputIds: [],
  context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
  tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
} as const

function snapshot(): AgentContextSnapshot {
  const base = { sessionId: "session-a", throughSequence: 2n, version: 1, content }
  const canonicalJson = snapshotCanonicalJson(base)
  return {
    ...base,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    summary: "Goal: Find a role",
    memorySummary: "Goal: Find a role",
    checksum: snapshotChecksum(base),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    tokenAccounting: content.tokenAccounting,
    canonicalJson,
  }
}

describe("context snapshot checksum", () => {
  it("produces a stable golden canonical payload and checksum", () => {
    const value = snapshot()
    expect(value.canonicalJson).toBe(snapshotCanonicalJson(value))
    expect(value.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(() => assertSnapshotIntegrity(value)).not.toThrow()
  })

  it("fails closed when content or checksum is altered", () => {
    const value = snapshot()
    expect(() => assertSnapshotIntegrity({ ...value, checksum: "0".repeat(64) })).toThrow("checksum")
    expect(() => assertSnapshotIntegrity({ ...value, content: { ...value.content, goal: "changed" } })).toThrow("canonical JSON")
  })
})
