import { describe, expect, it } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { sha256Hex } from "./context-compaction-canonical.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"
import { ContextSnapshotError, type ContextSnapshotCompactionState } from "./context-snapshot-types.js"
import { stepContextSnapshotFromContent } from "./context-snapshot-working-state.js"
import { StepContextBuilder, type StepContextSnapshot } from "./step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "./input-claim-store.js"
import { buildModelRequest } from "../turns/turn-engine-messages.js"

const scope: TenantScope = { userId: "user-a" }
const measurement = { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }
const sourceItemIds = ["item-1"]

function extension(state: ContextSnapshotCompactionState, summary = "The narrative omits structured state") {
  const itemId = "compaction-1"
  return {
    itemId,
    digest: sha256Hex({ state, summary, measurement, sourceItemIds, itemId }),
    state,
    narrativeSummary: summary,
    tokenMeasurement: measurement,
    sourceItemIds,
  }
}

function state(overrides: Partial<ContextSnapshotCompactionState> = {}): ContextSnapshotCompactionState {
  return {
    ownerId: "user-a", sessionId: "session-a", throughSequence: "7", goal: "Search EU roles",
    userConstraints: ["Dublin only"],
    approvals: [{ id: "approval-1", status: "pending", scopeHash: "scope-hash", answersHash: "answers-hash" }],
    answers: [{ id: "answer-1", question: "Work authorization?", answer: "Confirmed by user", answerHash: "answer-hash" }],
    artifacts: [{ id: "artifact-current", type: "resume", hash: "sha256:current" }],
    openTasks: [{ taskId: "task-open", status: "running", blocker: null }],
    doNotRepeat: ["retrying the rejected path"],
    facts: [{ factId: "fact-1", key: "target_role", source: "persona_fact:fact-1" }],
    ...overrides,
  }
}

function content(overrides: Record<string, unknown> = {}) {
  return validateSnapshotContent({
    schemaVersion: "agent-harness.context.v1", ownerId: "user-a", sessionId: "session-a", throughSequence: "7", goal: "Legacy goal",
    userConstraints: ["legacy constraint"],
    confirmedDecisions: [{ id: "decision-1", decision: "Use the user-selected location", evidenceEventIds: ["event-17"], sequence: "1" }],
    completedWork: [{ taskId: "task-done", resultRef: "result:resume:42", summary: "Resume update finished", sequence: "2" }],
    openWork: [{ taskId: "stale-task", status: "blocked", blocker: "old blocker" }],
    pendingApprovals: ["legacy-approval"],
    artifacts: [{ id: "artifact-stale", type: "resume", hash: "sha256:old" }],
    facts: [{ factId: "fact-stale", key: "location", source: "old-source" }],
    failedAttempts: [{ taskId: "task-failed", reason: "The form rejected this path", doNotRepeat: ["repeat rejected path"], sequence: "3" }],
    references: [], consumedInputIds: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "summary", content: { summary: "Only the goal is summarized" } }] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    compaction: extension(state()),
    ...overrides,
  })
}

function emptyInputStore(): InputClaimStore {
  return {
    scope,
    async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
      return work({
        getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
        persistCheckpoint: async () => undefined,
      })
    },
  }
}

async function requestFor(snapshot: StepContextSnapshot) {
  const context = await new StepContextBuilder(emptyInputStore()).build({
    scope, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", snapshot, now: new Date(0),
  })
  const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
  return buildModelRequest({ context, model, tools: [], sessionId: "session-a", turnId: "turn-a", stepId: "step-a", userId: "user-a", taskId: "root-a", signal: new AbortController().signal })
}

