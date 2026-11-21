import { describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"
import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"
import type { TurnExecutionOwnerFence } from "./execution-owner.js"
import type { TurnEngineOptions, TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import type { TurnLease } from "./turns/lease.js"
import { runCanonicalReviewedApplicationReviewTurn } from "./canonical-reviewed-application-review-turn.js"

const NOW = new Date("2026-11-21T10:00:00.000Z")
const USER = "user-review", SESSION = "session-review", TURN = "turn-review", ROOT = "root-review"
const SOURCE = "source-turn", JOB = "job-review", APP = "application-review"
const APPROVAL = `reviewed-application-review:${TURN}`, WAIT_ITEM = `agent-wait:approval:${APPROVAL}`
const TOOL_CALL = `review_application:${TURN}`, ROOT_INPUT = "root-input-review"
const ROOT_INPUT_SEQUENCE = 22n, TERMINAL_STEP = `reviewed-application-review:terminal:${TURN}`
const RESOURCE = hash("a"), MATERIAL = hash("b"), ANSWERS = hash("c"), SCOPE = hash("d")
const EXPIRES = new Date("2026-11-21T10:15:00.000Z")
const lease: TurnLease = { turnId: TURN, sessionId: SESSION, ownerId: "worker-review", userId: USER, leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-21T09:59:00.000Z"), leaseExpiresAt: new Date("2026-11-21T10:01:00.000Z") }
const scope: TenantScope = { userId: USER }
const intent = { kind: "reviewed_application_review", version: 1, sourceTurnId: SOURCE, jobId: JOB } as const
const snapshot: TurnEngineOptions["snapshot"] = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }

describe("canonical reviewed application review Turn", () => {
  it.each(["issued", "waiting"] as const)("returns only the durable approval wait for %s", async status => {
    const f = fixture({ issueStatus: status })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).resolves.toEqual({
      status: "waiting_for_approval", waitId: APPROVAL, stepCount: 0, toolCallCount: 0,
    })
    expect(f.issue).toHaveBeenCalledOnce()
    expect(f.store.startStep).not.toHaveBeenCalled()
    expect(f.store.recordFinalResponse).not.toHaveBeenCalled()
    expect(f.store.appendEvent).toHaveBeenCalledOnce()
    expect(f.appendEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "turn.started", idempotencyKey: `turn:${TURN}:event:turn-started`,
      payload: { goal: "Record the review decision", taskId: ROOT, rootTaskId: ROOT },
    })
  })

  it.each(["approved", "rejected"] as const)("records the exact %s human decision through atomic terminal commit", async status => {
    const f = fixture({ issueStatus: status })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).resolves.toMatchObject({
      status: "completed", stepCount: 1, toolCallCount: 0,
      finalText: status === "approved" ? "The user approved the reviewed application materials for a later form fill."
        : "The user rejected approval to use the reviewed application materials for a later form fill.",
    })
    expect(f.contextBuild).toHaveBeenCalledWith(expect.objectContaining({
      rootInputId: ROOT_INPUT, rootContextInputId: ROOT_INPUT, mode: "new", taskId: ROOT,
    }))
    expect(f.store.startStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: `reviewed-application-review:terminal:${TURN}`, inputThroughSequence: ROOT_INPUT_SEQUENCE,
      consumedInputIds: [],
    }))
    expect(f.store.updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", finishReason: "stop" }))
    expect(f.store.recordFinalResponse).toHaveBeenCalledOnce()
    const final = JSON.parse(String(f.recorded?.response)) as Record<string, unknown>
    expect(final).toMatchObject({ completed: true, terminalReason: "goal_satisfied", evidenceRefs: [`approval:${APPROVAL}`] })
    expect(f.appendEvent.mock.calls.map(([event]) => event.type)).toEqual(["turn.started", "step.started", "step.completed"])
    expect(f.appendEvent.mock.calls.some(([event]) => event.type.includes("tool") || event.type.includes("model"))).toBe(false)
  })

  it("does not issue or open a Step after cancellation", async () => {
    const f = fixture({ issueStatus: "issued" }), controller = new AbortController()
    controller.abort()
    await expect(runCanonicalReviewedApplicationReviewTurn({ ...f.input, signal: controller.signal })).resolves.toMatchObject({
      status: "interrupted", errorCode: "turn_cancelled", stepCount: 0,
    })
    expect(f.issue).not.toHaveBeenCalled()
    expect(f.store.startStep).not.toHaveBeenCalled()
  })

  it("does not open a terminal Step when cancellation arrives during issuance", async () => {
    const f = fixture(), controller = new AbortController()
    const issue = vi.fn(async () => {
      controller.abort()
      return { status: "approved" as const, approvalId: APPROVAL, waitItemId: WAIT_ITEM }
    })
    await expect(runCanonicalReviewedApplicationReviewTurn({ ...f.input, signal: controller.signal, issue })).resolves.toMatchObject({
      status: "interrupted", errorCode: "turn_cancelled", stepCount: 0,
    })
    expect(f.store.startStep).not.toHaveBeenCalled()
  })

  it("fails closed on issuer denial without creating a wait or Step", async () => {
    const f = fixture({ issueStatus: "denied" })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).resolves.toMatchObject({
      status: "failed", errorCode: "reviewed_application_review_denied", stepCount: 0,
    })
    expect(f.store.startStep).not.toHaveBeenCalled()
    expect(f.store.recordFinalResponse).not.toHaveBeenCalled()
  })

  it("rejects terminalization when the private binding names a different reviewed source", async () => {
    const f = fixture({ issueStatus: "approved", sourceTurnId: "other-source-turn" })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).rejects.toThrow("reviewed_application_decision_unverified")
    expect(f.store.recordFinalResponse).toHaveBeenCalledOnce()
  })

  it("replays a claimed root input from its exact stable Step checkpoint", async () => {
    const savedSequence = 31n, f = fixture({ issueStatus: "approved", inputStatus: "consumed",
      consumedByStepId: TERMINAL_STEP, savedCheckpoint: { inputThroughSequence: savedSequence, consumedInputIds: [ROOT_INPUT] } })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).resolves.toMatchObject({ status: "completed" })
    expect(f.inputQuery).toHaveBeenCalledWith(expect.stringContaining('FROM "agent_steps"'), expect.any(Array))
    expect(f.store.startStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: TERMINAL_STEP, inputThroughSequence: savedSequence, consumedInputIds: [ROOT_INPUT],
    }))
    expect(f.contextBuild).toHaveBeenCalledWith(expect.objectContaining({ mode: "retry", rootInputId: ROOT_INPUT }))
  })

  it("rejects a root input consumed by another Step before opening its terminal Step", async () => {
    const f = fixture({ issueStatus: "approved", inputStatus: "consumed", consumedByStepId: "other-step" })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).rejects.toThrow("reviewed_application_root_input_unavailable")
    expect(f.store.startStep).not.toHaveBeenCalled()
  })

  it("rejects terminalization when resolved Wait evidence disagrees with the approval decision", async () => {
    const f = fixture({ issueStatus: "rejected", resolvedStatus: "approved" })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).rejects.toThrow("reviewed_application_decision_unverified")
  })

  it("rejects an approval or Wait identity outside the stable same-Turn scope", async () => {
    const f = fixture({ issueStatus: "approved", approvalId: "other-approval" })
    await expect(runCanonicalReviewedApplicationReviewTurn(f.input)).rejects.toThrow("reviewed_application_wait_identity_invalid")
    expect(f.store.startStep).not.toHaveBeenCalled()
  })
})

