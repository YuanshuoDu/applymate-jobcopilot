import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { AgentContextSnapshotBuilder } from "./context-snapshot-builder.js"
import type { ContextSnapshotSourceData, ContextSnapshotSourcePort, ContextSnapshotStorePort, VerifiedContextReferencePort } from "./context-snapshot-types.js"

const scope: TenantScope = { userId: "user-a" }
const sourceData: ContextSnapshotSourceData = {
  goal: "Find senior backend roles",
  userConstraints: ["Dublin"],
  confirmedDecisions: [],
  completedWork: [{ taskId: "task-1", resultRef: "result-1", summary: "completed" }],
  openWork: [{ taskId: "task-2", status: "waiting", blocker: "approval" }],
  pendingApprovals: ["approval-1"],
  artifacts: [],
  facts: [],
  failedAttempts: [],
  references: [],
  tokenUsage: [{ provider: "minimax", model: "M3", profileId: "default", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.00123456789 }],
  context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
}

describe("AgentContextSnapshotBuilder", () => {
  it("builds identical snapshots for the same session cursor", async () => {
    const source: ContextSnapshotSourcePort = { load: vi.fn(async () => ({ ...sourceData, userConstraints: [...sourceData.userConstraints].reverse() })) }
    const references: VerifiedContextReferencePort = { verify: vi.fn(async (reference) => ({ ...reference, verified: true as const })) }
    const builder = new AgentContextSnapshotBuilder(source, references)
    const first = await builder.build({ scope, sessionId: "session-a", throughSequence: 8n, version: 1 })
    const second = await builder.build({ scope, sessionId: "session-a", throughSequence: 8n, version: 1 })
    expect(first.canonicalJson).toBe(second.canonicalJson)
    expect(first.checksum).toBe(second.checksum)
    expect(first.memorySummary).toContain("Completed: 1")
    expect(first.memorySummary).toContain("Estimated cost: $0.00123457")
  })

  it("fails when the source is unavailable and requires a store for persistence", async () => {
    const source: ContextSnapshotSourcePort = { load: vi.fn(async () => null) }
    const references: VerifiedContextReferencePort = { verify: vi.fn(async (reference) => ({ ...reference, verified: true as const })) }
    const builder = new AgentContextSnapshotBuilder(source, references)
    await expect(builder.build({ scope, sessionId: "session-a", throughSequence: 1n, version: 1 })).rejects.toMatchObject({ code: "source_missing" })
    const available = new AgentContextSnapshotBuilder({ load: vi.fn(async () => sourceData) }, references)
    await expect(available.buildAndPersist({ scope, sessionId: "session-a", throughSequence: 1n, version: 1 })).rejects.toMatchObject({ code: "invalid_input" })
    const store: ContextSnapshotStorePort = { save: vi.fn(async (snapshot) => snapshot), load: vi.fn(async () => null) }
    await expect(new AgentContextSnapshotBuilder({ load: vi.fn(async () => sourceData) }, references, store).buildAndPersist({ scope, sessionId: "session-a", throughSequence: 1n, version: 1 })).resolves.toMatchObject({ checksum: expect.any(String) })
  })

  it("redacts direct contact data from the memory summary projection", async () => {
    const source = { ...sourceData, goal: "Contact candidate@example.com" }
    const snapshot = await new AgentContextSnapshotBuilder(
      { load: vi.fn(async () => source) },
      { verify: vi.fn(async (reference) => ({ ...reference, verified: true as const })) },
    ).build({ scope, sessionId: "session-a", throughSequence: 1n, version: 1 })
    expect(snapshot.memorySummary).not.toContain("candidate@example.com")
    expect(snapshot.memorySummary).toContain("[REDACTED_EMAIL]")
  })
})