describe("durable context snapshot working state", () => {
  it("hydrates authoritative structured state into the captured HarnessModelRequest as low-trust data", async () => {
    const loaded = content()
    const request = await requestFor(stepContextSnapshotFromContent(loaded))
    const memoryMessage = request.messages.find(message => message.role === "user" && message.content.some(part => part.type === "text" && part.text.includes("context_snapshot_working_state")))
    expect(memoryMessage?.role).toBe("user")
    const memoryText = memoryMessage?.content.map(part => part.type === "text" ? part.text : "").join("\n") ?? ""
    expect(memoryText).toContain("UNTRUSTED_DATA")
    for (const value of ["event-17", "result:resume:42", "Confirmed by user", "task-open", "Dublin only", "pending", "sha256:current", "The form rejected this path", "retrying the rejected path", "persona_fact:fact-1"]) {
      expect(memoryText).toContain(value)
    }
    expect(memoryText).toContain('"grantsActionAuthority":false')
    expect(memoryText).toContain('"factValuesIncluded":false')
    expect(memoryText).not.toContain("The narrative omits structured state")
    expect(memoryText).not.toContain('"value":"')
    expect(memoryText).not.toContain('"body":"')
  })

  it("uses compaction state over stale legacy copies and remains deterministic", () => {
    const loaded = content()
    const first = stepContextSnapshotFromContent(loaded)
    const second = stepContextSnapshotFromContent(loaded)
    const memory = first.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(second).toEqual(first)
    expect(memory).toMatchObject({ kind: "durable_context_snapshot", status: "available", goal: "Search EU roles", userConstraints: ["Dublin only"], openWork: [{ taskId: "task-open", status: "running" }] })
    expect(memory).not.toHaveProperty("omissions")
    expect(memory).toMatchObject({
      legacySnapshotFields: {
        freshness: "may_be_stale_after_compaction",
        confirmedDecisions: [{ evidenceEventIds: ["event-17"] }],
        completedWork: [{ resultRef: "result:resume:42" }],
      },
    })
    expect(memory).toMatchObject({ artifacts: [{ hash: "sha256:current" }], facts: [{ factId: "fact-1", key: "target_role", source: "persona_fact:fact-1" }] })
    expect(memory).not.toHaveProperty("narrativeSummary")
    expect(memory).not.toHaveProperty("factValues")
  })

  it("keeps the latest state authoritative across repeated compactions", () => {
    const newerState = state({
      throughSequence: "8", goal: "Continue with Amsterdam roles", userConstraints: ["Amsterdam only"],
      openTasks: [{ taskId: "task-next", status: "waiting", blocker: "Awaiting employer reply" }],
      doNotRepeat: ["do not resubmit the rejected form"],
      artifacts: [{ id: "artifact-next", type: "cover_letter", hash: "sha256:next" }],
    })
    const compactedAgain = content({ throughSequence: "8", compaction: extension(newerState, "Only the new goal is summarized") })
    const first = stepContextSnapshotFromContent(compactedAgain)
    const second = stepContextSnapshotFromContent(compactedAgain)
    const memory = first.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(second).toEqual(first)
    expect(memory).toMatchObject({
      goal: "Continue with Amsterdam roles", userConstraints: ["Amsterdam only"],
      openWork: [{ taskId: "task-next", status: "waiting", blocker: "Awaiting employer reply" }],
      doNotRepeat: ["do not resubmit the rejected form"], artifacts: [{ hash: "sha256:next" }],
    })
    expect(memory).not.toMatchObject({ goal: "Legacy goal", userConstraints: ["legacy constraint"] })
  })

  it("rejects tampered, cross-owner, malformed, and unordered compaction state", () => {
    const valid = content()
    const tampered = { ...valid, compaction: { ...valid.compaction!, state: { ...valid.compaction!.state, goal: "Changed after persistence" } } }
    expect(() => validateSnapshotContent(tampered)).toThrow("digest mismatch")
    const foreignState = state({ ownerId: "user-b" })
    expect(() => content({ compaction: extension(foreignState) })).toThrow("owner or session")
    const malformed = { ...valid, compaction: { ...valid.compaction!, state: { ...valid.compaction!.state, approvals: [{ id: "approval-1", status: "pending", actionAuthority: true }] } } }
    expect(() => validateSnapshotContent(malformed)).toThrow("unsupported field")
    const unordered = { ...valid, compaction: extension(state({ userConstraints: ["Dublin", "Berlin"] })) }
    expect(() => validateSnapshotContent(unordered)).toThrow("sorted uniquely")
  })

  it("fails closed before building a model request when a verified reference belongs to another owner", async () => {
    const foreign = content({ references: [{ id: "private-artifact", kind: "artifact", ownerId: "user-b", source: "snapshot", verified: true }] })
    await expect(requestFor(stepContextSnapshotFromContent(foreign))).rejects.toMatchObject({ code: "reference_owner_mismatch" })
  })

  it("keeps an exact fitting goal when protected answers still exceed the projection bound", () => {
    const answers = Array.from({ length: 24 }, (_, index) => ({
      id: `answer-${index.toString().padStart(2, "0")}`, question: "Question", answer: "x".repeat(1000), answerHash: `hash-${index}`,
    }))
    const compacted = content({ compaction: extension(state({ answers })), completedWork: [] })
    const snapshot = stepContextSnapshotFromContent(compacted)
    const projected = snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({ status: "unavailable", reason: "projection_limit_exceeded", authority: "informational_only" })
    expect(projected).not.toHaveProperty("answers")
    expect(snapshot.goal).toEqual({ id: "snapshot-goal", content: "Search EU roles" })
  })

  it("drops only whole completed-work rows for a bounded compacted partial projection", async () => {
    const completedWork = Array.from({ length: 10 }, (_, index) => ({
      taskId: `task-done-${index.toString().padStart(2, "0")}`, resultRef: `result-${index}`, summary: "x".repeat(2000), sequence: String(index + 2),
    }))
    const compacted = content({
      completedWork,
      context: { ...content().context, goal: { id: "current-goal", content: "Stale context goal" } },
    })
    const original = JSON.stringify(compacted)
    const snapshot = stepContextSnapshotFromContent(compacted)
    const projected = snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({
      status: "partial", authority: "informational_only", goal: "Search EU roles", userConstraints: ["Dublin only"],
      answers: compacted.compaction?.state.answers,
      openWork: compacted.compaction?.state.openTasks,
      legacySnapshotFields: {
        freshness: "may_be_stale_after_compaction",
        confirmedDecisions: compacted.confirmedDecisions,
        failedAttempts: compacted.failedAttempts,
      },
      approvalState: {
        source: "compaction_state", entries: compacted.compaction?.state.approvals,
        freshness: "compaction_state", grantsActionAuthority: false,
      },
      artifacts: compacted.compaction?.state.artifacts,
      doNotRepeat: compacted.compaction?.state.doNotRepeat,
      facts: compacted.compaction?.state.facts,
      omissions: [{ field: "legacySnapshotFields.completedWork", count: 10 }],
    })
    expect(projected.legacySnapshotFields).not.toHaveProperty("completedWork")
    expect(projected).not.toHaveProperty("actionAuthority")
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(16_000)
    expect(snapshot.goal).toEqual({ id: "current-goal", content: "Search EU roles" })
    expect(JSON.stringify(compacted)).toBe(original)
    const request = await requestFor(snapshot)
    expect(request.messages.some(message => message.content.some(part => part.type === "text" && part.text.includes("Search EU roles")))).toBe(true)
  })

  it("drops only whole completed-work rows for a bounded legacy partial projection", () => {
    const completedWork = Array.from({ length: 10 }, (_, index) => ({
      taskId: `task-done-${index.toString().padStart(2, "0")}`, resultRef: `result-${index}`, summary: "x".repeat(2000), sequence: String(index + 2),
    }))
    const legacy = content({ compaction: undefined, completedWork })
    const original = JSON.stringify(legacy)
    const snapshot = stepContextSnapshotFromContent(legacy)
    const projected = snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({
      status: "partial", authority: "informational_only", goal: "Legacy goal", userConstraints: ["legacy constraint"],
      legacySnapshotFields: {
        freshness: "snapshot_scoped", confirmedDecisions: legacy.confirmedDecisions, failedAttempts: legacy.failedAttempts,
      }, omissions: [{ field: "legacySnapshotFields.completedWork", count: 10 }],
    })
    expect(projected.legacySnapshotFields).not.toHaveProperty("completedWork")
    expect(projected.openWork).toEqual(legacy.openWork)
    expect(projected.approvalState).toMatchObject({ entries: legacy.pendingApprovals, freshness: "snapshot_scoped", grantsActionAuthority: false })
    expect(projected.artifacts).toEqual(legacy.artifacts)
    expect(projected.facts).toEqual(legacy.facts)
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(16_000)
    expect(snapshot.goal).toEqual({ id: "snapshot-goal", content: "Legacy goal" })
    expect(JSON.stringify(legacy)).toBe(original)
  })

  it("preserves the exact selected goal at the model-memory boundary and rejects an over-cap selected goal", () => {
    const boundaryGoal = "g".repeat(15_998)
    const compacted = content({
      compaction: extension(state({ goal: boundaryGoal })),
      context: { ...content().context, goal: { id: "current-goal", content: "Stale context goal" } },
    })
    const snapshot = stepContextSnapshotFromContent(compacted)
    expect(snapshot.goal).toEqual({ id: "current-goal", content: boundaryGoal })

    const oversized = content({
      compaction: undefined,
      context: { ...content().context, goal: { id: "current-goal", content: "g".repeat(15_999) } },
      goal: "Short stale legacy goal",
    })
    expect(() => stepContextSnapshotFromContent(oversized)).toThrow(ContextSnapshotError)
    expect(() => stepContextSnapshotFromContent(oversized)).toThrow("Selected model goal exceeds the projection limit")
  })

  it("keeps large valid persisted state loadable and marks only its model projection unavailable", () => {
    const answers = Array.from({ length: 132 }, (_, index) => ({
      id: `answer-${index.toString().padStart(3, "0")}`, question: "Question", answer: "x".repeat(5000), answerHash: `hash-${index}`,
    }))
    const compacted = content({ compaction: extension(state({ answers })) })
    expect(compacted.compaction?.state.answers).toHaveLength(132)
    const snapshot = stepContextSnapshotFromContent(compacted)
    const projected = snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({ status: "unavailable", reason: "projection_limit_exceeded", authority: "informational_only" })
    expect(projected).not.toHaveProperty("answers")
    expect(snapshot.goal).toEqual({ id: "snapshot-goal", content: "Search EU roles" })
  })

  it("preserves the ordinary legacy goal when a legacy memory projection is over budget", () => {
    const legacy = content({
      compaction: undefined,
      failedAttempts: [{ taskId: "task-failed", reason: "x".repeat(17_000), doNotRepeat: ["retrying the rejected path"], sequence: "3" }],
    })
    const snapshot = stepContextSnapshotFromContent(legacy)
    expect(snapshot.goal).toEqual({ id: "snapshot-goal", content: "Legacy goal" })
    expect(snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content)
      .toMatchObject({ status: "unavailable", reason: "projection_limit_exceeded" })
  })
})