function fixture(options: {
  issueStatus?: "issued" | "waiting" | "approved" | "rejected" | "denied"
  approvalId?: string; sourceTurnId?: string; resolvedStatus?: "approved" | "rejected"
  inputStatus?: "accepted" | "consumed"; consumedByStepId?: string | null
  savedCheckpoint?: { inputThroughSequence: bigint; consumedInputIds: readonly string[] }
} = {}) {
  const issueStatus = options.issueStatus ?? "approved", approvalId = options.approvalId ?? APPROVAL
  let terminalGuard: TurnEngineTerminalGuard | undefined
  let recorded: Parameters<TurnEngineStore["recordFinalResponse"]>[0] | undefined
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_approvals"')
    ? [approvalRow({ approvalId, status: issueStatus === "rejected" ? "rejected" : "approved", resolvedStatus: options.resolvedStatus })]
    : sql.includes('FROM "application_task_events"')
      ? [{ taskId: APP, type: "reviewed_application_review_issued", actor: "worker", body: "Reviewed application approval binding recorded.", data: bindingData(options.sourceTurnId ?? SOURCE) }]
      : [], rowCount: 1 }))
  const client = { query } as unknown as PoolClient
  const inputQuery = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_sessions"')
    ? [{ id: SESSION }]
    : sql.includes('FROM "agent_turns"') ? [{ id: TURN }]
      : sql.includes('FROM "agent_steps"') ? [{ inputThroughSequence: options.savedCheckpoint?.inputThroughSequence ?? ROOT_INPUT_SEQUENCE,
        consumedInputIds: options.savedCheckpoint?.consumedInputIds ?? [ROOT_INPUT] }]
      : sql.includes('FROM "agent_inputs"') ? [{ id: ROOT_INPUT, sessionId: SESSION, targetTurnId: TURN, userId: USER,
        clientMessageId: "review-command", delivery: "follow_up", status: options.inputStatus ?? "accepted", content: [{ type: "text", text: "Review application materials" }], acceptedSequence: ROOT_INPUT_SEQUENCE,
        consumedByStepId: options.inputStatus === "consumed" ? options.consumedByStepId ?? TERMINAL_STEP : null,
        consumedAt: options.inputStatus === "consumed" ? NOW : null, createdAt: NOW }]
        : [], rowCount: 1 }))
  const pool = { connect: vi.fn(async () => ({ query: inputQuery, release: vi.fn() })) } as unknown as Pool
  const store: TurnEngineStore = {
    startStep: vi.fn(async input => ({ id: input.stepId, ordinal: 0 })),
    updateStep: vi.fn(async () => undefined),
    createItem: vi.fn(async input => ({ id: input.itemId, revision: 1 })),
    updateItem: vi.fn(async (input: Parameters<TurnEngineStore["updateItem"]>[0]) => ({ id: input.itemId, revision: input.expectedRevision + 1 })),
    appendEvent: vi.fn(async (input: Parameters<TurnEngineStore["appendEvent"]>[0]) => ({ id: input.id })),
    appendEvents: vi.fn(async (inputs: Parameters<NonNullable<TurnEngineStore["appendEvents"]>>[0]) => inputs.map(input => ({ id: input.id }))),
    recordFinalResponse: vi.fn(async input => {
      recorded = input
      if (!input.terminal || !terminalGuard) throw new Error("terminal_commit_unavailable")
      const result = await terminalGuard(client, { ...input.terminal, owner: input.owner as TurnExecutionOwnerFence, response: input.response, now: input.now })
      if (!result.ok) throw new Error(result.blocker)
      return { status: "completed", finalItemId: input.terminal.finalItemId, events: [] }
    }),
  } as unknown as TurnEngineStore
  const contextBuild = vi.fn(async () => ({ inputThroughSequence: options.savedCheckpoint?.inputThroughSequence ?? ROOT_INPUT_SEQUENCE, consumedInputIds: [ROOT_INPUT] }))
  const contextBuilder = { build: contextBuild } as unknown as TurnEngineOptions["contextBuilder"]
  const issue = vi.fn(async () => issueStatus === "denied" ? { status: "denied" as const } : {
    status: issueStatus, approvalId, waitItemId: `agent-wait:approval:${approvalId}`,
  })
  const input = {
    pool, lease, rootTaskId: ROOT, scope, intent, goal: "Record the review decision", snapshot,
    contextBuilder, modelProfileSnapshot: { profile: "deterministic" } satisfies RepositoryJsonValue,
    rootInputId: ROOT_INPUT, rootContextInputId: ROOT_INPUT, signal: new AbortController().signal, issue,
    now: () => NOW, storeFactory: vi.fn((_pool: Pool, guard?: TurnEngineTerminalGuard) => { terminalGuard = guard; return store }),
  }
  return { input, issue, contextBuild, store, query, inputQuery, appendEvent: store.appendEvent as ReturnType<typeof vi.fn>, get recorded() { return recorded } }
}

