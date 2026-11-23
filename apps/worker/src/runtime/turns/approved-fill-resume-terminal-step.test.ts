import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { AtomicTurnCompletionInput, TurnEngineEventInput } from "./turn-engine-types.js"

const { readStartWitness, getClaim } = vi.hoisted(() => ({ readStartWitness: vi.fn(), getClaim: vi.fn() }))
vi.mock("../context/root-task-history-chronology-witness.js", async importOriginal => ({
  ...await importOriginal<typeof import("../context/root-task-history-chronology-witness.js")>(),
  readRootTaskHistoryChronologyWitness: readStartWitness,
}))
vi.mock("./approved-fill-terminal-claim.js", () => ({ getApprovedFillTerminalClaim: getClaim }))

import { approvedFillResumeTerminalStepData, createApprovedFillResumeTerminalStepDescriptor, writeApprovedFillResumeTerminalStep } from "./approved-fill-resume-terminal-step.js"

const lease = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "owner-a", leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-23T10:00:00.000Z"), leaseExpiresAt: new Date("2026-11-23T10:01:00.000Z") }
const proof = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-a", turnOwnerId: lease.ownerId,
  turnLeaseVersion: lease.leaseVersion, turnRevision: 8, applicationTaskId: "application-a", jobId: "job-a", fillerTaskId: "filler-a",
  graphRevision: 2, graphFingerprint: "graph-a", approvalId: "approval-a", waitItemId: "wait-a", approvalRevision: 9,
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), state: "form_filled" as const,
  workerTaskId: null, outboxId: null }
const stepId = `approved-fill-resume:${createHash("sha256").update(lease.turnId, "utf8").digest("hex")}:${lease.leaseVersion}:2`
const descriptor = () => createApprovedFillResumeTerminalStepDescriptor({ proof, lease, rootTaskId: "root-a", ordinal: 2,
  inputThroughSequence: 4n, consumedInputIds: ["input-a"], modelProfileSnapshot: { provider: "test", nested: { first: 1, second: 2 } }, stepCount: 3, toolCallCount: 1 })
