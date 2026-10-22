import { describe, expect, it, vi } from "vitest"

import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { sha256Hex } from "./context/context-compaction-canonical.js"
import { projectSelectedJobMemory } from "./context/selected-job-memory.js"
import { contextToModelMessages } from "./turns/turn-engine-messages.js"
import { STEERING_MARKER_EVENT_TYPE, steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "./context/steering-marker.js"
import { buildCognitiveActionAgenda } from "./turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE, cognitiveAgendaReceiptIdempotencyKey } from "./turns/cognitive-agenda-receipt.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_EVENT_TYPE } from "./turns/task-graph-denial-resume.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA } from "./turns/task-graph-terminal-assessment.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { InputContentPart } from "@jobcopilot/agent-protocol/input"
import { StepContextBuilder, type ContextHistoryEntry } from "./context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { buildModelRequest } from "./turns/turn-engine-messages.js"
import { NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA, digestNativeVerificationValue, type NativeVerificationControl, type NativeVerificationPacket } from "./subagents/native-verification-contract.js"
import { createNativeVerificationContext } from "./subagents/native-verification-packet.js"
import { attachNativeVerificationReport, parseNativeVerificationModelReport } from "./subagents/native-verification-report.js"

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
function agendaEvent(sequence = "20", patch: Record<string, unknown> = {}, fence?: { inputThroughSequence: bigint; consumedInputIds: readonly string[] }): Record<string, unknown> {
  const value = buildCognitiveAgendaReceipt({ sessionId: "session-1", turnId: "turn-1", taskId: "root-1", stepId: "step-1", ...(fence ?? {}), agenda: buildCognitiveActionAgenda({ schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", inputThroughSequence: 1n, consumedInputIds: [], canonicalJson: "{}", blocks: [] }) })
  if (!value) throw new Error("agenda fixture should be valid")
  return { id: `agenda-${sequence}`, type: COGNITIVE_AGENDA_EVENT_TYPE, actor: "system", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null, sequence, payload: { ...value, ...patch } }
}

function pool(rows: { turn?: Record<string, unknown>; steps?: Record<string, unknown>[]; items?: Record<string, unknown>[]; questionItems?: Record<string, unknown>[]; inputs?: Record<string, unknown>[]; events?: Record<string, unknown>[]; questionEvents?: Record<string, unknown>[]; snapshots?: Record<string, unknown>[]; nativeRoots?: Record<string, unknown>[]; historyTurns?: Record<string, unknown>[]; nativeControls?: Record<string, unknown>[]; steerGuard?: unknown; priorTurns?: Record<string, unknown>[]; priorQuestions?: Record<string, unknown>[]; priorCalls?: Record<string, unknown>[]; priorSteps?: Record<string, unknown>[]; priorQuestionEvents?: Record<string, unknown>[] }) {
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('SELECT EXISTS') && sql.includes('FROM "agent_inputs"')) return { rows: [{ hasSteer: Object.hasOwn(rows, "steerGuard") ? rows.steerGuard : false }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: rows.nativeRoots ?? [], rowCount: rows.nativeRoots?.length ?? 0 }
    if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('JOIN "sub_agent_tasks" AS root')) return { rows: rows.historyTurns ?? [], rowCount: rows.historyTurns?.length ?? 0 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: rows.nativeControls ?? [], rowCount: rows.nativeControls?.length ?? 0 }
    if (sql.includes('SELECT active_turn."createdAt"')) return { rows: [{ createdAt: new Date("2026-10-07T00:00:00.000Z") }], rowCount: 1 }
    if (sql.includes('SELECT prior."id"')) return { rows: rows.priorTurns ?? [], rowCount: rows.priorTurns?.length ?? 0 }
    if (sql.includes('SELECT "id" FROM "agent_turns"') && sql.includes('"rootTaskId"')) {
      const owned = rows.turn && rows.turn.rootTaskId === values?.[3]
      return { rows: owned ? [{ id: "turn-1" }] : [], rowCount: owned ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_items" AS question')) return { rows: rows.priorQuestions ?? [], rowCount: rows.priorQuestions?.length ?? 0 }
    if (sql.includes('FROM "agent_items" AS call')) return { rows: rows.priorCalls ?? [], rowCount: rows.priorCalls?.length ?? 0 }
    if (sql.includes('FROM "agent_steps" AS step')) return { rows: rows.priorSteps ?? [], rowCount: rows.priorSteps?.length ?? 0 }
    if (sql.includes('FROM "agent_items" AS item') && values?.[1] === "prior-turn") return { rows: rows.priorQuestions ?? [], rowCount: rows.priorQuestions?.length ?? 0 }
    if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: rows.turn ? [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, createdAt: new Date("2026-10-06T10:00:00.000Z"), ...rows.turn }] : [], rowCount: rows.turn ? 1 : 0 }
    if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: Math.max(...(rows.steps ?? []).map(step => Number(step.ordinal ?? -1)), -1) }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: (rows.steps ?? []).filter(step => step.taskId === undefined || step.taskId === null || step.taskId === values?.[2]), rowCount: rows.steps?.length ?? 0 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = ANY')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_events"') && sql.includes('event."itemId" = ANY')) {
      const result = values?.[1] === "prior-turn" ? rows.priorQuestionEvents ?? [] : rows.questionEvents ?? []
      return { rows: result, rowCount: result.length }
    }
    if (sql.includes('FROM "agent_events"')) {
      const readsToolStarts = sql.includes("'tool_call.started'")
      const nullsToolStartPayload = sql.includes("'tool_call.started') THEN NULL")
      const projected = (rows.events ?? []).filter(event => (event.type !== "tool_call.started" || readsToolStarts)
        && (event.taskId === undefined || event.taskId === null || event.taskId === values?.[2]))
        .map(event => event.type === "tool_call.started" && nullsToolStartPayload ? { ...event, payload: null } : event)
      return { rows: projected, rowCount: projected.length }
    }
    if (sql.includes('FROM "agent_items"')) {
      if (sql.includes('item."type" = \'question\'')) return { rows: rows.questionItems ?? [], rowCount: rows.questionItems?.length ?? 0 }
      const filtered = sql.includes('item_task') ? (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === "root-1") : (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === values?.[2])
      return { rows: filtered, rowCount: filtered.length }
    }
    if (sql.includes('FROM "agent_context_snapshots"')) {
      const snapshots = rows.snapshots ?? []
      const selected = sql.includes('WHERE snapshot."id" = $1')
        ? snapshots.filter(snapshot => snapshot.id === values?.[0])
        : snapshots
      return { rows: selected, rowCount: selected.length }
    }
    if (sql.includes('FROM "agent_inputs"')) {
      if (sql.includes('AS "historyRole"')) {
        const history = (rows.inputs ?? []).filter(input => {
          const isPriorTarget = typeof input.targetTurnId === "string" && input.targetTurnId !== values?.[2]
          const pendingFollowUp = input.delivery === "follow_up" && (input.status === "accepted" || input.status === "queued")
            && input.consumedByStepId == null && input.consumedAt == null && input.cancelledAt == null
          return isPriorTarget && !pendingFollowUp
        }).map(input => ({ ...input, historyRole: "user", historySequence: input.acceptedSequence }))
        return { rows: history, rowCount: history.length }
      }
      return { rows: rows.inputs ?? [], rowCount: rows.inputs?.length ?? 0 }
    }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  return { connect: vi.fn(async () => client), client } as unknown as Pick<import("pg").Pool, "connect"> & { client: typeof client }
}