function approvalRow(options: { approvalId: string; status: "approved" | "rejected"; resolvedStatus?: "approved" | "rejected" }) {
  const status = options.status, resolvedStatus = options.resolvedStatus ?? status
  const content = { waitKind: "approval", approvalId: options.approvalId, toolCallId: TOOL_CALL, action: "review_application",
    title: "Review selected application", body: "Approve these reviewed materials for a later form fill. This approval does not authorize submission.",
    impact: { externalSubmission: false, jobId: JOB }, scopeHash: SCOPE, receiptRevision: 8, expiresAt: EXPIRES.toISOString(),
    decision: status, responseAvailable: true, respondedAt: NOW.toISOString() }
  return {
    id: options.approvalId, userId: USER, sessionId: SESSION, turnId: TURN, taskId: APP, jobId: JOB,
    type: "review_application", status, toolCallId: TOOL_CALL, payload: { applicationTaskId: APP, jobId: JOB },
    resourceHash: RESOURCE, materialHash: MATERIAL, answersHash: ANSWERS, scopeHash: SCOPE, revision: 8,
    expiresAt: EXPIRES, decidedAt: NOW, consumedAt: null, waitItemId: `agent-wait:approval:${options.approvalId}`,
    waitStepId: null, waitTaskId: null, waitType: "approval_request", waitStatus: "completed", waitPhase: "commentary", waitRevision: 1,
    waitContent: content, resolvedActor: "user", resolvedTaskId: APP, resolvedItemId: `agent-wait:approval:${options.approvalId}`,
    resolvedPayload: { waitKind: "approval", waitId: options.approvalId, itemId: `agent-wait:approval:${options.approvalId}`,
      turnId: TURN, toolCallId: TOOL_CALL, status: resolvedStatus, nextTurnRevision: 9, answerAvailable: false },
  }
}

function bindingData(sourceTurnId: string) {
  return { schemaVersion: "agent-harness.v2.reviewed-application-review-binding.v1", approvalId: APPROVAL,
    reviewTurnId: TURN, applicationTaskId: APP, userId: USER, sessionId: SESSION, jobId: JOB,
    proof: { sourceTurnId, rootTaskId: "source-root", graphRevision: 4, jobId: JOB, writerTaskId: "writer-task",
      reviewerTaskId: "reviewer-task", reviewerToolCallId: "reviewer-call", reviewHash: hash("e"), artifactId: "artifact-review",
      version: 2, contentHash: hash("f"), sourceDigest: hash("1") },
    receiptScope: { action: "review_application", toolCallId: TOOL_CALL, resourceHash: RESOURCE, materialHash: MATERIAL,
      answersHash: ANSWERS, revision: 8, expiresAt: EXPIRES.toISOString() },
  }
}

function hash(char: string): string { return `sha256:${char.repeat(64)}` }
