import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { AgentContextSnapshotBuilder } from "./context-snapshot-builder.js"
import { rebuildStepFromSnapshot } from "./context-snapshot-rebuild.js"
import type { ContextSnapshotSourceData } from "./context-snapshot-types.js"

const scope: TenantScope = { userId: "user-a" }

async function makeSnapshot(ownerId = "user-a", includeReference = true, overrides: Partial<ContextSnapshotSourceData> = {}) {
  const source: ContextSnapshotSourceData = {
    goal: "Rebuild this step",
    userConstraints: [],
    confirmedDecisions: [],
    completedWork: [],
    openWork: [],
    pendingApprovals: [],
    artifacts: [],
    facts: [],
    failedAttempts: [],
    references: ownerId === "user-a" && includeReference ? [{ id: "job-1", kind: "job", ownerId, source: "jobs" }] : [],
    tokenUsage: [],
    context: {
      system: [{ id: "system-1", content: { safe: true } }],
      profile: [{ id: "profile-1", content: { role: "engineer" } }],
      goal: { id: "goal-1", content: "Rebuild this step" },
      steerHistory: [{ id: "history-1", content: "Keep Dublin" }],
      toolObservations: [{ id: "tool-1", content: { status: "ready" } }],
    },
    ...overrides,
  }
  return new AgentContextSnapshotBuilder(
    { load: vi.fn(async () => source) },
    { verify: vi.fn(async (reference) => ({ ...reference, verified: true as const })) },
  ).build({ scope: { userId: ownerId }, sessionId: "session-a", throughSequence: 4n, version: 1 })
}

describe("context snapshot Step rebuild", () => {
  it("rebuilds the same Step context and cursor deterministically", async () => {
    const snapshot = await makeSnapshot()
    const first = await rebuildStepFromSnapshot(snapshot, { scope, turnId: "turn-a", stepId: "step-a" })
    const second = await rebuildStepFromSnapshot(snapshot, { scope, turnId: "turn-a", stepId: "step-a" })
    expect(first).toEqual(second)
    expect(first.inputThroughSequence).toBe(4n)
    expect(first.blocks.map((block) => block.id)).toEqual(["system:system-1", "profile:profile-1", "goal:goal-1", "history:history-1", "business:job:job-1", "observation:tool-1"])
  })

  it("rejects tampered checksums and references outside the rebuild tenant", async () => {
    const snapshot = await makeSnapshot()
    await expect(rebuildStepFromSnapshot({ ...snapshot, checksum: "0".repeat(64) }, { scope, turnId: "turn-a", stepId: "step-a" })).rejects.toMatchObject({ code: "checksum_mismatch" })
    await expect(rebuildStepFromSnapshot(snapshot, { scope: { userId: "user-b" }, turnId: "turn-a", stepId: "step-a" })).rejects.toMatchObject({ code: "reference_cross_tenant" })
  })

  it("rejects an owner mismatch even when the snapshot has no references", async () => {
    const snapshot = await makeSnapshot("user-a", false)
    await expect(rebuildStepFromSnapshot(snapshot, { scope: { userId: "user-b" }, turnId: "turn-a", stepId: "step-a" })).rejects.toMatchObject({ code: "reference_cross_tenant" })
  })

  it("rehydrates canonical memory that is not duplicated in context seeds", async () => {
    const snapshot = await makeSnapshot("user-a", false, {
      userConstraints: ["EU only"],
      confirmedDecisions: [{ id: "decision-1", decision: "Review before submit", evidenceEventIds: ["event-1"] }],
      completedWork: [{ taskId: "task-done", resultRef: "result-1", summary: "Scouted roles" }],
      openWork: [{ taskId: "task-open", status: "waiting", blocker: "approval" }],
      pendingApprovals: ["approval-1"],
      artifacts: [{ id: "artifact-1", type: "resume", hash: "hash-1" }],
      facts: [{ factId: "fact-1", key: "location", source: "user-confirmed" }],
      failedAttempts: [{ taskId: "task-failed", reason: "provider timeout", doNotRepeat: ["same request"] }],
      context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
    })
    const rebuilt = await rebuildStepFromSnapshot(snapshot, { scope, turnId: "turn-a", stepId: "step-a" })
    const memory = rebuilt.blocks.find((block) => block.id === "observation:context-snapshot-memory")

    expect(memory).toMatchObject({
      layer: "tool_observation",
      role: "data",
      trust: "external_untrusted",
      content: {
        kind: "context_snapshot_memory",
        goal: "Rebuild this step",
        userConstraints: ["EU only"],
        pendingApprovals: ["approval-1"],
        openWork: [{ taskId: "task-open", status: "waiting", blocker: "approval" }],
        confirmedDecisions: [{ id: "decision-1", evidenceEventIds: ["event-1"] }],
        artifacts: [{ id: "artifact-1", hash: "hash-1" }],
      },
    })
    expect(rebuilt).toEqual(await rebuildStepFromSnapshot(snapshot, { scope, turnId: "turn-a", stepId: "step-a" }))
  })
})
