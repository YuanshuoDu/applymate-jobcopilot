import { describe, expect, it, vi } from "vitest"

import { compareTranscriptGolden, legacyTranscriptData, projectV2EventToTranscript, projectV2EventsToTranscript, transcriptProjectionMarker } from "./transcript-projector"

const baseEvent = {
  id: "event_1",
  sessionId: "session_1",
  turnId: "turn_1",
  itemId: "item_1",
  taskId: null,
  actor: "orchestrator" as const,
  type: "item.completed",
  payload: {
    legacy: {
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Scout jobs",
      data: { plan: "Scout jobs" },
    },
  },
}

const goldenCases = [
  { flow: "chat", legacy: { type: "user_message", speaker: "You", title: "Message", body: "Find Berlin jobs", data: null } },
  { flow: "run", legacy: { type: "job_results", speaker: "Analyst", title: "Jobs", body: "N26", data: { jobs: [{ id: "job_1" }] } } },
  { flow: "automation", legacy: { type: "automation_started", speaker: "Orchestrator", title: "Started", body: "Morning run", data: { automationId: "automation_1" } } },
] as const

describe("V2 transcript projector", () => {
  it("reconstructs a legacy transcript row and adds a non-display marker", () => {
    const projected = projectV2EventToTranscript(baseEvent)

    expect(projected).toMatchObject({
      sessionId: "session_1",
      taskId: null,
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Scout jobs",
      data: { plan: "Scout jobs" },
    })
    expect(transcriptProjectionMarker(projected.data)).toEqual({ eventId: "event_1", opaque: false, wrapped: false })
  })

  it("does not discard an event whose legacy payload is absent", () => {
    const projected = projectV2EventToTranscript({ ...baseEvent, id: "event_2", type: "legacy.opaque", payload: { sourcePayload: { future: true } } })

    expect(projected).toMatchObject({ type: "error", speaker: "System", body: "Preserved an unrecognized agent event: legacy.opaque" })
    expect(projected.data).toMatchObject({ opaque: true, eventType: "legacy.opaque", payload: { future: true } })
    expect(transcriptProjectionMarker(projected.data)).toEqual({ eventId: "event_2", opaque: true, wrapped: false })
  })

  it("rejects direct transcript projection of private native verification events", () => {
    expect(() => projectV2EventToTranscript({
      ...baseEvent, type: "native_verification.scheduled_candidate_staged", taskId: "private-control-task",
      payload: { candidateText: "PRIVATE_SCHEDULED_FINAL_CANDIDATE", controlOperationId: "private-operation", evidencePacketDigest: "private-digest" },
    })).toThrow("private_native_verification_event_not_projectable")
  })

  it("rejects direct transcript projection of private planning receipts", () => {
    expect(() => projectV2EventToTranscript({
      ...baseEvent, type: "agent.plan.clarification", itemId: null,
      payload: { pendingSteers: [{ id: "private-steer-id" }], rationale: "private clarification receipt" },
    })).toThrow("private_native_verification_event_not_projectable")
  })

  it("rejects direct transcript projection of private reconciliation receipts", () => {
    expect(() => projectV2EventToTranscript({
      ...baseEvent, type: "agent.plan.reconciliation", itemId: null, taskId: "root-task-1",
      payload: {
        schemaVersion: "agent-harness.v2.plan-reconciliation.v1",
        sessionId: "session_1",
        turnId: "turn_1",
        rootTaskId: "root-task-1",
        stepId: "step-1",
        decision: "revise",
        observedRevision: 4,
        resultingRevision: 5,
        steerInputIds: ["private-reconciliation-steer-input"],
        inputCheckpoint: { throughSequence: "12" },
      },
    })).toThrow("private_native_verification_event_not_projectable")
  })

  it("rejects direct transcript projection of private denial checkpoints", () => {
    expect(() => projectV2EventToTranscript({
      ...baseEvent,
      type: "agent.plan.denial_checkpoint",
      itemId: null,
      taskId: "private-denial-task",
      payload: {
        schemaVersion: "agent-harness.v2.task-graph-denial-checkpoint.v1",
        taskId: "private-denial-task",
        stepId: "private-denial-step",
        graphRevision: 23,
        verificationDigest: "private-verification-digest",
      },
    })).toThrow("private_native_verification_event_not_projectable")
  })

  it.each([
    ["agent.plan.discovery_persona_snapshot", { projection: { facts: [{ value: "PRIVATE_DISCOVERY_FACT_VALUE" }] } }],
    ["agent.plan.discovery_persona_overflow", { rawValue: "PRIVATE_OVERFLOW_VALUE", observedFactCount: 33 }],
    ["agent.plan.root_task_history_session_authorization", { consentVersion: 12, enabled: true, snapshotKey: "PRIVATE_HISTORY_AUTHORIZATION_KEY" }],
    ["agent.plan.root_task_history_memory_snapshot", { snapshot: { id: "root-task-history", value: "PRIVATE_ROOT_TASK_HISTORY_VALUE" } }],
  ])("rejects transcript projection of private automatic-memory event %s", (type, payload) => {
    expect(() => projectV2EventToTranscript({ ...baseEvent, type, itemId: null, payload }))
      .toThrow("private_native_verification_event_not_projectable")
  })

  it.each(goldenCases)("keeps $flow golden transcript semantics stable", ({ flow, legacy }) => {
    const projected = projectV2EventToTranscript({
      ...baseEvent,
      id: `event-${flow}`,
      payload: { legacy },
    })

    expect(compareTranscriptGolden(legacy, projected)).toEqual({ matches: true, differences: [] })
  })

  it("restores scalar data without confusing an original legacyValue object", () => {
    const scalar = projectV2EventToTranscript({ ...baseEvent, id: "event-scalar", payload: { legacy: { ...goldenCases[0].legacy, data: "ok" } } })
    const object = projectV2EventToTranscript({ ...baseEvent, id: "event-object", payload: { legacy: { ...goldenCases[0].legacy, data: { legacyValue: "kept" } } } })

    expect(legacyTranscriptData(scalar.data)).toBe("ok")
    expect(legacyTranscriptData(object.data)).toEqual({ legacyValue: "kept" })
  })

  it("rebuilds only missing transcript rows under the session transaction", async () => {
    const event = {
      ...baseEvent,
      payload: { legacy: { type: "job_results", speaker: "Analyst", title: "Jobs", body: "N26", data: { jobs: 1 } } },
    }
    const transcriptCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ data }))
    const transcriptFindMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ data: (await projectV2EventToTranscript(event)).data }])
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "session_1" }]),
      agentEvent: { findMany: vi.fn().mockResolvedValue([event]) },
      agentTranscriptEvent: { findMany: transcriptFindMany, create: transcriptCreate },
    }
    const db = { $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx)) }

    await expect(projectV2EventsToTranscript(db as never, { sessionId: "session_1", userId: "user_1" })).resolves.toBe(1)
    await expect(projectV2EventsToTranscript(db as never, { sessionId: "session_1", userId: "user_1" })).resolves.toBe(0)
    expect(transcriptCreate).toHaveBeenCalledOnce()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("omits private verification, planning, reconciliation, and memory events during transcript rebuild", async () => {
    const privateEvent = {
      ...baseEvent, id: "private-event", itemId: null, taskId: "private-control-task",
      type: "native_verification.scheduled_candidate_staged",
      payload: { candidateText: "PRIVATE_SCHEDULED_FINAL_CANDIDATE", controlOperationId: "private-operation", evidencePacketDigest: "private-digest" },
    }
    const ordinaryEvent = {
      ...baseEvent, id: "ordinary-event",
      payload: { legacy: { type: "job_results", speaker: "Analyst", title: "Jobs", body: "N26", data: { jobs: 1 } } },
    }
    const clarificationEvent = {
      ...baseEvent, id: "private-clarification-event", itemId: null,
      type: "agent.plan.clarification",
      payload: { pendingSteerIds: ["private-steer-id"], rationale: "private clarification receipt" },
    }
    const reconciliationEvent = {
      ...baseEvent, id: "private-reconciliation-event", itemId: null, taskId: "root-task-1",
      type: "agent.plan.reconciliation",
      payload: {
        schemaVersion: "agent-harness.v2.plan-reconciliation.v1",
        sessionId: "session_1",
        turnId: "turn_1",
        rootTaskId: "root-task-1",
        stepId: "step-2",
        decision: "revise",
        observedRevision: 7,
        resultingRevision: 8,
        steerInputIds: ["private-reconciliation-steer-input-sentinel"],
        inputCheckpoint: { throughSequence: "19" },
      },
    }
    const denialCheckpointEvent = {
      ...baseEvent,
      id: "private-denial-checkpoint-event",
      itemId: null,
      taskId: "private-denial-task",
      type: "agent.plan.denial_checkpoint",
      payload: {
        schemaVersion: "agent-harness.v2.task-graph-denial-checkpoint.v1",
        taskId: "private-denial-task",
        stepId: "private-denial-step",
        graphRevision: 23,
        verificationDigest: "private-denial-digest-sentinel",
      },
    }
    const discoverySnapshotEvent = {
      ...baseEvent, id: "private-discovery-snapshot-event", itemId: null,
      type: "agent.plan.discovery_persona_snapshot",
      payload: { projection: { facts: [{ value: "PRIVATE_DISCOVERY_FACT_VALUE" }] } },
    }
    const discoveryOverflowEvent = {
      ...baseEvent, id: "private-discovery-overflow-event", itemId: null,
      type: "agent.plan.discovery_persona_overflow",
      payload: { observedFactCount: 33, rawValue: "PRIVATE_OVERFLOW_VALUE" },
    }
    const rootTaskHistoryAuthorizationEvent = {
      ...baseEvent, id: "private-root-task-history-authorization-event", itemId: null,
      type: "agent.plan.root_task_history_session_authorization",
      payload: { consentVersion: 12, enabled: true, snapshotKey: "PRIVATE_HISTORY_AUTHORIZATION_KEY" },
    }
    const rootTaskHistorySnapshotEvent = {
      ...baseEvent, id: "private-root-task-history-snapshot-event", itemId: null,
      type: "agent.plan.root_task_history_memory_snapshot",
      payload: { snapshot: { id: "root-task-history", value: "PRIVATE_ROOT_TASK_HISTORY_VALUE" } },
    }
    const finalRejectionEvent = {
      ...baseEvent,
      id: "public-final-rejection-event",
      itemId: null,
      taskId: "public-root-task",
      type: "final.rejected",
      payload: {
        code: "business_precondition_failed",
        blocker: "task_graph_verification_unverified",
        feedback: "Current task graph requirements are incomplete",
        taskId: "public-root-task",
      },
    }
    const transcriptCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ data }))
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "session_1" }]),
      agentEvent: { findMany: vi.fn().mockResolvedValue([
        privateEvent, clarificationEvent, reconciliationEvent, denialCheckpointEvent,
        discoverySnapshotEvent, discoveryOverflowEvent, rootTaskHistoryAuthorizationEvent,
        rootTaskHistorySnapshotEvent, finalRejectionEvent, ordinaryEvent,
      ]) },
      agentTranscriptEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        create: transcriptCreate,
      },
    }
    const db = { $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx)) }

    await expect(projectV2EventsToTranscript(db as never, { sessionId: "session_1", userId: "user_1" })).resolves.toBe(2)
    expect(transcriptCreate).toHaveBeenCalledTimes(2)
    expect(transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "job_results", speaker: "Analyst", body: "N26" }),
    }))
    const createdTranscriptRows = transcriptCreate.mock.calls.map(([input]) => input.data)
    const serializedTranscriptRows = JSON.stringify(createdTranscriptRows)
    expect(serializedTranscriptRows).toContain("final.rejected")
    expect(serializedTranscriptRows).toContain("task_graph_verification_unverified")
    expect(serializedTranscriptRows).toContain("Current task graph requirements are incomplete")
    expect(serializedTranscriptRows).not.toContain("agent.plan.denial_checkpoint")
    expect(serializedTranscriptRows).not.toContain("private-denial-checkpoint-event")
    expect(serializedTranscriptRows).not.toContain("private-denial-task")
    expect(serializedTranscriptRows).not.toContain("private-denial-step")
    expect(serializedTranscriptRows).not.toContain("private-denial-digest-sentinel")
    expect(serializedTranscriptRows).not.toContain("agent.plan.discovery_persona_snapshot")
    expect(serializedTranscriptRows).not.toContain("agent.plan.discovery_persona_overflow")
    expect(serializedTranscriptRows).not.toContain("agent.plan.root_task_history_session_authorization")
    expect(serializedTranscriptRows).not.toContain("agent.plan.root_task_history_memory_snapshot")
    expect(serializedTranscriptRows).not.toContain("PRIVATE_DISCOVERY_FACT_VALUE")
    expect(serializedTranscriptRows).not.toContain("PRIVATE_OVERFLOW_VALUE")
    expect(serializedTranscriptRows).not.toContain("PRIVATE_HISTORY_AUTHORIZATION_KEY")
    expect(serializedTranscriptRows).not.toContain("PRIVATE_ROOT_TASK_HISTORY_VALUE")
    expect(serializedTranscriptRows).not.toContain("task-graph-denial-checkpoint.v1")
    expect(serializedTranscriptRows).not.toContain("private-event")
    expect(serializedTranscriptRows).not.toContain("PRIVATE_SCHEDULED_FINAL_CANDIDATE")
    expect(serializedTranscriptRows).not.toContain("private-clarification-event")
    expect(serializedTranscriptRows).not.toContain("private-reconciliation-event")
    expect(serializedTranscriptRows).not.toContain("private-root-task-history-authorization-event")
    expect(serializedTranscriptRows).not.toContain("private-root-task-history-snapshot-event")
    expect(serializedTranscriptRows).not.toContain("private-steer-id")
    expect(serializedTranscriptRows).not.toContain("private-reconciliation-steer-input-sentinel")
    expect(serializedTranscriptRows).not.toContain("root-task-1")
  })
})
