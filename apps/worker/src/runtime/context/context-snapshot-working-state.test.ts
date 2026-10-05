import { describe, expect, it } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { sha256Hex } from "./context-compaction-canonical.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"
import type { ContextSnapshotCompactionState } from "./context-snapshot-types.js"
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
    expect(memory).toMatchObject({ goal: "Search EU roles", userConstraints: ["Dublin only"], openWork: [{ taskId: "task-open", status: "running" }] })
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

  it("marks an over-budget projection unavailable instead of truncating evidence", () => {
    const answers = Array.from({ length: 24 }, (_, index) => ({
      id: `answer-${index.toString().padStart(2, "0")}`, question: "Question", answer: "x".repeat(1000), answerHash: `hash-${index}`,
    }))
    const compacted = content({ compaction: extension(state({ answers })) })
    const snapshot = stepContextSnapshotFromContent(compacted)
    const projected = snapshot.toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({ status: "unavailable", reason: "projection_limit_exceeded", authority: "informational_only" })
    expect(projected).not.toHaveProperty("answers")
    expect(snapshot.goal?.content).toBe("Durable context snapshot unavailable (projection limit exceeded).")
  })

  it("keeps large valid persisted state loadable and marks only its model projection unavailable", () => {
    const answers = Array.from({ length: 132 }, (_, index) => ({
      id: `answer-${index.toString().padStart(3, "0")}`, question: "Question", answer: "x".repeat(5000), answerHash: `hash-${index}`,
    }))
    const compacted = content({ compaction: extension(state({ answers })) })
    expect(compacted.compaction?.state.answers).toHaveLength(132)
    const projected = stepContextSnapshotFromContent(compacted).toolObservations.find(item => item.id.startsWith("snapshot-working-state:"))?.content as Record<string, unknown>
    expect(projected).toMatchObject({ status: "unavailable", reason: "projection_limit_exceeded", authority: "informational_only" })
    expect(projected).not.toHaveProperty("answers")
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
