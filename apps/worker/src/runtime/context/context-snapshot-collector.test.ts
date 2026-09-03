import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { collectContextSnapshot } from "./context-snapshot-collector.js"
import type { ContextSnapshotReference, ContextSnapshotSourceData, VerifiedContextReferencePort } from "./context-snapshot-types.js"

const scope: TenantScope = { userId: "user-a" }

function source(overrides: Partial<ContextSnapshotSourceData> = {}): ContextSnapshotSourceData {
  return {
    goal: "Find a role",
    userConstraints: ["Berlin", "backend"],
    confirmedDecisions: [{ id: "decision-1", decision: "approval required", evidenceEventIds: ["event-2", "event-1"], sequence: 2n }],
    completedWork: [{ taskId: "task-1", resultRef: "artifact-1", summary: "scouted", sequence: 1n }],
    openWork: [],
    pendingApprovals: [],
    artifacts: [],
    facts: [],
    failedAttempts: [],
    references: [],
    tokenUsage: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
    ...overrides,
  }
}

const verifier: VerifiedContextReferencePort = {
  verify: vi.fn(async (reference) => ({ ...reference, verified: true as const })),
}

describe("context snapshot collector", () => {
  it("normalizes source ordering deterministically and keeps only verified refs", async () => {
    const references: ContextSnapshotReference[] = [{ id: "job-2", kind: "job", ownerId: "user-a", source: "jobs" }, { id: "job-1", kind: "job", ownerId: "user-a", source: "jobs" }]
    const first = await collectContextSnapshot({ scope, sessionId: "session-a", throughSequence: 4n, source: source({ references }), references: verifier })
    const second = await collectContextSnapshot({ scope, sessionId: "session-a", throughSequence: 4n, source: source({ references: [...references].reverse() }), references: verifier })
    expect(first.content).toEqual(second.content)
    expect(first.content.references.every((reference) => reference.verified)).toBe(true)
    expect(first.content.confirmedDecisions[0]?.evidenceEventIds).toEqual(["event-1", "event-2"])
    expect(first.content.ownerId).toBe("user-a")
  })

  it("rejects cross-tenant, missing, and unverified references before collection", async () => {
    const crossTenant = { id: "job-1", kind: "job" as const, ownerId: "user-b", source: "jobs" }
    await expect(collectContextSnapshot({ scope, sessionId: "session-a", throughSequence: 1n, source: source({ references: [crossTenant] }), references: verifier })).rejects.toMatchObject({ code: "reference_cross_tenant" })
    const missing: VerifiedContextReferencePort = { verify: vi.fn(async () => null) }
    await expect(collectContextSnapshot({ scope, sessionId: "session-a", throughSequence: 1n, source: source({ references: [{ ...crossTenant, ownerId: "user-a" }] }), references: missing })).rejects.toMatchObject({ code: "reference_missing" })
    const unverified: VerifiedContextReferencePort = { verify: vi.fn(async (reference) => ({ ...reference, verified: false as const })) }
    await expect(collectContextSnapshot({ scope, sessionId: "session-a", throughSequence: 1n, source: source({ references: [{ ...crossTenant, ownerId: "user-a" }] }), references: unverified })).rejects.toMatchObject({ code: "reference_unverified" })
  })
})
