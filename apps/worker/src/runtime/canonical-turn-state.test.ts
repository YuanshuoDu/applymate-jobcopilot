import { describe, expect, it, vi } from "vitest"

import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { scopeCanonicalWaitProjections } from "./canonical-wait-scope.js"
import { buildContextMemoryProjection } from "./context/context-memory-projection.js"
import { buildPlanCompletionFeedbackEvent, PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, planCompletionRecoveryCount } from "./planning/plan-completion-feedback.js"
import { STEERING_MARKER_EVENT_TYPE, steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "./context/steering-marker.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-09T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-10T00:01:00.000Z"),
}

const markerPayload = (kind: "observed" | "applied" = "observed"): SteeringMarkerPayload => ({
  schemaVersion: "agent-harness.steering-marker.v1", kind, status: kind, sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
  stepId: "step-1", inputId: "input-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "input-1"), obligationId: "obligation-1",
  goalRevision: 1, planRevision: 1, acceptedSequence: "4",
})
const markerEvent = (kind: "observed" | "applied" = "observed", sequence = "4"): Record<string, unknown> => ({
  id: `marker-${kind}`, type: STEERING_MARKER_EVENT_TYPE, actor: "system", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", sequence, payload: markerPayload(kind),
})
const graphEvent = (type: "start" | "complete" | "fail" | "wait" | "cancel" | "retry", nodeId: string, sequence: string, payload: Record<string, unknown> = {}, attempt?: number): Record<string, unknown> => ({
  id: `graph-${sequence}`, type: "plan.task_graph", actor: "worker", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", sequence,
  payload: { runKey: "root-1:proposal-1:1", event: { type, nodeId, eventId: attempt === undefined || attempt === 1 ? `root-1:proposal-1:1:${nodeId}:${type}` : `root-1:proposal-1:1:${nodeId}:attempt:${attempt}:${type}`, ...(attempt === undefined ? {} : { attempt }) }, ...payload },
})
function patchGraphEvent(row: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const payload = row.payload as Record<string, unknown>
  return { ...row, payload: { ...payload, event: { ...(payload.event as Record<string, unknown>), ...patch } } }
}

function pool(rows: { turn?: Record<string, unknown>; steps?: Record<string, unknown>[]; items?: Record<string, unknown>[]; inputs?: Record<string, unknown>[]; events?: Record<string, unknown>[]; snapshots?: Record<string, unknown>[] }) {
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: rows.turn ? [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, ...rows.turn }] : [], rowCount: rows.turn ? 1 : 0 }
    if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: Math.max(...(rows.steps ?? []).map(step => Number(step.ordinal ?? -1)), -1) }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: (rows.steps ?? []).filter(step => step.taskId === undefined || step.taskId === null || step.taskId === values?.[2]), rowCount: rows.steps?.length ?? 0 }
    if (sql.includes('FROM "agent_events"')) return { rows: (rows.events ?? []).filter(event => event.taskId === undefined || event.taskId === null || event.taskId === values?.[2]), rowCount: rows.events?.length ?? 0 }
    if (sql.includes('FROM "agent_items"')) {
      const filtered = sql.includes('item_task') ? (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === "root-1") : (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === values?.[2])
      return { rows: filtered, rowCount: filtered.length }
    }
    if (sql.includes('FROM "agent_context_snapshots"')) return { rows: rows.snapshots ?? [], rowCount: rows.snapshots?.length ?? 0 }
    if (sql.includes('FROM "agent_inputs"')) return { rows: rows.inputs ?? [], rowCount: rows.inputs?.length ?? 0 }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  return { connect: vi.fn(async () => client), client } as unknown as Pick<import("pg").Pool, "connect"> & { client: typeof client }
}