function nativeHistoryControl(goal = "Find jobs", requirement = "Use verified job facts") {
  const taskId = "private-control-task", turnId = "history-turn", rootTaskId = "history-root"
  const packet: NativeVerificationPacket = {
    schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: "private-operation", controlTaskId: taskId, goal,
    criteria: [{ criterionId: "criterion-1", requirement }],
    target: { kind: "root_goal", candidateDigest: digestNativeVerificationValue("PRIVATE_CANDIDATE"), referenceId: "private-candidate-ref", candidateText: "PRIVATE_CANDIDATE" },
    evidence: [{ referenceId: "private-evidence-ref", kind: "artifact", summary: "PRIVATE_PACKET_SUMMARY" }],
  }
  const control: NativeVerificationControl = {
    schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: taskId,
    owner: { userId: "user-1", sessionId: "session-1", turnId, rootTaskId, parentTaskId: rootTaskId },
    target: { kind: "root_goal", candidateDigest: packet.target.kind === "root_goal" ? packet.target.candidateDigest : "", childBindingSetDigest: "a".repeat(64) },
    goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria), evidencePacketDigest: digestNativeVerificationValue(packet),
  }
  const modelReport = parseNativeVerificationModelReport({ schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, criteria: [
    { criterionId: "criterion-1", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: ["private-candidate-ref"] },
  ] }, packet)!
  return {
    id: taskId, userId: "user-1", sessionId: "session-1", turnId, rootTaskId, parentTaskId: rootTaskId,
    role: "auditor", taskType: "native_verification", status: "completed", attemptCount: 1, failureReason: null,
    expectedOutputSchema: control, context: createNativeVerificationContext(packet),
    result: { nativeVerificationReport: attachNativeVerificationReport(control, 1, modelReport) },
  }
}

