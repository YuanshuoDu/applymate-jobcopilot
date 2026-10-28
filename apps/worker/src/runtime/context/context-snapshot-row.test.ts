import { describe, expect, it } from "vitest"

import { snapshotCanonicalJson, snapshotChecksum } from "./context-snapshot-canonical.js"
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, ContextSnapshotError } from "./context-snapshot-types.js"
import { mapContextSnapshotRow, type ContextSnapshotRow } from "./context-snapshot-row.js"

function row(): ContextSnapshotRow {
  const content = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId: "user-a",
    sessionId: "session-a",
    throughSequence: "7",
    goal: "Find roles",
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
    context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "tool-1", content: "Original summary" }] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
  }
  const base = { sessionId: "session-a", throughSequence: 7n, version: 1, content }
  return {
    id: "snapshot-1",
    sessionId: base.sessionId,
    throughSequence: "7",
    version: base.version,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    content,
    summary: "Goal: Find roles",
    checksum: snapshotChecksum(base),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: "0.00000000",
    tokenAccounting: content.tokenAccounting,
    createdAt: new Date("2026-10-27T00:00:00.000Z"),
  }
}

describe("context snapshot row mapper", () => {
  it("validates and maps a legacy v1 row without optional compaction metadata", () => {
    const value = mapContextSnapshotRow(row())

    expect(value.content.compaction).toBeUndefined()
    expect(value.throughSequence).toBe(7n)
    expect(value.canonicalJson).toBe(snapshotCanonicalJson({
      sessionId: value.sessionId, throughSequence: value.throughSequence, version: value.version, content: value.content,
    }))
  })

  it("rejects tool observation changes against the persisted checksum without leaking row values", () => {
    const valid = row()
    const alteredContent = {
      ...(valid.content as Record<string, unknown>),
      context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "tool-1", content: "CORRUPTED SUMMARY" }] },
    }
    let caught: unknown
    try {
      mapContextSnapshotRow({ ...valid, content: alteredContent })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ContextSnapshotError)
    expect(caught).toMatchObject({ code: "checksum_mismatch" })
    const message = caught instanceof Error ? caught.message : ""
    expect(message).not.toContain("CORRUPTED SUMMARY")
    expect(message).not.toContain(valid.checksum as string)
    expect(message).not.toContain("api_key=")
  })
})
