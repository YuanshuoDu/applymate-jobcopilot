import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { sha256Hex } from "./context-compaction-canonical.js"
import { snapshotCanonicalJson, snapshotChecksum } from "./context-snapshot-canonical.js"
import { AgentContextSnapshotBuilder } from "./context-snapshot-builder.js"
import { rebuildStepFromSnapshot } from "./context-snapshot-rebuild.js"
import type { ContextSnapshotSourceData } from "./context-snapshot-types.js"
import { buildModelRequest } from "../turns/turn-engine-messages.js"

const scope: TenantScope = { userId: "user-a" }

async function makeSnapshot(ownerId = "user-a", includeReference = true) {
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

  it("rebuilds persisted working state into the next captured HarnessModelRequest", async () => {
    const base = await makeSnapshot("user-a", false)
    const state = {
      ownerId: "user-a", sessionId: "session-a", throughSequence: "4", goal: "Current compacted goal", userConstraints: ["Keep Dublin"],
      approvals: [{ id: "approval-1", status: "pending" }],
      answers: [{ id: "answer-1", question: "Work permit?", answer: "User confirmed" }],
      artifacts: [{ id: "artifact-1", type: "resume", hash: "sha256:resume" }],
      openTasks: [{ taskId: "task-1", status: "running", blocker: null }], doNotRepeat: ["repeat this rejected path"],
      facts: [{ factId: "fact-1", key: "target_role", source: "persona_fact:fact-1" }],
    }
    const narrativeSummary = "Only a short goal summary"
    const tokenMeasurement = { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }
    const sourceItemIds = ["item-1"]
    const itemId = "compaction-1"
    const compaction = { itemId, digest: sha256Hex({ state, summary: narrativeSummary, measurement: tokenMeasurement, sourceItemIds, itemId }), state, narrativeSummary, tokenMeasurement, sourceItemIds }
    const content = { ...base.content, compaction }
    const withMemory = { ...base, content }
    const snapshot = { ...withMemory, checksum: snapshotChecksum(withMemory), canonicalJson: snapshotCanonicalJson(withMemory) }
    const step = await rebuildStepFromSnapshot(snapshot, { scope, turnId: "turn-a", stepId: "step-a" })
    const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({ context: step, model, tools: [], sessionId: "session-a", turnId: "turn-a", stepId: "step-a", userId: "user-a", taskId: "root-a", signal: new AbortController().signal })
    const requestText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    expect(requestText).toContain("context_snapshot_working_state")
    expect(requestText).toContain("Current compacted goal")
    expect(requestText).toContain("UNTRUSTED_DATA")
    expect(requestText).toContain('"evidenceBodiesIncluded":false')
  })
})