const owner: TurnExecutionOwnerFence = { kind: "turn", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "root-a", rootTaskId: "root-a", ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
const terminal: AtomicTurnCompletionInput = { stepId, finalItemId: "final-a", finalContent: { text: "completed" }, stepCount: 3,
  toolCallCount: 1, usage: { inputTokens: 5, outputTokens: 4, estimatedCostUsd: 0.001 } }
const anchor = { id: "turn-start-a", sessionId: lease.sessionId, turnId: lease.turnId, taskId: "root-a", itemId: null,
  type: "turn.started", actor: "orchestrator", correlationId: lease.turnId, causationId: null,
  idempotencyKey: `turn:${lease.turnId}:event:turn-started`, payload: { goal: "Fill", taskId: "root-a", rootTaskId: "root-a" } }

beforeEach(() => {
  readStartWitness.mockReset().mockResolvedValue({ eventId: "start-witness-a", xid8: "10" })
  getClaim.mockReset().mockImplementation((candidate: unknown) => candidate === lease ? proof : undefined)
})

describe("approved Fill atomic terminal step capability", () => {
  it("brands only the exact early form-filled proof and copies continuation inputs", () => {
    const issued = descriptor()
    expect(approvedFillResumeTerminalStepData(issued)).toMatchObject({ proof, rootTaskId: "root-a", ordinal: 2,
      inputThroughSequence: 4n, consumedInputIds: ["input-a"], stepCount: 3, toolCallCount: 1 })
    expect(approvedFillResumeTerminalStepData({})).toBeUndefined()
    const authorizedProof = { ...proof, state: "submission_authorized" as const }
    expect(() => createApprovedFillResumeTerminalStepDescriptor({ proof: authorizedProof,
      lease, rootTaskId: "root-a", ordinal: 2, inputThroughSequence: 4n, consumedInputIds: [], modelProfileSnapshot: {}, stepCount: 3, toolCallCount: 1 }))
      .toThrow("approved_fill_terminal_descriptor_invalid")
    expect(() => createApprovedFillResumeTerminalStepDescriptor({ proof, lease: { ...lease, ownerId: "other" }, rootTaskId: "root-a",
      ordinal: 2, inputThroughSequence: 4n, consumedInputIds: [], modelProfileSnapshot: {}, stepCount: 3, toolCallCount: 1 }))
      .toThrow("approved_fill_terminal_descriptor_invalid")
  })

  it("writes the synthetic step and lifecycle events through the supplied transaction client", async () => {
    const calls: string[] = [], events: TurnEngineEventInput[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_events" WHERE "sessionId"=$1') && sql.includes('"idempotencyKey"=$4')) return { rows: [anchor] }
      if (sql.includes('SELECT root_task."budgetSnapshot"')) return { rows: [{ budgetSnapshot: { limits: { maxSteps: 32 } } }] }
      if (sql.includes('COUNT(*)::bigint AS "used"')) return { rows: [{ used: "1" }] }
      if (sql.includes('COALESCE(MAX("ordinal")')) return { rows: [{ ordinal: 2 }] }
      if (sql.includes('FROM "agent_steps" WHERE')) return { rows: [] }
      if (sql.includes('FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey" IN')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    }) }
    const completedEventId = await writeApprovedFillResumeTerminalStep({ client: client as never, owner, terminal,
      descriptor: descriptor(), now: new Date("2026-11-23T10:00:30.000Z"), alreadyCommitted: false,
      appendEvent: async event => { events.push(event); return { id: event.id, type: event.type, itemId: event.itemId,
        correlationId: event.correlationId, causationId: event.causationId, payload: event.payload } } })

    expect(completedEventId).toBe(`turn:${lease.turnId}:event:step-completed:${stepId}`)
    expect(calls.some(sql => sql.startsWith("INSERT INTO \"agent_steps\""))).toBe(true)
    expect(calls.some(sql => sql.startsWith("UPDATE \"agent_steps\""))).toBe(true)
    expect(readStartWitness).toHaveBeenCalledWith(client, expect.objectContaining({ boundary: "turn_start", boundaryEventId: anchor.id }))
    expect(events.map(event => event.type)).toEqual(["step.started", "step.completed"])
    expect(events[0]).toMatchObject({ causationId: anchor.id, payload: { stepId, ordinal: 2, taskId: "root-a" } })
    expect(events[1]).toMatchObject({ causationId: events[0]!.id, payload: { stepId, status: "completed", taskId: "root-a" } })
  })

  it("refuses to recreate a missing step on terminal replay", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_events" WHERE "sessionId"=$1')
      ? { rows: [anchor] } : { rows: [] }) }
    await expect(writeApprovedFillResumeTerminalStep({ client: client as never, owner, terminal, descriptor: descriptor(),
      now: new Date("2026-11-23T10:00:30.000Z"), alreadyCommitted: true, appendEvent: vi.fn() }))
      .rejects.toThrow("approved_application_fill_terminal_step_conflict")
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO \"agent_steps\""))).toBe(false)
  })

  it("accepts an exact committed replay with JSONB key order differences without inserting", async () => {
    const startedId = `turn:${lease.turnId}:event:step-started:${stepId}`
    const completedId = `turn:${lease.turnId}:event:step-completed:${stepId}`
    const startedKey = `turn:${lease.turnId}:event:step-started:${stepId}`
    const completedKey = `turn:${lease.turnId}:event:step-completed:${stepId}`
    const started = { id: startedId, sessionId: lease.sessionId, turnId: lease.turnId, taskId: "root-a", itemId: null, sequence: "20",
      type: "step.started", actor: "orchestrator", correlationId: stepId, causationId: anchor.id, idempotencyKey: startedKey,
      payload: { taskId: "root-a", ordinal: 2, stepId } }
    const completed = { ...started, id: completedId, sequence: "21", type: "step.completed", causationId: startedId,
      idempotencyKey: completedKey, payload: { status: "completed", taskId: "root-a", stepId } }
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_events" WHERE "sessionId"=$1') && sql.includes('"idempotencyKey"=$4')) return { rows: [anchor] }
      if (sql.includes('FROM "agent_steps" WHERE "id"=$1')) return { rows: [{ id: stepId, sessionId: lease.sessionId, turnId: lease.turnId,
        taskId: "root-a", ordinal: 2, attempt: 1, status: "completed", inputThroughSequence: "4", consumedInputIds: ["input-a"],
        modelProfileSnapshot: { nested: { second: 2, first: 1 }, provider: "test" }, finishReason: "stop", errorCode: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }] }
      if (sql.includes('FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey" IN')) return { rows: [started, completed] }
      if (sql.includes('FROM "agent_outbox"')) {
        const event = values?.[0] === `agent-event:${started.id}` ? started : completed
        return { rows: [{ id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: lease.sessionId,
          idempotencyKey: `agent-event:${event.id}`, payload: { eventId: event.id, sessionId: event.sessionId, turnId: event.turnId,
            taskId: event.taskId, itemId: null, sequence: event.sequence, type: event.type, actor: event.actor,
            correlationId: event.correlationId, causationId: event.causationId, idempotencyKey: event.idempotencyKey,
            payload: event.payload } }] }
      }
      return { rows: [] }
    }) }

    await expect(writeApprovedFillResumeTerminalStep({ client: client as never, owner, terminal: { ...terminal,
      approvedFillResumeTerminalStep: descriptor() }, descriptor: descriptor(), now: new Date("2026-11-23T10:00:30.000Z"),
      alreadyCommitted: true, appendEvent: vi.fn() })).resolves.toBe(completedId)
    expect(calls.some(sql => sql.startsWith("INSERT INTO \"agent_steps\""))).toBe(false)
    expect(calls.some(sql => sql.startsWith("UPDATE \"agent_steps\""))).toBe(false)
  })

  it("rejects an unbranded terminal descriptor before querying storage", async () => {
    const client = { query: vi.fn() }
    await expect(writeApprovedFillResumeTerminalStep({ client: client as never, owner, terminal, descriptor: {} as never,
      now: new Date("2026-11-23T10:00:30.000Z"), alreadyCommitted: false, appendEvent: vi.fn() }))
      .rejects.toThrow("approved_application_fill_terminal_step_conflict")
    expect(client.query).not.toHaveBeenCalled()
  })
})
