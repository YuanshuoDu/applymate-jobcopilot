import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"
import { OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, type ObjectiveApplicationReviewIntent, type TurnIntent } from "@jobcopilot/agent-protocol"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { TurnExecutionOwnerFence } from "./execution-owner.js"
import type { TurnEngineOptions, TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import type { TurnLease } from "./turns/lease.js"
import { objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId, type ObjectiveApplicationReviewSetMember, type ObjectiveApplicationReviewSetState } from "./objective-application-review-set-state.js"
import { runCanonicalObjectiveApplicationReviewTurn } from "./canonical-objective-application-review-turn.js"

const USER = "user-review", SESSION = "session-review", TURN = "turn-review", ROOT = "root-review", SOURCE = "source-turn"
const ROOT_INPUT = "input-review", SET_ID = objectiveApplicationReviewSetId(SESSION, TURN), ITEM_ID = `agent-wait:approval-set:${SET_ID}`
const NOW = new Date("2026-11-24T10:00:00.000Z"), SEQUENCE = 22n
const selection: ObjectiveApplicationReviewIntent = { schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, sourceTurnId: SOURCE,
  rootTaskId: "source-root", graphItemId: "source-graph", graphRevision: 9, slotOrdinals: [1, 2, 3] }
const intent: Extract<TurnIntent, { kind: "objective_application_review" }> = { kind: "objective_application_review", version: 1,
  selection: { ...selection, slotOrdinals: [...selection.slotOrdinals] } }
const lease: TurnLease = { turnId: TURN, sessionId: SESSION, ownerId: "worker-review", userId: USER, leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-24T09:59:00.000Z"), leaseExpiresAt: new Date("2026-11-24T10:01:00.000Z") }
const scope: TenantScope = { userId: USER }
const snapshot: TurnEngineOptions["snapshot"] = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }

describe("canonical Objective application review Turn", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("returns only the durable group wait while members remain pending", async () => {
    const f = fixture("issued", [member(1, "pending"), member(2, "pending"), member(3, "pending")])
    await expect(runCanonicalObjectiveApplicationReviewTurn(f.input)).resolves.toEqual({
      status: "waiting_for_approval", waitId: SET_ID, stepCount: 0, toolCallCount: 0,
    })
    expect(f.store.appendEvent).toHaveBeenCalledOnce()
    expect(f.store.startStep).not.toHaveBeenCalled()
    expect(f.store.recordFinalResponse).not.toHaveBeenCalled()
  })

  it("writes a bounded factual terminal result only after the exact set wake is reread", async () => {
    const members = [member(1, "approved"), member(2, "rejected"), member(3, "expired")]
    const f = fixture("resolved", members)
    await expect(runCanonicalObjectiveApplicationReviewTurn(f.input)).resolves.toMatchObject({
      status: "completed", stepCount: 1, toolCallCount: 0,
      finalText: "Review decisions: 1 approved for form fill, 1 rejected, 1 expired. Final submission requires separate approval.",
    })
    expect(f.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selection }))
    expect(f.store.startStep).toHaveBeenCalledOnce()
    expect(f.store.recordFinalResponse).toHaveBeenCalledOnce()
    const appended = f.appendEvent.mock.calls.map(([event]) => event.type)
    expect(appended).toEqual(["turn.started", "step.started", "step.completed"])
    expect(appended.some(type => type.includes("tool") || type.includes("model"))).toBe(false)
  })

  it("rejects terminalization if a member changed after the issuer returned resolved", async () => {
    const members = [member(1, "approved"), member(2, "approved"), member(3, "rejected")]
    const changed = state(members.map((value, index) => index === 1 ? { ...value, proof: { ...value.proof, materialProofHash: "f".repeat(64) } } : value))
    const f = fixture("resolved", members, changed)
    await expect(runCanonicalObjectiveApplicationReviewTurn(f.input)).rejects.toThrow("objective_application_review_unverified")
    expect(f.store.recordFinalResponse).toHaveBeenCalledOnce()
  })

  it("reuses the exact consumed root-input checkpoint after a Worker resume", async () => {
    const f = fixture("resolved", [member(1, "approved"), member(2, "approved"), member(3, "rejected")], undefined,
      { inputStatus: "consumed", savedSequence: 31n })
    await expect(runCanonicalObjectiveApplicationReviewTurn(f.input)).resolves.toMatchObject({ status: "completed" })
    expect(f.store.startStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: `objective-application-review:terminal:${TURN}`, inputThroughSequence: 31n, consumedInputIds: [ROOT_INPUT],
    }))
    expect(f.contextBuild).toHaveBeenCalledWith(expect.objectContaining({ mode: "retry", rootInputId: ROOT_INPUT }))
  })

  it("does not issue a group for a foreign owner lease", async () => {
    const f = fixture("issued", [member(1, "pending"), member(2, "pending"), member(3, "pending")])
    await expect(runCanonicalObjectiveApplicationReviewTurn({ ...f.input, scope: { userId: "other-user" } })).rejects.toThrow("objective_application_review_scope_invalid")
    expect(f.issue).not.toHaveBeenCalled()
    expect(f.store.appendEvent).not.toHaveBeenCalled()
  })
})

