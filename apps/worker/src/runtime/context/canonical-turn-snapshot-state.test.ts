import { describe, expect, it } from "vitest"

import { restoreCanonicalTurnSnapshot } from "./canonical-turn-snapshot-state.js"

const scope = { userId: "user-1" }

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.context.v1",
    ownerId: "user-1", sessionId: "session-1", throughSequence: "7", goal: "Find roles",
    userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [],
    artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    ...overrides,
  }
}

describe("restoreCanonicalTurnSnapshot", () => {
  it("restores a validated snapshot into canonical Step context", () => {
    expect(restoreCanonicalTurnSnapshot(snapshot(), "7", scope, "session-1")).toEqual({
      snapshot: {
        system: [], profile: [], goal: { id: "snapshot-goal", content: "Find roles" },
        steerHistory: [], businessRefs: [], toolObservations: [],
      },
    })
  })

  it("fails closed for a foreign owner or session", () => {
    expect(() => restoreCanonicalTurnSnapshot(snapshot({ ownerId: "other-user" }), "7", scope, "session-1"))
      .toThrow("context_snapshot_scope_mismatch")
    expect(() => restoreCanonicalTurnSnapshot(snapshot({ sessionId: "other-session" }), "7", scope, "session-1"))
      .toThrow("context_snapshot_scope_mismatch")
  })

  it("fails closed when the snapshot cursor differs from the database cursor", () => {
    expect(() => restoreCanonicalTurnSnapshot(snapshot(), "8", scope, "session-1"))
      .toThrow("context_snapshot_sequence_mismatch")
  })
})