describe("loadCanonicalTurnState", () => {
  it("restores the fenced Turn source and exact flat automation run mode", async () => {
    const scheduledSnapshotMarker = "PRIVATE_SCHEDULED_AUTOMATION_SNAPSHOT"
    const cases: Array<{ name: string; source: string; input: Record<string, unknown>; expectedMode?: "scheduled" | "manual" }> = [
      { name: "scheduled automation", source: "automation", input: { goal: "Run scheduled automation", automationRunMode: "scheduled", scheduledAutomationSnapshot: { marker: scheduledSnapshotMarker } }, expectedMode: "scheduled" },
      { name: "manual automation", source: "automation", input: { goal: "Run manual automation", automationRunMode: "manual" }, expectedMode: "manual" },
      { name: "missing run mode", source: "automation", input: { goal: "Run automation" } },
      { name: "unknown run mode", source: "automation", input: { goal: "Run automation", automationRunMode: "adhoc" } },
      { name: "ordinary user turn", source: "user", input: { goal: "Find jobs" } },
    ]

    for (const testCase of cases) {
      const fake = pool({ turn: { source: testCase.source, input: testCase.input, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} } })
      const value = await loadCanonicalTurnState(fake, lease)
      expect(value.source, testCase.name).toBe(testCase.source)
      expect(value.turnInput, testCase.name).toEqual(testCase.input)
      if (testCase.expectedMode) expect(value.automationRunMode, testCase.name).toBe(testCase.expectedMode)
      else expect(value).not.toHaveProperty("automationRunMode")
      if (testCase.name === "scheduled automation") {
        expect(JSON.stringify(value.snapshot)).not.toContain(scheduledSnapshotMarker)
        const turnQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_turns"'))?.[0]
        expect(turnQuery).toContain('SELECT "id", "sessionId", "userId", "source", "status"')
        expect(turnQuery).toContain('"input", "rootTaskId"')
        expect(turnQuery).toContain('"leaseOwnerId" = $4')
        expect(turnQuery).toContain('"leaseVersion" = $5')
        expect(turnQuery).toContain('"leaseExpiresAt" > $6')
        expect(turnQuery).toContain("FOR UPDATE")
      }
    }
  })

  it("keeps answered Q/A beside exact-goal historical verifier advice across reload", async () => {
    const control = nativeHistoryControl()
    const content: InputContentPart[] = [{ type: "text", text: "Find jobs" }]
    const ordinary = { id: "history:user:prior-note", content: { role: "user", text: "Keep ordinary history" } }
    const stale = { id: "native-verification-advisory:0", content: { type: "historical_native_verification_advisory", goal: "Old goal" } }
    const snapshot = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "4", goal: "Find jobs",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [],
      references: [], consumedInputIds: [], context: { system: [], profile: [], steerHistory: [ordinary, stale], toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const options = {
      turn: { input: { goal: "Find jobs", content, clientMessageId: "command-1" }, rootTaskId: "current-root", contextSnapshotId: "snapshot-1", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ id: "current-step", taskId: "current-root", ordinal: 0, inputThroughSequence: "0", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      items: [
        { id: "current-call-item", sessionId: "session-1", turnId: "turn-1", taskId: "current-root", stepId: "current-step", type: "tool_call", status: "completed", revision: 1,
          content: { toolCallId: "current-call", toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null, input: { question: "Which city?", options: [] } } },
        { id: "current-result-item", sessionId: "session-1", turnId: "turn-1", taskId: "current-root", stepId: "current-step", type: "tool_result", status: "completed", revision: 1,
          content: { toolCallId: "current-call", output: { questionId: "current-wait", question: "Which city?", answer: "Dublin" }, errorCode: null, status: "completed" } },
      ],
      questionItems: [{ id: "current-question", revision: 1, userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
        stepId: "current-step", type: "question", status: "completed", content: { waitKind: "question", stage: "user_input", questionId: "current-wait", toolCallId: "current-call",
          question: "Which city?", options: [], answer: "Dublin", answerAvailable: true } }],
      questionEvents: [
        { id: "current-question-start", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null, itemId: "current-question",
          type: "item.started", actor: "orchestrator", sequence: "10", correlationId: "current-question", causationId: "current-wait",
          payload: { itemId: "current-question", waitKind: "question", toolCallId: "current-call" } },
        { id: "current-question-answer", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null, itemId: "current-question",
          type: "question.answered", actor: "user", sequence: "11", correlationId: "current-wait", causationId: "current-question",
          payload: { waitKind: "question", waitId: "current-wait", itemId: "current-question", turnId: "turn-1", toolCallId: "current-call", status: "answered" } },
      ],
      snapshots: [{ id: "snapshot-1", throughSequence: "4", version: 1, content: snapshot }],
      nativeRoots: [{ goal: "Find jobs", successCriteria: ["Use verified job facts"] }],
      historyTurns: [{ id: "history-turn", rootTaskId: "history-root", startedSequence: "3", currentStartedSequence: "5", createdAt: new Date("2026-10-06T09:00:00.000Z") }], nativeControls: [control],
    }
    const first = await loadCanonicalTurnState(pool(options), lease)
    expect(first.turnInput).toEqual(options.turn.input)
    expect(first.snapshot.steerHistory).toEqual([
      ordinary,
      { id: "agent-question:current-question:question", content: { role: "assistant", type: "question", question: "Which city?", options: [] } },
      { id: "agent-question:current-question:answer", content: { role: "user", type: "answer", questionId: "current-wait", text: "Dublin" } },
      expect.objectContaining({ id: "native-verification-advisory:0", content: expect.objectContaining({
        type: "historical_native_verification_advisory", label: "Historical advisory only", goal: "Find jobs",
        criterionId: "criterion-1", requirement: "Use verified job facts", disposition: "failed", reasonCode: "does_not_meet_criterion",
      }) }),
    ])
    const advice = first.snapshot.steerHistory.find(item => item.id.startsWith("native-verification-advisory:"))!
    const persisted = { ...snapshot, context: { ...snapshot.context, steerHistory: [...first.snapshot.steerHistory, { ...advice, id: "native-verification-advisory:1" }].sort((left, right) => left.id.localeCompare(right.id)) } }
    const reloaded = await loadCanonicalTurnState(pool({ ...options, snapshots: [{ id: "snapshot-1", throughSequence: "4", version: 2, content: persisted }] }), lease)
    expect(reloaded.snapshot.steerHistory.filter(item => item.id.startsWith("native-verification-advisory:"))).toHaveLength(1)
    expect(reloaded.snapshot.steerHistory).toEqual([
      { id: "agent-question:current-question:question", content: { role: "assistant", type: "question", question: "Which city?", options: [] } },
      { id: "agent-question:current-question:answer", content: { role: "user", type: "answer", questionId: "current-wait", text: "Dublin" } },
      ordinary,
      expect.objectContaining({ id: "native-verification-advisory:0" }),
    ])
    for (const collision of [
      { id: "agent-question:current-question:question", content: { role: "assistant", type: "question", question: "Changed?", options: [] } },
      { id: "agent-question:current-question:answer", content: { role: "user", type: "answer", questionId: "current-wait", text: "Changed" } },
      { id: "agent-question:current-question:question", content: { role: "assistant", type: "narrative", question: "Which city?", options: [] } },
    ]) {
      const steerHistory: ContextHistoryEntry[] = persisted.context.steerHistory.map(entry =>
        entry.id === collision.id ? { ...entry, content: collision.content } : entry)
      const changedSnapshot = { ...persisted, context: { ...persisted.context, steerHistory } }
      await expect(loadCanonicalTurnState(pool({ ...options, snapshots: [{ id: "snapshot-1", throughSequence: "4", version: 2, content: changedSnapshot }] }), lease))
        .rejects.toThrow("question_recovery_history_collision")
    }
    const claimStore: InputClaimStore = {
      scope: { userId: "user-1" }, async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
        return work({ getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }), claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }), persistCheckpoint: async () => undefined })
      },
    }
    const context = await new StepContextBuilder(claimStore).build({ scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", snapshot: reloaded.snapshot })
    const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({ context, model, tools: [], sessionId: "session-1", turnId: "turn-1", stepId: "step-1", userId: "user-1", taskId: "root-1", signal: new AbortController().signal })
    const requestText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    expect(requestText).toContain("trust=UNTRUSTED_DATA")
    expect(requestText).toContain("Which city?")
    expect(requestText).toContain("Dublin")
    expect(requestText).toContain("Historical advisory only")
    expect(requestText).toContain("Use verified job facts")
    expect(requestText).not.toMatch(/PRIVATE_CANDIDATE|PRIVATE_PACKET_SUMMARY|private-control-task|evidencePacketDigest|controlOperationId/)

    const changed = await loadCanonicalTurnState(pool({
      ...options, turn: { ...options.turn, input: { goal: "Different goal", content: [{ type: "text", text: "Different goal" }], clientMessageId: "command-2" } },
      snapshots: [{ id: "snapshot-1", throughSequence: "4", version: 3, content: persisted }],
    }), lease)
    expect(changed.snapshot.steerHistory.filter(item => item.id.startsWith("native-verification-advisory:"))).toEqual([])

    const fresh = await loadCanonicalTurnState(pool({
      ...options,
      turn: { ...options.turn, rootTaskId: null, input: { goal: "Find jobs", content, clientMessageId: "command-3" } },
      steps: [], items: [], questionItems: [], questionEvents: [],
      nativeRoots: [], nativeControls: [nativeHistoryControl("Find jobs", "Find jobs")],
    }), lease)
    expect(fresh.snapshot.steerHistory).toEqual([
      ordinary,
      expect.objectContaining({ id: "native-verification-advisory:0", content: expect.objectContaining({
        goal: "Find jobs", criterionId: "criterion-1", requirement: "Find jobs", disposition: "failed",
      }) }),
    ])
  })

  it("hydrates durable compaction state from the persisted snapshot after a Worker restart", async () => {
    const selectedJobMemories = [projectSelectedJobMemory({ jobId: "job-1", sourceTurnId: "turn-1", sourceRootTaskId: "root-1", throughSequence: "7",
      graph: { revision: 1, nodes: [{ templateId: "analyst", status: "completed", readiness: "terminal" }] } })!]
    const state = {
      ownerId: "user-1", sessionId: "session-1", throughSequence: "7", goal: "Search Dublin roles", userConstraints: ["Dublin only"],
      approvals: [{ id: "approval-1", status: "pending" }],
      answers: [{ id: "answer-1", question: "Work authorization?", answer: "Confirmed" }],
      artifacts: [{ id: "artifact-1", type: "resume", hash: "sha256:artifact" }],
      openTasks: [{ taskId: "task-1", status: "running", blocker: null }], doNotRepeat: ["repeat rejection"],
      facts: [{ factId: "fact-1", key: "target_role", source: "persona_fact:fact-1" }],
      selectedJobMemories,
    }
    const summary = "Only a short narrative summary"
    const measurement = { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }
    const sourceItemIds = ["item-1"]
    const itemId = "compaction-1"
    const compaction = { itemId, digest: sha256Hex({ state, summary, measurement, sourceItemIds, itemId }), state, narrativeSummary: summary, tokenMeasurement: measurement, sourceItemIds }
    const snapshot = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "7", goal: "Stale goal",
      userConstraints: ["stale constraint"], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [],
      references: [], consumedInputIds: [], context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 }, compaction,
    }
    const fake = pool({
      turn: { input: { goal: "Continue search" }, rootTaskId: null, contextSnapshotId: "snapshot-1", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      snapshots: [{ id: "snapshot-1", throughSequence: "7", version: 1, content: snapshot }],
    })

    const restored = await loadCanonicalTurnState(fake, lease)
    expect(restored.selectedJobMemories).toEqual(selectedJobMemories)
    expect(restored.snapshot.toolObservations).toEqual([expect.objectContaining({
      id: "snapshot-working-state:session-1:7",
      content: expect.objectContaining({
        status: "available", authority: "informational_only", goal: "Search Dublin roles", userConstraints: ["Dublin only"],
        openWork: [{ taskId: "task-1", status: "running", blocker: null }],
        approvalState: expect.objectContaining({
          source: "compaction_state", entries: [{ id: "approval-1", status: "pending" }], freshness: "compaction_state", grantsActionAuthority: false,
        }),
      }),
    })])
    expect(restored.snapshot.toolObservations[0]?.id).not.toContain("narrative")
    expect(JSON.stringify(restored.snapshot.toolObservations)).not.toContain("selected_job_memory")
    const claimStore: InputClaimStore = {
      scope: { userId: "user-1" },
      async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
        return work({
          getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
          claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
          persistCheckpoint: async () => undefined,
        })
      },
    }
    const step = await new StepContextBuilder(claimStore).build({
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", snapshot: restored.snapshot, now: new Date(0),
    })
    const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({ context: step, model, tools: [], sessionId: "session-1", turnId: "turn-1", stepId: "step-1", userId: "user-1", taskId: "root-1", signal: new AbortController().signal })
    const requestText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    expect(requestText).toContain("context_snapshot_working_state")
    expect(requestText).toContain("Search Dublin roles")
    expect(requestText).toContain("UNTRUSTED_DATA")
  })

  it("fails closed when a loaded snapshot cursor disagrees with its database cursor", async () => {
    const content = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "7", goal: "Continue",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [],
      references: [], consumedInputIds: [], context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    for (const pinned of [true, false]) {
      const fake = pool({
        turn: { input: { goal: "Continue" }, rootTaskId: null, contextSnapshotId: pinned ? "snapshot-1" : null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
        snapshots: [{ id: "snapshot-1", throughSequence: "6", version: 1, content }],
      })
      await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("context_snapshot_sequence_mismatch")
    }
  })

  it("restores only the exact server-owned interactive-discovery intent", async () => {
    const exact = pool({ turn: { input: { goal: "Find jobs", intent: { kind: "interactive_discovery_shortlist", version: 1 } }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} } })
    await expect(loadCanonicalTurnState(exact, lease)).resolves.toMatchObject({
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })

    for (const intent of [undefined, { kind: "interactive_discovery_shortlist", version: 2 }, { kind: "interactive_discovery_shortlist", version: 1, userControlled: true }, { kind: "other", version: 1 }]) {
      const value = pool({ turn: { input: { goal: "Find jobs", ...(intent ? { intent } : {}) }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} } })
      await expect(loadCanonicalTurnState(value, lease)).resolves.not.toHaveProperty("intent")
    }
  })

  it("projects a fenced answered question once into recovered steer history", async () => {
    const question = { id: "question-item", type: "question", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
      stepId: null, status: "completed", content: { waitKind: "question", questionId: "question-1", toolCallId: "question-call-1", question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: "yes", answerAvailable: true } }
    const events = [
      { id: "started", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null, itemId: "question-item",
        type: "item.started", actor: "orchestrator", sequence: "10", correlationId: "question-item", causationId: "question-1",
        payload: { itemId: "question-item", waitKind: "question", questionId: "[REDACTED]", toolCallId: "question-call-1" } },
      { id: "answered", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null, itemId: "question-item",
        type: "question.answered", actor: "user", sequence: "11", correlationId: "question-1", causationId: "question-item",
        payload: { waitKind: "question", waitId: "question-1", itemId: "question-item", turnId: "turn-1", toolCallId: "question-call-1", status: "answered", answerAvailable: "[REDACTED]" } },
    ]
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ id: "step-1", taskId: "root-1", ordinal: 0, inputThroughSequence: "0", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      items: [{ id: "tool-call-item", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", stepId: "step-1", type: "tool_call", status: "started", revision: 0,
        content: { toolCallId: "question-call-1", toolName: "jobs.search", input: { query: "engineer" }, status: "completed" } }],
      questionItems: [question], questionEvents: events,
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.steerHistory).toEqual([
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "question-1", text: "yes" } },
    ])
    expect(value.snapshot.planningClarifications).toEqual([])
    const [questionQuery, eventQuery] = fake.client.query.mock.calls.filter(([sql]) => typeof sql === "string" && (sql.includes('item."type" = \'question\'') || sql.includes('event."itemId" = ANY'))).map(([sql]) => sql)
    expect(questionQuery).toContain('session."userId" = $3')
    expect(questionQuery).toContain('turn."userId" = $3')
    expect(questionQuery).toContain('(item."taskId" IS NULL OR item."taskId" = $4)')
    expect(eventQuery).toContain('(event."taskId" IS NULL OR event."taskId" = $4)')
    expect(eventQuery).toContain("'question.answered'")
    const orderedToolItemsQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("'tool_call', 'tool_result'"))?.[0]
    expect(orderedToolItemsQuery).toContain('ORDER BY "createdAt" ASC, "id" ASC')
    expect(value.snapshot).not.toHaveProperty("planningClarificationHistoryPair")
  })

  it("restores a complete earlier root answer after compaction as untrusted model history without replacing the current goal", async () => {
    const answer = "I prefer Dublin roles — escaped \"detail\" stays intact."
    const priorTurn = { id: "prior-turn", sessionId: "session-1", userId: "user-1", rootTaskId: "prior-root",
      status: "completed", createdAt: new Date("2026-09-20T00:00:00.000Z") }
    const priorQuestion = { id: "prior-question", revision: 1, userId: "user-1", turnUserId: "user-1", sessionId: "session-1",
      turnId: "prior-turn", taskId: "prior-root", stepId: "prior-step", type: "question", status: "completed",
      content: { stage: "user_input", waitKind: "question", questionId: "prior-wait", toolCallId: "prior-call",
        question: "Which location should I prioritize?", options: [{ label: "Dublin", value: "dublin" }], answer, answerAvailable: true } }
    const priorCall = { id: "prior-call-item", stepId: "prior-step", taskId: "prior-root", type: "tool_call", status: "completed",
      content: { toolCallId: "prior-call", toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null } }
    const priorEvents = [
      { id: "prior-start", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "prior-turn", taskId: "prior-root",
        itemId: "prior-question", actor: "orchestrator", sequence: "10", type: "item.started", correlationId: "prior-question", causationId: "prior-wait",
        payload: { itemId: "prior-question", waitKind: "question", toolCallId: "prior-call" } },
      { id: "prior-answer", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "prior-turn", taskId: null,
        itemId: "prior-question", actor: "user", sequence: "11", type: "question.answered", correlationId: "prior-wait", causationId: "prior-question",
        payload: { waitKind: "question", waitId: "prior-wait", itemId: "prior-question", turnId: "prior-turn", toolCallId: "prior-call", status: "answered" } },
    ]
    const compactedHistory = [{ id: "compacted-history", content: { role: "user", text: "Earlier narrative summary" } }]
    const snapshot = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "7", goal: "Old objective",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [],
      references: [], consumedInputIds: [], context: { system: [], profile: [], steerHistory: compactedHistory, toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const fake = pool({
      turn: { input: { goal: "Find roles matching my current profile" }, rootTaskId: "root-current", contextSnapshotId: "snapshot-pinned",
        modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      snapshots: [{ id: "snapshot-pinned", throughSequence: "7", version: 1, content: snapshot }],
      priorTurns: [priorTurn], priorQuestions: [priorQuestion], priorCalls: [priorCall], priorSteps: [{ id: "prior-step", taskId: "prior-root" }],
      priorQuestionEvents: priorEvents,
    })

    const restored = await loadCanonicalTurnState(fake, lease)

    expect(restored.goal).toBe("Find roles matching my current profile")
    expect(restored.snapshot.goal).toEqual({ id: "turn-goal:turn-1", content: "Find roles matching my current profile" })
    expect(restored.snapshot.steerHistory).toEqual([
      ...compactedHistory,
      { id: "agent-question:prior-question:question", content: { role: "assistant", type: "question", question: "Which location should I prioritize?", options: [{ label: "Dublin", value: "dublin" }] } },
      { id: "agent-question:prior-question:answer", content: { role: "user", type: "answer", questionId: "prior-wait", text: answer } },
    ])
    const claimStore: InputClaimStore = {
      scope: { userId: "user-1" },
      async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
        return work({ getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
          claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }), persistCheckpoint: async () => undefined })
      },
    }
    const stepContext = await new StepContextBuilder(claimStore).build({
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-current", snapshot: restored.snapshot, now: new Date(0),
    })
    const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({ context: stepContext, model, tools: [], sessionId: "session-1", turnId: "turn-1",
      stepId: "step-current", userId: "user-1", taskId: "root-current", signal: new AbortController().signal })
    const prompt = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    expect(prompt).toContain("trust=UNTRUSTED_DATA")
    expect(prompt).toContain("Which location should I prioritize?")
    expect(prompt).toContain("I prefer Dublin roles — escaped")
    expect(prompt).toContain("stays intact.")
    expect(prompt.match(/I prefer Dublin roles/g)).toHaveLength(1)
  })

  it("keeps canonical model history unchanged when no persisted answer event matches", async () => {
    const history = [{ id: "snapshot-history", content: { role: "user", text: "Existing baseline context" } }]
    const pending = { id: "pending-question", type: "question", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
      stepId: null, status: "started", content: { waitKind: "question", questionId: "question-pending", toolCallId: "call-1",
        question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: null, answerAvailable: false } }
    const snapshot = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "4", goal: "Continue",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
      context: { system: [], profile: [], steerHistory: history, toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: "snapshot-1", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      questionItems: [pending], questionEvents: [], snapshots: [{ id: "snapshot-1", throughSequence: "4", content: snapshot }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.steerHistory).toEqual(history)
    expect(value.snapshot.toolObservations).toEqual([])
    const messages = contextToModelMessages({ blocks: value.snapshot.steerHistory.map(entry => ({
      id: `history:${entry.id}`, layer: "steer_history", role: "data", trust: "external_untrusted", source: "steer_history", content: entry.content,
    })) } as never)
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: '[harness context layer=steer_history trust=UNTRUSTED_DATA source=steer_history]\n{"role":"user","text":"Existing baseline context"}' }] }])
  })

  it("keeps ordinary canonical bootstrap alive when the fake repository returns a neighboring Turn row", async () => {
    const neighboringTurnRow = { id: "turn-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", status: "in_progress" }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      questionItems: [neighboringTurnRow],
    })

    await expect(loadCanonicalTurnState(fake, lease)).resolves.toMatchObject({ snapshot: { steerHistory: [] } })
    const questionQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('item."type" = \'question\''))?.[0]
    expect(questionQuery).toContain('item."type"')
  })

  it("fails canonical resume closed for an answered question outside the task fence", async () => {
    const malformedQuestion = { id: "foreign-task-question", type: "question", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-task",
      stepId: "step-1", status: "completed", content: { waitKind: "question", questionId: "question-1", toolCallId: null,
        question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: "yes", answerAvailable: true } }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      questionItems: [malformedQuestion],
    })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("question_recovery_item_scope_invalid")
  })

  it("restores the latest scoped cognitive agenda receipt as audit state", async () => {
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, events: [agendaEvent("20"), agendaEvent("21", { stepId: "step-2" })] })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.cognitiveAgendaReceipt?.stepId).toBe("step-2")
    expect(value.snapshot.toolObservations).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: COGNITIVE_AGENDA_EVENT_TYPE })]))
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"'))?.[0]
    expect(eventQuery).toContain(`'${COGNITIVE_AGENDA_EVENT_TYPE}'`)
  })

  it.each([
    ["foreign user", { userId: "other-user" }],
    ["foreign payload scope", { taskId: "other-root" }],
    ["malformed receipt", { nextAction: "invalid" }],
  ])("rejects %s cognitive agenda receipt", async (_label, patch) => {
    const event = agendaEvent("20", patch)
    if (_label === "foreign user") event.userId = "other-user"
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, events: [event] })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow(/cognitive_agenda_/)
  })

  it("rejects out-of-order cognitive agenda receipts", async () => {
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, events: [agendaEvent("21"), agendaEvent("20")] })
    await expect(loadCanonicalTurnState(fake, lease)).rejects.toThrow("cognitive_agenda_sequence_invalid")
  })

  it("accepts a matching agenda resume fence and rejects cursor drift", async () => {
    const step = { id: "step-1", ordinal: 0, taskId: "root-1", inputThroughSequence: "4", consumedInputIds: ["input-1"], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    const valid = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, steps: [step], events: [agendaEvent("20", {}, { inputThroughSequence: 4n, consumedInputIds: ["input-1"] })] })
    await expect(loadCanonicalTurnState(valid, lease)).resolves.toMatchObject({ cognitiveAgendaReceipt: { resumeFence: { inputThroughSequence: "4", consumedInputIds: ["input-1"] } } })
    const drifted = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, steps: [step], events: [agendaEvent("20", {}, { inputThroughSequence: 5n, consumedInputIds: ["input-1"] })] })
    await expect(loadCanonicalTurnState(drifted, lease)).rejects.toThrow("cognitive_agenda_resume_fence_invalid")
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
    expect(value.snapshot.goal).toEqual({ id: "turn-goal:turn-1", content: "Find jobs" })
    expect(value.steeringMarkers).toEqual({ observed: [], applied: [], active: [] })
    expect(fake.client.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes('agent_wait_conditions'))).toBe(false)
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

  it("restores only two owner-scoped closed denial checkpoints into private resume state", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
    const digest = "a".repeat(64)
    const makeDenial = (stepId: string, ordinal: number, offset: number, consumedInputIds: readonly string[] = ["input-3"]) => {
      const agenda = buildCognitiveActionAgenda({ schemaVersion: "agent-harness.v2", sessionId: scope.sessionId,
        turnId: scope.turnId, stepId, inputThroughSequence: 3n, consumedInputIds, taskGraphRevision: 4, canonicalJson: "{}", blocks: [] })
      const receipt = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId, inputThroughSequence: 3n,
        consumedInputIds, agenda })
      if (!receipt) throw new Error("denial agenda fixture should be valid")
      const event = (id: string, type: string, key: string, sequence: number, payload: unknown, causationId: string | null = null) => ({
        id, type, actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
        taskId: scope.rootTaskId, itemId: null, correlationId: stepId, causationId,
        idempotencyKey: `turn:${scope.turnId}:event:${key}`, sequence: String(offset + sequence), payload,
      })
      const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
      if (!agendaKey) throw new Error("denial agenda key should be valid")
      const agendaEvent = event(`${stepId}-agenda`, COGNITIVE_AGENDA_EVENT_TYPE, agendaKey, 1, receipt)
      const started = event(`${stepId}-started`, "model.started", `model-started:${stepId}`, 2,
        { taskId: scope.rootTaskId, provider: "fixture", model: "fixture" }, agendaEvent.id)
      const completed = event(`${stepId}-model`, "model.completed", `model-completed:${stepId}`, 3,
        { taskId: scope.rootTaskId, provider: "fixture", model: "fixture", toolCallCount: 0 }, started.id)
      const usage = event(`${stepId}-usage`, "model.usage", `model-usage:${stepId}`, 4,
        { taskId: scope.rootTaskId, provider: "fixture", model: "fixture", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }, completed.id)
      const summaryId = `${stepId}-summary`
      const summaryStart = { ...event(`${stepId}-summary-start`, "item.started", `item-started:${summaryId}`, 5,
        null, usage.id), itemId: summaryId, eventItemType: "reasoning_summary", eventItemStepId: stepId, eventItemTaskId: scope.rootTaskId }
      const summaryDelta = { ...event(`${stepId}-summary-delta`, "item.delta", `reasoning-delta:${summaryId}:1`, 6,
        null, summaryStart.id), itemId: summaryId, correlationId: summaryId,
        eventItemType: "reasoning_summary", eventItemStepId: stepId, eventItemTaskId: scope.rootTaskId }
      const summaryCompleted = { ...event(`${stepId}-summary-completed`, "item.completed", `reasoning-completed:${summaryId}:2`, 7,
        null, summaryDelta.id), itemId: summaryId, correlationId: summaryId,
        eventItemType: "reasoning_summary", eventItemStepId: stepId, eventItemTaskId: scope.rootTaskId }
      const checkpoint = event(`${stepId}-checkpoint`, TASK_GRAPH_DENIAL_CHECKPOINT_EVENT_TYPE,
        `task-graph-denial-checkpoint:${stepId}`, 8,
        { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: scope.rootTaskId, stepId,
          graphRevision: 4, verificationDigest: digest }, summaryCompleted.id)
      const rejected = event(`${stepId}-rejected`, "final.rejected", `final-rejected:${stepId}`, 9,
        { code: "business_precondition_failed", blocker: "task_graph_verification_unverified",
          feedback: "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing.",
          taskId: scope.rootTaskId }, checkpoint.id)
      const closed = event(`${stepId}-closed`, "step.completed", `step-completed:${stepId}`, 10,
        { stepId, status: "completed", taskId: scope.rootTaskId }, rejected.id)
      return {
        step: { id: stepId, taskId: scope.rootTaskId, ordinal, attempt: 1, status: "completed", errorCode: null,
          inputThroughSequence: "3", consumedInputIds: [...consumedInputIds], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        events: [agendaEvent, started, completed, usage, summaryStart, summaryDelta, summaryCompleted, checkpoint, rejected, closed],
      }
    }
    const first = makeDenial("step-1", 0, 0), second = makeDenial("step-2", 1, 10, [])
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: scope.rootTaskId, contextSnapshotId: null,
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, steps: [first.step, second.step], events: [...first.events, ...second.events] })

    const state = await loadCanonicalTurnState(fake, lease)

    expect(state.resume?.taskGraphDenialProgress).toEqual({ taskId: scope.rootTaskId, graphRevision: 4,
      verificationDigest: digest, inputThroughSequence: 3n, consumedInputIds: ["input-3"], count: 2 })
    expect(JSON.stringify(state.snapshot)).not.toContain(digest)
    const query = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"')
      && sql.includes(`'${TASK_GRAPH_DENIAL_CHECKPOINT_EVENT_TYPE}'`))?.[0]
    expect(query).toContain('event_session."userId" AS "userId"')
    expect(query).toContain('(event."taskId" IS NULL OR event."taskId" = $3)')
    expect(query).toContain('LEFT JOIN "agent_items" AS event_item')
    expect(query).toContain('CASE WHEN event."type" IN (\'item.started\', \'item.delta\', \'item.completed\', \'tool_call.started\') THEN NULL')
    expect(query).not.toContain('event_item."content"')
    expect(query).toContain(`'${COGNITIVE_AGENDA_EVENT_TYPE}'`)
    expect(query).toContain("'tool_call.started'")

    const shiftedSecond = second.events.map(event => Number(event.sequence) >= 15
      ? { ...event, sequence: String(Number(event.sequence) + 1) } : event)
    const orphanToolStart = { ...second.events[0]!, id: "orphan-tool-start", type: "tool_call.started",
      correlationId: "missing-call", itemId: "missing-call-item", causationId: "missing-item-start",
      idempotencyKey: `turn:${scope.turnId}:event:tool-started:missing-call`, sequence: "15", payload: { taskId: scope.rootTaskId } }
    const interruptedStreak = await loadCanonicalTurnState(pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: scope.rootTaskId,
      contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }, steps: [first.step, second.step],
      items: [], events: [...first.events, ...shiftedSecond.slice(0, 4), orphanToolStart, ...shiftedSecond.slice(4)] }), lease)
    expect(interruptedStreak.resume?.taskGraphDenialProgress).toBeUndefined()
  })

  it("loads the durable final-evidence recovery marker into Root resume state", async () => {
    const started = { id: "model-start", type: "model.started", actor: "orchestrator", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", itemId: null, correlationId: "step-0", sequence: "1",
      idempotencyKey: "turn:turn-1:event:model-started:step-0", payload: { taskId: "root-1", provider: "fixture", model: "test" } }
    const completed = { id: "model-done", type: "model.completed", actor: "orchestrator", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", itemId: null, correlationId: "step-0", causationId: started.id, sequence: "2",
      idempotencyKey: "turn:turn-1:event:model-completed:step-0", payload: { taskId: "root-1", provider: "fixture", model: "test", toolCallCount: 0 } }
    const usage = { inputTokens: 3, outputTokens: 1, estimatedCostUsd: 0.01 }
    const usageEvent = { id: "model-usage", type: "model.usage", actor: "orchestrator", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", itemId: null, correlationId: "step-0", causationId: completed.id, sequence: "3",
      idempotencyKey: "turn:turn-1:event:model-usage:step-0", payload: { taskId: "root-1", provider: "fixture", model: "test", usage } }
    const marker = { id: "evidence-recovery", type: "final.rejected", actor: "orchestrator", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", itemId: null, correlationId: "step-0", causationId: usageEvent.id, sequence: "4",
      idempotencyKey: "turn:turn-1:event:final-rejected:step-0:evidence-recovery-once",
      payload: { code: "evidence_missing", blocker: "No verifiable evidence is attached to the candidate final",
        feedback: "Attach verified business or tool evidence before claiming completion", taskId: "root-1" } }
    const stepCompleted = { id: "step-close", type: "step.completed", actor: "orchestrator", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", itemId: null, correlationId: "step-0", causationId: marker.id, sequence: "5",
      idempotencyKey: "turn:turn-1:event:step-completed:step-0", payload: { stepId: "step-0", status: "completed", taskId: "root-1" } }
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [{ id: "step-0", taskId: "root-1", ordinal: 0, status: "completed", errorCode: null, inputTokens: 3, outputTokens: 1, estimatedCostUsd: 0.01 }],
      events: [started, completed, usageEvent, marker, stepCompleted] })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.resume?.finalEvidenceRecoveryUsed).toBe(true)
    const recoveredInstruction = value.snapshot.system.find(seed => seed.id === "completion-recovery:final-evidence-once")
    expect(recoveredInstruction?.content).toContain("Review any current evidence already visible in context")
    expect(recoveredInstruction?.content).toContain("currently visible read-only evidence tool")
    expect(recoveredInstruction?.content).not.toContain("No verifiable evidence is attached to the candidate final")
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"') && sql.includes('event."payload"'))?.[0]
    expect(eventQuery).toContain("'final.rejected'")
  })

  it("fails closed when a pending tool call lacks persisted item identity", async () => {
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

  it("returns lease-owned unfinished calls for server-registry recovery", async () => {
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" } } }],
      events: [{ type: "tool_call.started", payload: { toolCallId: "call-1", toolName: "jobs.search", status: "started" } }],
    }), lease)

    expect(value.pendingToolCalls).toEqual([{
      call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "call-item", revision: 0 },
    }])
    expect(value.snapshot.toolObservations).toEqual([])
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

  it("uses the latest session snapshot and appends ordered role-tagged history after its cursor", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      inputs: [
        { id: "current-input", targetTurnId: "turn-1", content: [{ type: "text", text: "Continue" }], acceptedSequence: "7", delivery: "follow_up", status: "consumed", consumedByStepId: "step-current", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
        { id: "compacted-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Already summarized" }], acceptedSequence: "3", delivery: "steer", status: "consumed", consumedByStepId: "step-compacted", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
        { id: "new-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Use Dublin" }], acceptedSequence: "5", delivery: "steer", status: "consumed", consumedByStepId: "step-new", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
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
    expect(value.contextSnapshotPinned).toBe(false)
    expect(value.snapshot.steerHistory).toEqual([
      { id: "snapshot-history", content: "Compacted history" },
      { id: "history:user:new-input", content: { role: "user", text: "Use Dublin" } },
      { id: "history:assistant:new-agent", content: { role: "assistant", text: "Current reply" } },
    ])
  })

  it("excludes pending follow-ups and annotates only valid prior input lifecycle states", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue with the first follow-up" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      inputs: [
        { id: "successor-root", targetTurnId: "turn-1", content: [{ type: "text", text: "Current successor goal" }], acceptedSequence: "1", delivery: "follow_up", status: "accepted", consumedByStepId: null, consumedAt: null, cancelledAt: null },
        { id: "pending-accepted", targetTurnId: "old-turn", content: [{ type: "text", text: "Later accepted request" }], acceptedSequence: "2", delivery: "follow_up", status: "accepted", consumedByStepId: null, consumedAt: null, cancelledAt: null },
        { id: "pending-queued", targetTurnId: "old-turn", content: [{ type: "text", text: "Later queued request" }], acceptedSequence: "3", delivery: "follow_up", status: "queued", consumedByStepId: null, consumedAt: null, cancelledAt: null },
        { id: "consumed-follow-up", targetTurnId: "old-turn", content: [{ type: "text", text: "Earlier consumed request" }], acceptedSequence: "4", delivery: "follow_up", status: "consumed", consumedByStepId: "step-consumed", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
        { id: "cancelled-follow-up", targetTurnId: "old-turn", content: [{ type: "text", text: "Cancelled request" }], acceptedSequence: "5", delivery: "follow_up", status: "cancelled", consumedByStepId: null, consumedAt: null, cancelledAt: new Date("2026-09-09T00:00:00.000Z") },
        { id: "rejected-follow-up", targetTurnId: "old-turn", content: [{ type: "text", text: "Rejected request" }], acceptedSequence: "6", delivery: "follow_up", status: "rejected", consumedByStepId: null, consumedAt: null, cancelledAt: null },
        { id: "pending-steer", targetTurnId: "old-turn", content: [{ type: "text", text: "Existing steering input" }], acceptedSequence: "7", delivery: "steer", status: "accepted", consumedByStepId: null, consumedAt: null, cancelledAt: null },
        { id: "malformed-steer-step", targetTurnId: "old-turn", content: [{ type: "text", text: "Malformed consumed step" }], acceptedSequence: "8", delivery: "steer", status: "accepted", consumedByStepId: "step-8", consumedAt: null, cancelledAt: null },
        { id: "malformed-steer-time", targetTurnId: "old-turn", content: [{ type: "text", text: "Malformed consumed time" }], acceptedSequence: "9", delivery: "steer", status: "queued", consumedByStepId: null, consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
        { id: "malformed-steer-cancelled", targetTurnId: "old-turn", content: [{ type: "text", text: "Malformed cancellation time" }], acceptedSequence: "10", delivery: "steer", status: "accepted", consumedByStepId: null, consumedAt: null, cancelledAt: new Date("2026-09-09T00:00:00.000Z") },
        { id: "invalid-old-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Must not be an unlabeled instruction" }], acceptedSequence: "8" },
      ],
    })

    const value = await loadCanonicalTurnState(fake, lease)

    expect(value.rootInputId).toBe("successor-root")
    expect(value.snapshot.goal).toEqual({ id: "turn-goal:turn-1", content: "Continue with the first follow-up" })
    expect(value.snapshot.steerHistory).toEqual([
      { id: "history:user:consumed-follow-up", content: { role: "user", text: "Earlier consumed request" } },
      { id: "history:user:cancelled-follow-up", content: { role: "user", text: "Cancelled request", priorInputDisposition: "cancelled" } },
      { id: "history:user:rejected-follow-up", content: { role: "user", text: "Rejected request", priorInputDisposition: "rejected" } },
      { id: "history:user:pending-steer", content: { role: "user", text: "Existing steering input", priorInputDisposition: "not_consumed" } },
    ])
    const priorInputQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('AS "historyRole"'))?.[0]
    expect(priorInputQuery).toContain(`AND NOT ("delivery" = 'follow_up' AND "status" IN ('accepted', 'queued')`)
    expect(priorInputQuery).toContain('"delivery", "status", "consumedByStepId", "consumedAt", "cancelledAt"')
    expect(priorInputQuery).toContain('AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL)')
  })

  it("keeps an explicitly pinned snapshot and reports its pin without changing cursor-tail restore", async () => {
    const pinnedContent = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "4", goal: "Continue",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
      context: { system: [], profile: [], steerHistory: [{ id: "pinned-history", content: "Pinned summary" }], toolObservations: [] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const latestContent = { ...pinnedContent, throughSequence: "8", context: { ...pinnedContent.context, steerHistory: [{ id: "latest-history", content: "Newer summary" }] } }
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: null, contextSnapshotId: "snapshot-pinned", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      inputs: [
        { id: "before-cursor", targetTurnId: "old-turn", content: [{ type: "text", text: "Summarized already" }], acceptedSequence: "3", delivery: "steer", status: "consumed", consumedByStepId: "step-before", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
        { id: "after-cursor", targetTurnId: "old-turn", content: [{ type: "text", text: "Keep this" }], acceptedSequence: "5", delivery: "steer", status: "consumed", consumedByStepId: "step-after", consumedAt: new Date("2026-09-09T00:00:00.000Z"), cancelledAt: null },
      ],
      snapshots: [
        { id: "snapshot-pinned", throughSequence: "4", version: 1, content: pinnedContent },
        { id: "snapshot-latest", throughSequence: "8", version: 2, content: latestContent },
      ],
    })

    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.contextSnapshotPinned).toBe(true)
    expect(value.snapshot.steerHistory).toEqual([
      { id: "pinned-history", content: "Pinned summary" },
      { id: "history:user:after-cursor", content: { role: "user", text: "Keep this" } },
    ])
    const snapshotQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_context_snapshots"'))
    expect(snapshotQuery?.[0]).toContain('WHERE snapshot."id" = $1')
    expect(snapshotQuery?.[1]).toEqual(["snapshot-pinned", "session-1", "user-1"])
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

  it("projects a consumed wait outcome into the next root context", async () => {
    const wait: { id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string; targetTaskIds: string[]; mode: string; status: string; matchedTaskIds: string[]; result: Record<string, unknown>; suspendedAt: Date; consumedAt: Date | null } = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "all", status: "ready", matchedTaskIds: ["child-1"], result: { request: { mode: "all" } }, suspendedAt: new Date("2026-09-09T00:00:00.000Z"), consumedAt: null }
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT active_turn."createdAt"')) return { rows: [{ createdAt: new Date("2026-10-07T00:00:00.000Z") }], rowCount: 1 }
      if (sql.includes('SELECT prior."id"')) return { rows: [], rowCount: 0 }
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
})