describe("loadCanonicalTurnState", () => {
  it("loads bounded plan task graph events from the scoped ordered event query", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [graphEvent("start", "first", "11"), graphEvent("complete", "first", "12")],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.taskGraphEvents?.map(item => item.event.eventId)).toEqual(["root-1:proposal-1:1:first:start", "root-1:proposal-1:1:first:complete"])
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"'))?.[0]
    expect(eventQuery).toContain("'plan.task_graph'")
  })

  it.each(["complete", "fail", "wait", "cancel"] as const)("loads retry and attempt two %s events", async terminal => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        graphEvent("start", "first", "11"), graphEvent("retry", "first", "12", {}, 2), graphEvent("start", "first", "13", {}, 2), graphEvent(terminal, "first", "14", {}, 2),
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.taskGraphEvents?.map(item => item.event)).toEqual([
      { type: "start", nodeId: "first", eventId: "root-1:proposal-1:1:first:start" },
      { type: "retry", nodeId: "first", eventId: "root-1:proposal-1:1:first:attempt:2:retry", attempt: 2 },
      { type: "start", nodeId: "first", eventId: "root-1:proposal-1:1:first:attempt:2:start", attempt: 2 },
      { type: terminal, nodeId: "first", eventId: `root-1:proposal-1:1:first:attempt:2:${terminal}`, attempt: 2 },
    ])
  })

  it("keeps a persisted state snapshot non-authoritative while preserving the event", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [graphEvent("start", "first", "11", { state: { statuses: { first: "completed" }, appliedEvents: [] } })],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.taskGraphEvents?.[0]?.event).toEqual({ type: "start", nodeId: "first", eventId: "root-1:proposal-1:1:first:start" })
  })

  it.each([
    ["missing retry attempt", graphEvent("retry", "first", "11")],
    ["retry attempt one", graphEvent("retry", "first", "11", {}, 1)],
    ["attempt over bound", graphEvent("start", "first", "11", {}, 3)],
    ["attempt two without attempt field", patchGraphEvent(graphEvent("start", "first", "11"), { eventId: "root-1:proposal-1:1:attempt:2:start" })],
    ["wrong event id", patchGraphEvent(graphEvent("start", "first", "11"), { eventId: "root-1:proposal-1:1:first:complete" })],
    ["unknown phase", patchGraphEvent(graphEvent("start", "first", "11"), { type: "unknown" })],
    ["extra event field", patchGraphEvent(graphEvent("start", "first", "11"), { extra: true })],
  ] as const)("rejects %s task graph events", async (_label, event) => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [event],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("task_graph_event_invalid")
  })

  it("rejects a retry event with an invalid run key", async () => {
    const event = graphEvent("retry", "first", "11", {}, 2)
    const payload = event.payload as Record<string, unknown>
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [{ ...event, payload: { ...payload, runKey: "root-1:other-plan:1" } }],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("task_graph_event_invalid")
  })

  it.each([
    ["foreign scope", { ...graphEvent("start", "first", "11"), userId: "other-user" }],
    ["foreign session", { ...graphEvent("start", "first", "11"), sessionId: "other-session" }],
    ["foreign turn", { ...graphEvent("start", "first", "11"), turnId: "other-turn" }],
    ["unknown envelope field", graphEvent("start", "first", "11", { extra: true })],
    ["invalid state snapshot", graphEvent("start", "first", "11", { state: "forged" })],
  ])("rejects %s task graph payloads", async (_label, event) => {
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, events: [event] })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow()
  })

  it("keeps foreign task graph rows out of the projection", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [{ ...graphEvent("start", "first", "11"), taskId: "other-task" }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.taskGraphEvents).toBeUndefined()
  })

  it("rejects oversized task graph payloads before returning state", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [graphEvent("start", "first", "11", { state: { oversized: "x".repeat(8 * 1024) } })],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("task_graph_payload_too_large")
  })

  it("rejects out-of-order task graph event sequences", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [graphEvent("start", "first", "12"), graphEvent("complete", "first", "11")],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("task_graph_sequence_invalid")
  })

  it("replays scoped steering markers as independent canonical control state", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [markerEvent(), markerEvent("applied", "5")],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.steeringMarkers?.observed).toHaveLength(1)
    expect(value.steeringMarkers?.applied).toHaveLength(1)
    expect(value.steeringMarkers?.active).toEqual([])
    expect(value.snapshot.toolObservations.some(item => item.id === "marker-observed")).toBe(false)
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"'))?.[0]
    expect(eventQuery).toContain('event."id"')
    expect(eventQuery).toContain('event."actor"')
    expect(eventQuery).toContain('event_session."userId" AS "userId"')
    expect(eventQuery).toContain('event."sequence"')
    expect(eventQuery).toContain('event."payload"')
    expect(eventQuery).toContain(`'${STEERING_MARKER_EVENT_TYPE}'`)
    expect(eventQuery).toContain('(event."taskId" IS NULL OR event."taskId" = $3)')
  })

  it("fails closed when a scoped marker row is malformed", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [markerEvent("observed", "3")],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("steering_marker_state_invalid")
  })

  it("loads the owned turn and initial root input", async () => {
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: { provider: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: {} }, inputs: [{ id: "input-1" }] })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value).toMatchObject({ goal: "Find jobs", rootInputId: "input-1", scope: { userId: "user-1" } })
    expect(value.goalContract).toEqual({ revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" })
    expect(value.snapshot.goal).toEqual({ id: "turn-goal:turn-1", content: "Find jobs" })
    expect(value.steeringMarkers).toEqual({ observed: [], applied: [], active: [] })
    expect(fake.client.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes('agent_wait_conditions'))).toBe(false)
  })

  it("hydrates the structured goal contract from the owned turn input", async () => {
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs", goalContract: { revision: 1, objective: "Find jobs", constraints: ["EU only"], successCriteria: ["ranked roles"], knownFacts: ["Dublin"], unresolvedQuestions: ["salary"], approvalBoundaries: ["submit after approval"], budgetRef: "runtime:turn" } }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
    }), lease)
    expect(value.goal).toBe("Find jobs")
    expect(value.goalContract).toMatchObject({ constraints: ["EU only"], successCriteria: ["ranked roles"], knownFacts: ["Dublin"], unresolvedQuestions: ["salary"], approvalBoundaries: ["submit after approval"], budgetRef: "runtime:turn" })
  })

  it("restores the latest goal revision and invalidates plans from the prior goal", async () => {
    const current = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      snapshots: [{ throughSequence: "0", version: 1, content: {
        schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "0", goal: "Find jobs",
        userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
        context: { system: [], profile: [], steerHistory: [], toolObservations: [
          { id: "plan-revision:old-plan", content: { kind: "plan_revision", planCallId: "old-plan", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
          { id: "tool-result:old-plan-call", content: { toolCallId: "old-plan-call", toolName: "agent.plan.propose", status: "completed", output: { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } } },
        ] },
        tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
      } }],
      events: [
        { type: "goal.revision", payload: { goalRevision: 2, basedOnGoalRevision: 1, goalContract: current } },
        { type: "plan.revision", payload: { planCallId: "old-plan", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.revision", payload: { planCallId: "new-plan", goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } },
      ],
    }), lease)
    expect(value.goal).toBe("Find senior jobs")
    expect(value.goalContract).toEqual(current)
    expect(value.planRevision).toBe(1)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([
      { id: "goal-revision:2", content: expect.objectContaining({ kind: "goal_revision", goalRevision: 2 }) },
      { id: "plan-revision:new-plan", content: expect.objectContaining({ planRevision: 1, goalRevision: 2 }) },
    ]))
    expect(value.snapshot.toolObservations.some(item => item.id === "plan-revision:old-plan")).toBe(false)
    expect(value.snapshot.toolObservations.some(item => item.id === "tool-result:old-plan-call")).toBe(false)
  })

  it("does not replay old-goal plan command receipts into the current goal snapshot", async () => {
    const current = { revision: 2, objective: "Find senior jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const oldCommand = {
      planCallId: "old-plan", planRevision: 1, observationId: "plan-result:old-plan:read",
      content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { old: true } },
    }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.revision", payload: { planCallId: "old-plan", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: oldCommand },
        { type: "goal.revision", payload: { goalRevision: 2, basedOnGoalRevision: 1, goalContract: current } },
        { type: "plan.revision", payload: { planCallId: "new-plan", goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } },
      ],
    }), lease)
    expect(value.goalContract).toEqual(current)
    expect(value.snapshot.toolObservations.some(item => item.id === oldCommand.observationId)).toBe(false)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: "plan-revision:new-plan", content: expect.objectContaining({ goalRevision: 2, planRevision: 1 }) }]))
  })

  it("rebuilds durable tool observations and usage for resume", async () => {
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 3 } } },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "4", consumedInputIds: ["input-1"], inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.01 }],
      items: [{ type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed" } }, { type: "tool_result", content: { toolCallId: "call-1", output: { jobs: [] }, errorCode: null } }],
    }), lease)
    expect(value.resume).toMatchObject({ nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 4n, usage: { inputTokens: 5, outputTokens: 2 } })
    expect(value.snapshot.toolObservations).toEqual([expect.objectContaining({ id: "tool-result:call-1", content: expect.objectContaining({ toolName: "jobs.search" }) })])
  })

  it("fails closed before replay when a tool call has no terminal result", async () => {
    const call = { type: "tool_call", status: "completed", content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed" } }
    const cases = [
      [call],
      [call, { type: "tool_result", status: "started", content: { toolCallId: "call-1", output: { jobs: [] }, errorCode: null } }],
    ] as Record<string, unknown>[][]
    for (const items of cases) {
      const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, items })
      await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("tool_result_replay_uncertain")
      expect(fake.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    }
  })

  it("keeps the tenant setting inside a fenced transaction and restores a private lifecycle receipt", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } }, { type: "tool_result", content: { toolCallId: "call-1", outputAvailable: true, errorCode: null } }],
      events: [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations[0]?.content).toMatchObject({ output: { jobs: [{ id: "job-1" }] } })
    expect(fake.client.query.mock.calls[0]?.[0]).toBe("BEGIN")
    expect(fake.client.query.mock.calls[1]?.[0]).toContain("set_config")
    const turnQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_turns"'))?.[0]
    expect(turnQuery).toContain('"leaseExpiresAt" > $6')
    expect(fake.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("restores bounded plan observations once and preserves the snapshot projection", async () => {
    const observationId = "plan-result:proposal-1:read"
    const snapshotContent = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "0", goal: "Find jobs",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
      context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: observationId, content: { marker: "snapshot" } }] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      snapshots: [{ throughSequence: "0", version: 1, content: snapshotContent }],
      events: [
        { type: "plan.observation", payload: { observationId, content: { marker: "event" } } },
        { type: "plan.observation", payload: { observationId, content: { marker: "duplicate" } } },
        { type: "plan.observation", payload: { observationId: "oversized", content: "x".repeat(8 * 1024 + 1) } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toEqual([{ id: observationId, content: { marker: "snapshot" } }])
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"') && sql.includes("tool_call.completed"))?.[0]
    expect(eventQuery).toContain("'plan.observation'")
    expect(eventQuery).toContain('event_session."userId" = $4')
  })

  it("restores durable completion feedback only for the current plan and deduplicates it", async () => {
    const oldFeedback = buildPlanCompletionFeedbackEvent({ turnId: "turn-1", stepId: "turn:turn-1:step:0", attempt: 2, planId: "plan-1" })!
    const feedback = buildPlanCompletionFeedbackEvent({ turnId: "turn-1", stepId: "turn:turn-1:step:1", attempt: 1, planId: "plan-2" })!
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: oldFeedback },
        { type: "plan.revision", payload: { planCallId: "plan-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
        { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: feedback },
        { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: feedback },
        { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...feedback, planId: "foreign-plan" } },
        { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...feedback, feedback: "model text" } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations.filter(item => item.id === feedback.observationId)).toHaveLength(1)
    expect(value.snapshot.toolObservations.some(item => item.id === oldFeedback.observationId)).toBe(false)
    expect(value.snapshot.toolObservations.find(item => item.id === feedback.observationId)?.content).toMatchObject({ planId: "plan-2" })
    expect(planCompletionRecoveryCount(value.snapshot.toolObservations, lease.turnId)).toBe(1)
    expect(planCompletionRecoveryCount(value.snapshot.toolObservations, lease.turnId, "plan-2")).toBe(1)
    expect(planCompletionRecoveryCount(value.snapshot.toolObservations, lease.turnId, "plan-1")).toBe(0)
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"'))?.[0]
    expect(eventQuery).toContain(`'${PLAN_COMPLETION_FEEDBACK_EVENT_TYPE}'`)
  })

  it("restores the latest valid plan revision and ignores malformed or foreign receipts", async () => {
    const proposal = { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: { schemaVersion: "agent-harness.plan.v1" }, intents: [] }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "tool_call.completed", payload: { toolCallId: "legacy-plan", toolName: "agent.plan.propose", output: proposal } },
        { type: "plan.revision", payload: { planCallId: "receipt-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
        { type: "plan.revision", payload: { planCallId: "foreign", goalRevision: 1, planRevision: 99, basedOnPlanRevision: "bad" }, taskId: "child-1" },
        { type: "plan.revision", payload: { planCallId: "malformed", goalRevision: 1, planRevision: 4, basedOnPlanRevision: 1 } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.planRevision).toBe(2)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: "plan-revision:legacy-plan", content: expect.objectContaining({ planRevision: 1 }) }]))
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: "plan-revision:receipt-2", content: { kind: "plan_revision", planCallId: "receipt-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } }]))
  })

  it("restores a bounded context compaction projection for replay", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [{ type: "context.compaction", payload: {
        kind: "context_compacted", observationId: "context-compacted:step:0", status: "compacted", stepId: "step:0",
        idempotencyKey: "context-compaction:step:0", beforeInputTokens: 20, afterInputTokens: 8,
        beforeBytes: 80, afterBytes: 32, snapshotRef: "snapshot-compact-1",
      } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toEqual([expect.objectContaining({ id: "context-compacted:step:0", content: expect.objectContaining({ kind: "context_compacted", snapshotRef: "snapshot-compact-1" }) })])
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"'))?.[0]
    expect(eventQuery).toContain("'context.compaction'")
  })

  it("restores bounded semantic proposal hashes in event order and deduplicates them", async () => {
    const hashA = `sha256:${"a".repeat(64)}`
    const hashB = `sha256:${"b".repeat(64)}`
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.revision", payload: { planCallId: "one", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: hashA } },
        { type: "plan.revision", payload: { planCallId: "two", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: hashB } },
        { type: "plan.revision", payload: { planCallId: "three", goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2, proposalHash: hashB } },
        { type: "plan.revision", payload: { planCallId: "bad", goalRevision: 1, planRevision: 4, basedOnPlanRevision: 3, proposalHash: "bad" } },
      ],
    }), lease)
    expect(value.planRevision).toBe(3)
    expect(value.planProposalHashes).toEqual([hashA, hashB])
  })

  it("restores bounded plan command outcomes with observation deduplication", async () => {
    const command = { planCallId: "plan-1", planRevision: 1, observationId: "plan-result:plan-1:read", content: { kind: "plan_command", status: "completed", output: { found: true } } }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.command", payload: command },
        { type: "plan.observation", payload: { planCallId: "plan-1", observationId: command.observationId, content: command.content } },
        { type: "plan.command", payload: { ...command, observationId: "foreign", content: { ok: false } }, taskId: "child-1" },
        { type: "plan.command", payload: { ...command, observationId: "bad", content: "raw" } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: command.observationId, content: command.content }]))
    expect(value.snapshot.toolObservations.filter(item => item.id === command.observationId)).toHaveLength(1)
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"') && sql.includes("plan.command"))?.[0]
    expect(eventQuery).toContain("'plan.command'")
  })

  it("rejects a plan command receipt whose revision differs from the accepted plan revision", async () => {
    const command = { planCallId: "plan-1", planRevision: 2, observationId: "plan-result:plan-1:read", content: { kind: "plan_command", commandKind: "tool_call", status: "completed", output: { found: true } } }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: command },
      ],
    }), lease)
    expect(value.snapshot.toolObservations.some(item => item.id === command.observationId)).toBe(false)
  })

  it("rejects an unknown planCallId from the current plan scope and action count", async () => {
    const current = { revision: 2, objective: "Find senior jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const command = { planCallId: "current-plan", planRevision: 1, observationId: "plan-result:current-plan:read", content: { kind: "plan_command", commandKind: "tool_call", status: "completed", output: { found: true } } }
    const foreign = { ...command, planCallId: "foreign-plan", observationId: "plan-result:foreign-plan:read" }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "1", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      events: [
        { type: "goal.revision", payload: { goalRevision: 2, basedOnGoalRevision: 1, goalContract: current } },
        { type: "plan.revision", payload: { planCallId: "current-plan", goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: command },
        { type: "plan.command", payload: foreign },
      ],
    }), lease)
    expect(value.snapshot.toolObservations.some(item => item.id === command.observationId)).toBe(true)
    expect(value.snapshot.toolObservations.some(item => item.id === foreign.observationId)).toBe(false)
    expect(value.resume?.planActionCount).toBe(1)
  })

  it("rejects a plan command receipt without an accepted revision", async () => {
    const command = { planCallId: "accepted-plan", planRevision: 1, observationId: "plan-result:accepted-plan:read", content: { kind: "plan_command", commandKind: "tool_call", status: "completed", output: { found: true } } }
    const foreign = { ...command, planCallId: "unaccepted-plan", observationId: "plan-result:unaccepted-plan:read" }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "1", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      events: [
        { type: "plan.revision", payload: { planCallId: "accepted-plan", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: command },
        { type: "plan.command", payload: foreign },
      ],
    }), lease)
    expect(value.snapshot.toolObservations.some(item => item.id === command.observationId)).toBe(true)
    expect(value.snapshot.toolObservations.some(item => item.id === foreign.observationId)).toBe(false)
    expect(value.resume?.planActionCount).toBe(1)
  })

  it("preserves revision-one plan command receipts when no accepted revision metadata exists", async () => {
    const command = { planCallId: "legacy-plan", planRevision: 1, observationId: "plan-result:legacy-plan:read", content: { kind: "plan_command", commandKind: "tool_call", status: "completed", output: { found: true } } }
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "1", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      events: [{ type: "plan.command", payload: command }],
    }), lease)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: command.observationId, content: command.content }]))
    expect(value.resume?.planActionCount).toBe(1)
  })

  it("counts valid plan action receipts once across command and observation events", async () => {
    const read = { planCallId: "plan-1", planRevision: 1, observationId: "plan-result:plan-1:read", content: { kind: "plan_command", commandKind: "tool_call", status: "completed", errorCode: null } }
    const delegate = { planCallId: "plan-1", planRevision: 1, observationId: "plan-result:plan-1:delegate", content: { kind: "plan_command", commandKind: "delegate", status: "failed", errorCode: "router_execution_failed" } }
    const join = { planCallId: "plan-1", observationId: "plan-result:plan-1:join", content: { kind: "plan_command", commandKind: "join", status: "completed", errorCode: null } }
    const control = { planCallId: "plan-1", planRevision: 1, observationId: "plan-control:plan-1:ask", content: { kind: "plan_control", status: "waiting_for_user" } }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "1", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      events: [
        { type: "plan.command", payload: read },
        { type: "plan.observation", payload: read },
        { type: "plan.command", payload: delegate },
        { type: "plan.observation", payload: delegate },
        { type: "plan.observation", payload: join },
        { type: "plan.command", payload: control },
        { type: "plan.command", payload: { ...read, observationId: "invalid", planRevision: "bad" } },
        { type: "plan.command", taskId: "child-1", payload: { ...read, observationId: "foreign" } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.resume?.planActionCount).toBe(3)
  })

  it("falls back to a scoped legacy accepted plan receipt when no revision event exists", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [{ type: "tool_call.completed", payload: { toolCallId: "legacy-plan", toolName: "agent.plan.propose", output: { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: { schemaVersion: "agent-harness.plan.v1" }, intents: [] } } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.planRevision).toBe(1)
    expect(value.snapshot.toolObservations.some(item => item.id === "plan-revision:legacy-plan")).toBe(true)
  })

  it("uses the latest session snapshot and appends ordered role-tagged history after its cursor", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      inputs: [
        { id: "current-input", targetTurnId: "turn-1", content: [{ type: "text", text: "Continue" }], acceptedSequence: "7" },
        { id: "compacted-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Already summarized" }], acceptedSequence: "3" },
        { id: "new-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Use Dublin" }], acceptedSequence: "5" },
      ],
      items: [
        { id: "old-agent", turnId: "old-turn", type: "agent_message", status: "completed", content: { content: "Earlier reply" }, historyRole: "assistant", historySequence: "2" },
        { id: "new-agent", turnId: "old-turn", type: "agent_message", status: "completed", content: { text: "Current reply" }, historyRole: "assistant", historySequence: "6" },
      ],
      snapshots: [{ throughSequence: "4", version: 2, content: {
        schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "4", goal: "Continue",
        userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
        context: { system: [], profile: [], steerHistory: [{ id: "snapshot-history", content: "Compacted history" }], toolObservations: [] },
        tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
      } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.steerHistory).toEqual([
      { id: "snapshot-history", content: "Compacted history" },
      { id: "history:user:new-input", content: { role: "user", text: "Use Dublin" } },
      { id: "history:assistant:new-agent", content: { role: "assistant", text: "Current reply" } },
    ])
  })

  it("restores root rows while excluding child-private records and keeps legacy null rows", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [
        { taskId: "root-1", ordinal: 2, attempt: 1, inputThroughSequence: "4", consumedInputIds: [], inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 },
        { taskId: "child-1", ordinal: 3, attempt: 1, inputThroughSequence: "9", consumedInputIds: [], inputTokens: 50, outputTokens: 50, estimatedCostUsd: 5 },
        { taskId: null, ordinal: 4, attempt: 1, inputThroughSequence: "5", consumedInputIds: [], inputTokens: 2, outputTokens: 2, estimatedCostUsd: 0.02 },
      ],
      items: [
        { id: "root-message", turnId: "old-turn", taskId: "root-1", type: "agent_message", status: "completed", content: { text: "root history" }, historyRole: "assistant", historySequence: "5" },
        { id: "child-message", turnId: "old-turn", taskId: "child-1", type: "agent_message", status: "completed", content: { text: "private child" }, historySequence: "6" },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.resume).toMatchObject({ nextOrdinal: 5, stepCount: 2, usage: { inputTokens: 3, outputTokens: 3 } })
    expect(value.snapshot.steerHistory).toEqual([{ id: "history:assistant:root-message", content: { role: "assistant", text: "root history" } }])
    expect(JSON.stringify(value.snapshot)).not.toContain("private child")
    const stepQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_steps"') && !sql.includes('MAX'))
    expect(stepQuery?.[0]).toContain('"taskId" IS NULL OR "taskId" = $3')
  })

  it("projects a completed canonical question answer into the next context", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{
        id: `agent-wait:question:${questionId}`, taskId: "root-1", type: "question", status: "completed", revision: 1,
        content: { waitKind: "question", questionId, stage: "plan", question: "Where?", options: [], toolCallId: "plan-1", pending: true, answer: "Dublin", answerAvailable: true },
      }],
      events: [
        { type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: { planCallId: "plan-1", planRevision: 1, observationId: "plan-control:plan-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toContainEqual({ id: `question-answer:${questionId}`, content: expect.objectContaining({ kind: "question_answer", questionId, answer: "Dublin", answerAvailable: true }) })
    const itemQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_items"'))?.[0]
    expect(itemQuery).toContain("'question'")
  })

  it("fails closed when a question item is polluted with private plan metadata", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ id: `agent-wait:question:${questionId}`, taskId: "root-1", type: "question", status: "completed", revision: 1,
        content: { waitKind: "question", questionId, stage: "plan", question: "Where?", options: [], toolCallId: "plan-1", pending: true, answer: "Dublin", answerAvailable: true, planCallId: "spoof" } }],
      events: [{ type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: { planCallId: "plan-1", planRevision: 1, observationId: "plan-control:plan-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } } }],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("question_answer_replay_uncertain")
  })

  it("fails closed when question metadata cannot be mapped uniquely to durable plan receipts", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ id: `agent-wait:question:${questionId}`, taskId: "root-1", type: "question", status: "completed", revision: 1,
        content: { waitKind: "question", questionId, stage: "plan", question: "Where?", options: [], toolCallId: "plan-1", pending: true, answer: "Dublin", answerAvailable: true } }],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("question_answer_replay_uncertain")
  })

  it("rejects an answered value outside the persisted question options", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ id: `agent-wait:question:${questionId}`, taskId: "root-1", type: "question", status: "completed", revision: 1,
        content: { waitKind: "question", questionId, stage: "plan", question: "Where?", options: [{ value: "dublin", label: "Dublin" }], toolCallId: "plan-1", pending: true, answer: "Berlin", answerAvailable: true } }],
      events: [{ type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: { planCallId: "plan-1", planRevision: 1, observationId: "plan-control:plan-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } } }],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("question_answer_replay_uncertain")
  })

  it("does not treat a non-plan question item as a canonical plan answer", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ id: "agent-wait:question:gmail-oauth", taskId: "root-1", type: "question", status: "completed", content: { waitKind: "question", questionId: "gmail-oauth", stage: "oauth", question: "Reconnect Gmail", answer: "done", answerAvailable: true } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations.some(item => item.id === "question-answer:gmail-oauth")).toBe(false)
  })

  it("projects a consumed wait outcome into the next root context", async () => {
    const wait: { id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string; targetTaskIds: string[]; mode: string; status: string; matchedTaskIds: string[]; result: Record<string, unknown>; suspendedAt: Date; consumedAt: Date | null } = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "all", status: "ready", matchedTaskIds: ["child-1"], result: { request: { mode: "all" } }, suspendedAt: new Date("2026-09-09T00:00:00.000Z"), consumedAt: null }
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])")) return { rows: [{ id: "child-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1", role: "worker", status: "completed", result: { summary: "done" }, failureReason: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"') && sql.includes('SELECT "ordinal"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { wait.consumedAt = new Date(String(values?.[1])); wait.result = { ...wait.result, outcome: { waitId: "wait-1" } }; return { rows: [{ id: "wait-1" }], rowCount: 1 } }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: -1 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_events"') || sql.includes('FROM "agent_inputs"') || sql.includes('FROM "agent_context_snapshots"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const value = await loadCanonicalTurnState({ connect: vi.fn(async () => client) } as never, lease, new Date("2026-09-09T12:00:00.000Z"), { consumeWaitOutcomes: true })
    expect(value.snapshot.toolObservations).toEqual([expect.objectContaining({ id: "wait-result:wait-1", content: expect.objectContaining({ toolCallId: "wait:wait-1", input: { taskIds: ["child-1"], mode: "all" } }) })])
    expect(wait.consumedAt).not.toBeNull()
  })

  it("scopes a durable wait result to its proven historical plan revision", async () => {
    const wait: { id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string; targetTaskIds: string[]; mode: string; status: string; matchedTaskIds: string[]; result: Record<string, unknown>; suspendedAt: Date; consumedAt: Date | null } = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "all", status: "ready", matchedTaskIds: ["child-1"], result: { request: { mode: "all" } }, suspendedAt: new Date("2026-09-09T00:00:00.000Z"), consumedAt: null }
    const command = { planCallId: "plan-1", planRevision: 1, observationId: "plan-result:plan-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: [], status: "completed", errorCode: null, output: { status: "waiting", waitId: "wait-1" } } }
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])")) return { rows: [{ id: "child-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1", role: "worker", status: "completed", result: { summary: "done" }, failureReason: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"') && sql.includes('SELECT "ordinal"')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { wait.consumedAt = new Date(String(values?.[1])); wait.result = { ...wait.result, outcome: { waitId: "wait-1" } }; return { rows: [{ id: "wait-1" }], rowCount: 1 } }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: -1 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_inputs"') || sql.includes('FROM "agent_context_snapshots"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_events"')) return { rows: [
        { type: "plan.revision", payload: { planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
        { type: "plan.command", payload: command },
        { type: "plan.revision", payload: { planCallId: "plan-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
      ], rowCount: 3 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const value = await loadCanonicalTurnState({ connect: vi.fn(async () => client) } as never, lease, new Date("2026-09-09T12:00:00.000Z"), { consumeWaitOutcomes: true })
    const waitProjection = value.snapshot.toolObservations.find(item => item.id === "wait-result:wait-1")
    expect(waitProjection?.content).toMatchObject({ goalRevision: 1, planRevision: 1 })
    const memory = buildContextMemoryProjection({ ...value.snapshot, goal: { id: "goal-1", content: { revision: 1, objective: "Continue" } } })
    expect(memory?.revisions).toEqual({ goalRevision: 1, planRevision: 2 })
    expect(memory?.waits.some(item => item.id === "wait-result:wait-1")).toBe(false)
  })

  it("keeps a current-plan durable wait as current memory", () => {
    const projection = { id: "wait-result:current", content: { toolCallId: "wait:current", toolName: "agent.wait", status: "completed", output: { status: "ready" }, errorCode: null } }
    const scoped = scopeCanonicalWaitProjections([projection], [
      { type: "plan.revision", payload: { planCallId: "plan-current", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
      { type: "plan.command", payload: { planCallId: "plan-current", planRevision: 2, observationId: "plan-result:plan-current:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: [], status: "completed", errorCode: null, output: { status: "waiting", waitId: "current" } } } },
    ])
    expect(scoped[0]?.content).toMatchObject({ goalRevision: 1, planRevision: 2 })
    const memory = buildContextMemoryProjection({
      system: [], profile: [], goal: { id: "goal-1", content: { revision: 1, objective: "Continue" } }, steerHistory: [], businessRefs: [],
      toolObservations: [
        { id: "plan-revision:plan-current", content: { kind: "plan_revision", planCallId: "plan-current", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
        scoped[0]!,
      ],
    })
    expect(memory?.waits.map(item => item.id)).toEqual(["wait-result:current"])
  })

  it("leaves an ambiguously mapped legacy wait without guessed scope", () => {
    const projection = { id: "wait-result:legacy", content: { toolCallId: "wait:legacy", toolName: "agent.wait", status: "completed", output: { status: "ready" }, errorCode: null } }
    const events = [
      { type: "plan.revision", payload: { planCallId: "plan-one", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
      { type: "plan.revision", payload: { planCallId: "plan-two", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
      { type: "plan.command", payload: { planCallId: "plan-one", planRevision: 1, observationId: "plan-result:plan-one:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: [], status: "completed", errorCode: null, output: { status: "waiting", waitId: "legacy" } } } },
      { type: "plan.command", payload: { planCallId: "plan-two", planRevision: 2, observationId: "plan-result:plan-two:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: [], status: "completed", errorCode: null, output: { status: "waiting", waitId: "legacy" } } } },
    ]
    expect(scopeCanonicalWaitProjections([projection], events)).toEqual([projection])
  })
})