function member(slotOrdinal: number, status: ObjectiveApplicationReviewSetMember["status"]): ObjectiveApplicationReviewSetMember {
  return { slotOrdinal, approvalId: `approval-${slotOrdinal}`, applicationTaskId: `application-${slotOrdinal}`, jobId: `job-${slotOrdinal}`, status,
    receiptRevision: 8,
    proof: { materialProofHash: String(slotOrdinal).repeat(64) } as ObjectiveApplicationReviewSetMember["proof"] }
}
function state(members: readonly ObjectiveApplicationReviewSetMember[]): ObjectiveApplicationReviewSetState {
  return { status: "resolved", setId: SET_ID, itemId: ITEM_ID, intentHash: objectiveApplicationReviewIntentHash(selection), members,
    wakeup: { waitKind: "approval_set", waitId: SET_ID, itemId: ITEM_ID, turnId: TURN, nextTurnRevision: 4 } as ObjectiveApplicationReviewSetState["wakeup"] }
}
function fixture(issueStatus: "issued" | "waiting" | "resolved" | "denied", members: readonly ObjectiveApplicationReviewSetMember[], current: ObjectiveApplicationReviewSetState | undefined = state(members),
  inputOptions: { inputStatus?: "accepted" | "consumed"; savedSequence?: bigint } = {}) {
  let guard: TurnEngineTerminalGuard | undefined
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as unknown as PoolClient
  const inputQuery = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_sessions"') ? [{ id: SESSION }]
    : sql.includes('FROM "agent_turns"') ? [{ id: TURN }]
    : sql.includes('FROM "agent_steps"') ? [{ inputThroughSequence: inputOptions.savedSequence ?? SEQUENCE, consumedInputIds: [ROOT_INPUT] }]
      : sql.includes('FROM "agent_inputs"') ? [{ id: ROOT_INPUT, sessionId: SESSION, targetTurnId: TURN, userId: USER,
        clientMessageId: "review-command", delivery: "follow_up", status: inputOptions.inputStatus ?? "accepted", content: [{ type: "text", text: "Review" }],
        acceptedSequence: SEQUENCE, consumedByStepId: inputOptions.inputStatus === "consumed" ? `objective-application-review:terminal:${TURN}` : null,
        consumedAt: inputOptions.inputStatus === "consumed" ? NOW : null, createdAt: NOW }]
      : [], rowCount: 1 }))
  const pool = { connect: vi.fn(async () => ({ query: inputQuery, release: vi.fn() })) } as unknown as Pool
  const store: TurnEngineStore = {
    appendEvent: vi.fn(async input => ({ id: input.id })), startStep: vi.fn(async input => ({ id: input.stepId, ordinal: input.ordinal })),
    updateStep: vi.fn(async () => undefined), recordFinalResponse: vi.fn(async input => {
      const terminal = input.terminal!
      const result = await guard!(client, { ...terminal, owner: input.owner as TurnExecutionOwnerFence, response: input.response, now: input.now })
      if (!result.ok) throw new Error(result.blocker)
      return { status: "completed", finalItemId: terminal.finalItemId, events: [] }
    }),
  } as unknown as TurnEngineStore
  const read = vi.fn(async () => current)
  const issue = vi.fn(async () => issueStatus === "denied" ? { status: "denied" as const } : {
    status: issueStatus, setId: SET_ID, itemId: ITEM_ID, intentHash: objectiveApplicationReviewIntentHash(selection), members,
  })
  const contextBuild = vi.fn(async (input: { mode: "new" | "retry" }) => ({ inputThroughSequence: inputOptions.savedSequence ?? SEQUENCE, consumedInputIds: [ROOT_INPUT] }))
  const contextBuilder = { build: contextBuild } as unknown as TurnEngineOptions["contextBuilder"]
  const input = { pool, lease, rootTaskId: ROOT, scope, intent, goal: "Review selected materials", snapshot, contextBuilder,
    modelProfileSnapshot: {}, rootInputId: ROOT_INPUT, signal: new AbortController().signal, issue, readSetState: read,
    now: () => NOW, storeFactory: vi.fn((_pool: Pool, value?: TurnEngineTerminalGuard) => { guard = value; return store }) }
  return { input, issue, read, store, inputQuery, contextBuild, appendEvent: store.appendEvent as ReturnType<typeof vi.fn> }
}
