import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { StepContextBuilder, type ContextOwnerFence, type StepContextRequest } from "./context/step-context-builder.js"
import type { StoredAgentInput } from "./context/input-claim-store.js"
import { buildModelRequest } from "./turns/turn-engine-messages.js"
import { buildCognitiveActionAgenda } from "./turns/cognitive-action-agenda.js"
import { progressCheckpointFromStepContext } from "./progress.js"
import {
  TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphCurrentState,
} from "./subagents/task-graph-command-port.js"
import { currentTaskGraph, type GraphTaskRow, type LoadedGraph } from "./subagents/task-graph-pg-state.js"
import { resolveTaskGraphRepairDependencies } from "./subagents/task-graph-dependency-context.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState } from "./subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./subagents/role-results.js"
import { projectSelectedJobMemory, type SelectedJobMemoryNode } from "./context/selected-job-memory.js"
import type { ValidatedSelectedJobHistoryOutcome } from "./context/selected-job-history.js"
import type { ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"
import { projectLoadedRootTaskHistoryGraph } from "./context/root-task-history-lesson-projection.js"
import { ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID } from "./context/root-task-goal-criteria-context.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import { mergeTaskGraphCurrentObservation } from "./canonical-turn-task-graph-context.js"
import type { DirectSelectedJobHistoryReader, SelectedJobHistoryReader } from "./canonical-turn-selected-job-history.js"
import type { DirectRootTaskHistoryReader } from "./canonical-turn-root-task-history.js"
import type { TurnLease } from "./turns/lease.js"

const scope: TenantScope = { userId: "user-a" }
const now = new Date("2026-10-07T12:00:00.000Z")

function transaction(calls: unknown[]): InputClaimTransaction {
  return {
    getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
    claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
    loadUnresolvedSteeringInputs: async input => { calls.push(input); return [] },
    persistCheckpoint: async () => undefined,
  }
}

function store(calls: unknown[]): InputClaimStore {
  return { scope, withTransaction: work => work(transaction(calls)) }
}

const lease: TurnLease = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "worker-a", leaseVersion: 3,
  leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

const HISTORY_ROOT_ID = "PRIVATE_HISTORY_ROOT_ID"
const HISTORY_DIGEST = "a".repeat(64)
const unavailableBudget = {
  kind: "turn_budget_current", status: "unavailable", advisoryOnly: true, pointInTime: true,
  notPermission: true, notReservation: true, notCompletionEvidence: true,
} as const

function historyContract(role: "scout" | "analyst", criteria: readonly unknown[]) {
  return { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria }
}

function historyReport(status: "failed" | "passed" | "unverified", criterionIds: readonly string[], salt: string) {
  const passed = status !== "failed"
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status,
    reasonCode: status === "passed" ? "criteria_met" : status === "unverified" ? "repair_target_unresolved" : "criterion_not_met",
    criteria: criterionIds.map(criterionId => ({ criterionId, status: passed ? "passed" : "failed", reasonCode: passed ? "criteria_met" : "criterion_not_met" })),
    evidenceDigest: status === "unverified" ? null : HISTORY_DIGEST,
    resultDigest: salt.repeat(64),
  }
}

function historicalRoleResult(role: "scout" | "analyst", count: number, status: "completed" | "partial", marker: string) {
  const shared = { schemaVersion: ROLE_RESULT_SCHEMA, status, summary: `PRIVATE_${marker}_SUMMARY` }
  if (role === "scout") {
    const candidates = Array.from({ length: count }, (_, index) => {
      const jobId = `PRIVATE_${marker}_JOB_${index + 1}`, evidenceId = `PRIVATE_${marker}_EVIDENCE_${index + 1}`
      return { jobId, evidenceId, source: "greenhouse", url: `https://private.example/${marker}/${index + 1}` }
    })
    return { ...shared, role: "scout" as const, evidence: candidates.map(row => ({ id: row.evidenceId, kind: "job", ref: row.jobId, source: `PRIVATE_${marker}_EVIDENCE_SOURCE` })),
      candidates: candidates.map(row => ({ jobId: row.jobId, source: row.source, url: row.url, evidenceIds: [row.evidenceId] })) }
  }
  const findings = Array.from({ length: count }, (_, index) => {
    const jobId = `PRIVATE_${marker}_JOB_${index + 1}`, evidenceId = `PRIVATE_${marker}_EVIDENCE_${index + 1}`
    return { jobId, evidenceId, score: 9.75 }
  })
  return { ...shared, role: "analyst" as const, evidence: findings.map(row => ({ id: row.evidenceId, kind: "job", ref: row.jobId, source: `PRIVATE_${marker}_EVIDENCE_SOURCE` })),
    findings: findings.map(row => ({ jobId: row.jobId, score: row.score, evidenceIds: [row.evidenceId] })) }
}

function loadedHistoryGraphFixture(): LoadedGraph {
  const scoutFailures = [
    { id: "private-scout-count", check: { kind: "candidate_count_gte", minimum: 8 } },
    { id: "private-scout-evidence", check: { kind: "evidence_count_gte", minimum: 8 } },
  ]
  const analystFailures = [
    { id: "private-analyst-count-a", check: { kind: "finding_count_gte", minimum: 8 } },
    { id: "private-analyst-count-b", check: { kind: "finding_count_gte", minimum: 9 } },
  ]
  const scoutRepairCriteria = [{ id: "private-scout-repair-check", check: { kind: "candidate_count_gte", minimum: 2 } }]
  const scoutOutputCriteria = [{ id: "private-scout-output-check", check: { kind: "candidate_count_gte", minimum: 1 } }]
  const analystOutputCriteria = [{ id: "private-analyst-output-check", check: { kind: "finding_count_gte", minimum: 1 } }]
  const nodes = [
    { key: "PRIVATE_HISTORY_SCOUT_FAILURE", templateId: "scout", goal: "PRIVATE_HISTORY_SCOUT_GOAL", successCriteria: ["PRIVATE_HISTORY_SCOUT_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_SCOUT_TASK", verificationDisposition: "typed", verification: historyContract("scout", scoutFailures) },
    { key: "PRIVATE_HISTORY_ANALYST_FAILURE", templateId: "analyst", goal: "PRIVATE_HISTORY_ANALYST_GOAL", successCriteria: ["PRIVATE_HISTORY_ANALYST_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_ANALYST_TASK", verificationDisposition: "typed", verification: historyContract("analyst", analystFailures) },
    { key: "PRIVATE_HISTORY_ANALYST_REPAIR", templateId: "analyst", goal: "PRIVATE_HISTORY_REPAIR_GOAL", successCriteria: ["PRIVATE_HISTORY_REPAIR_CRITERION"], dependsOn: [], depth: 2, taskId: "PRIVATE_HISTORY_REPAIR_TASK", verificationDisposition: "typed", verification: historyContract("analyst", analystFailures), repairOf: { graphRootTaskId: HISTORY_ROOT_ID, nodeKey: "PRIVATE_HISTORY_ANALYST_FAILURE", taskId: "PRIVATE_HISTORY_ANALYST_TASK", criterionIds: analystFailures.map(item => item.id) } },
    { key: "PRIVATE_HISTORY_SCOUT_PARTIAL", templateId: "scout", goal: "PRIVATE_HISTORY_SCOUT_OUTPUT_GOAL", successCriteria: ["PRIVATE_HISTORY_SCOUT_OUTPUT_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_SCOUT_OUTPUT_TASK", verificationDisposition: "typed", verification: historyContract("scout", scoutOutputCriteria) },
    { key: "PRIVATE_HISTORY_ANALYST_PARTIAL", templateId: "analyst", goal: "PRIVATE_HISTORY_ANALYST_OUTPUT_GOAL", successCriteria: ["PRIVATE_HISTORY_ANALYST_OUTPUT_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_ANALYST_OUTPUT_TASK", verificationDisposition: "typed", verification: historyContract("analyst", analystOutputCriteria) },
    { key: "PRIVATE_HISTORY_UNRESOLVED_TARGET", templateId: "scout", goal: "PRIVATE_HISTORY_UNRESOLVED_GOAL", successCriteria: ["PRIVATE_HISTORY_UNRESOLVED_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_UNRESOLVED_TASK", verificationDisposition: "typed", verification: historyContract("scout", scoutRepairCriteria) },
    { key: "PRIVATE_HISTORY_UNRESOLVED_REPAIR", templateId: "scout", goal: "PRIVATE_HISTORY_UNRESOLVED_REPAIR_GOAL", successCriteria: ["PRIVATE_HISTORY_UNRESOLVED_REPAIR_CRITERION"], dependsOn: [], depth: 2, taskId: "PRIVATE_HISTORY_UNRESOLVED_REPAIR_TASK", verificationDisposition: "typed", verification: historyContract("scout", scoutRepairCriteria), repairOf: { graphRootTaskId: HISTORY_ROOT_ID, nodeKey: "PRIVATE_HISTORY_UNRESOLVED_TARGET", taskId: "PRIVATE_HISTORY_UNRESOLVED_TASK", criterionIds: ["private-scout-repair-check"] } },
    { key: "PRIVATE_HISTORY_SCOUT_ZERO", templateId: "scout", goal: "PRIVATE_HISTORY_ZERO_GOAL", successCriteria: ["PRIVATE_HISTORY_ZERO_CRITERION"], dependsOn: [], depth: 1, taskId: "PRIVATE_HISTORY_ZERO_TASK", verificationDisposition: "legacy_unverified" },
  ]
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes })
  const tasks = new Map<string, GraphTaskRow>()
  const add = (index: number, status: GraphTaskRow["status"], report?: ReturnType<typeof historyReport>, structuredResult?: unknown, receipt?: unknown) => {
    const node = snapshot.nodes[index]!
    const failureReason = status === "failed"
      ? report?.reasonCode === "repair_target_unresolved" ? "task_graph_repair_target_unresolved"
        : report?.status === "failed" ? "task_graph_verification_failed" : "task_graph_verification_unverified"
      : null
    const result: Record<string, unknown> = structuredResult === undefined ? {} : {
      finalItemId: `PRIVATE_HISTORY_FINAL_ITEM_${index + 1}`, finalText: `PRIVATE_HISTORY_FINAL_TEXT_${index + 1}`,
      status: "completed", stepCount: 4, structuredResult, toolCallCount: 2,
    }
    if (report !== undefined) result.taskGraphVerificationReport = report
    if (receipt !== undefined) result.taskGraphRepairReceipt = receipt
    tasks.set(node.taskId, { id: node.taskId, status, role: node.templateId, failureReason, result })
  }
  const scoutFailureReport = historyReport("failed", scoutFailures.map(item => item.id), "b")
  const analystFailureReport = historyReport("failed", analystFailures.map(item => item.id), "c")
  const analystRepairReport = historyReport("passed", analystFailures.map(item => item.id), "d")
  const repairNode = snapshot.nodes[2]!
  const repairReceipt = {
    schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: HISTORY_ROOT_ID,
    targetNodeKey: snapshot.nodes[1]!.key, targetTaskId: snapshot.nodes[1]!.taskId,
    criterionIds: analystFailures.map(item => item.id), repairNodeKey: repairNode.key, repairTaskId: repairNode.taskId,
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: analystRepairReport.evidenceDigest,
  }
  add(0, "failed", scoutFailureReport)
  add(1, "failed", analystFailureReport)
  add(2, "completed", analystRepairReport, undefined, repairReceipt)
  add(3, "completed", historyReport("passed", scoutOutputCriteria.map(item => item.id), "e"), historicalRoleResult("scout", 5, "partial", "SCOUT"))
  add(4, "completed", historyReport("passed", analystOutputCriteria.map(item => item.id), "f"), historicalRoleResult("analyst", 6, "partial", "ANALYST"))
  add(5, "failed", historyReport("failed", scoutRepairCriteria.map(item => item.id), "1"))
  add(6, "failed", historyReport("unverified", scoutRepairCriteria.map(item => item.id), "2"))
  add(7, "completed", undefined, historicalRoleResult("scout", 0, "completed", "ZERO"))
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  const baseState = taskGraphState(snapshot, 7, statuses, [])
  const coverage = resolveTaskGraphRepairDependencies(snapshot, tasks, HISTORY_ROOT_ID)
  return {
    rootTaskId: HISTORY_ROOT_ID, snapshot, tasks,
    state: { ...baseState, repairSatisfiedNodeKeys: coverage.satisfied, repairPendingNodeKeys: coverage.pending },
    item: { id: "PRIVATE_HISTORY_GRAPH_ITEM", revision: 7, content: snapshot, createdAt: now },
  }
}

describe("canonical Turn context builder", () => {
  it("injects only server-owned native-root scope into the same-client historical steering reader", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("context without attachments must not acquire another client") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, rootInputId: "original-input-a",
      planningEnabled: true, selectedJobMode: false, rootTaskHistoryDirectReader: { load: async () => [] },
      currentRootBudgetReader: async () => unavailableBudget,
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      mode: "rebuild", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })

    expect(calls).toEqual([{
      userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
      turnLeaseOwner: "worker-a", turnLeaseVersion: 3, parentLeaseOwner: "worker-a", parentAttemptCount: 2,
      rootInputId: "original-input-a", lease: { ownerId: "worker-a", leaseVersion: 3, now },
    }])
    expect(calls[0]).not.toHaveProperty("stepId")
    expect(context.consumedInputIds).toEqual([])
    expect(context.taskGraphRevision).toBeUndefined()
  })

  it("does not request native steering hydration when canonical root planning is disabled", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("unexpected connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, planningEnabled: false, selectedJobMode: false,
    })

    await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    })

    expect(calls).toEqual([])
  })

  it("passes opt-in history scope only through a planning ordinary-root builder", async () => {
    const load = vi.fn(async () => [])
    const reader: DirectRootTaskHistoryReader = { load }
    const pool = { connect: async () => { throw new Error("injected readers avoid a database connection") } } as unknown as Pick<pg.Pool, "connect">
    const build = (planningEnabled: boolean, selectedJobMode: boolean) => createCanonicalTurnContextBuilder({
      pool, store: store([]), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled, selectedJobMode, crossSessionRootTaskHistoryEnabled: true, rootTaskHistoryDirectReader: reader,
      currentRootBudgetReader: async () => unavailableBudget,
    }).build({ scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-opt-in",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }, now })

    await build(true, false)
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ crossSessionRootTaskHistoryEnabled: true }))
    load.mockClear()
    await build(false, false)
    await build(true, true)
    expect(load).not.toHaveBeenCalled()
  })

  it("adds only validated criteria to planning Root requests and preserves child/no-planning modes", async () => {
    const goal = "Find EU roles"
    const turnInput = { input: { goal, successCriteria: ["Turn criterion", "Shared criterion"], privateTurnId: "PRIVATE_TURN_ID" }, secret: "PRIVATE_TURN_SECRET" }
    const rootTaskObjective = { goal, successCriteria: ["Root criterion", "Shared criterion"], id: "PRIVATE_ROOT_ID", context: "PRIVATE_ROOT_CONTEXT" }
    const buildRequest = async (planningEnabled: boolean, selectedJobMode: boolean) => {
      const calls: unknown[] = []
      const inputStore = store(calls)
      const builder = createCanonicalTurnContextBuilder({
        pool: { connect: async () => { throw new Error("injected readers should avoid a client") } } as unknown as Pick<pg.Pool, "connect">,
        store: inputStore, baseBuilder: new StepContextBuilder(inputStore), scope, lease, rootTaskId: "root-a", rootAttemptCount: 1,
        planningEnabled, selectedJobMode, turnInput, rootTaskObjective,
        rootTaskHistoryDirectReader: { load: async () => [] }, currentRootBudgetReader: async () => unavailableBudget,
      })
      const context = await builder.build({
        scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "criteria-step",
        snapshot: { system: [], profile: [], goal: { id: "turn-goal", content: goal }, steerHistory: [], businessRefs: [], toolObservations: [] },
      })
      const model = { profile: { provider: "fixture", model: "fixture", nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
      return buildModelRequest({ context, model, tools: [], sessionId: lease.sessionId, turnId: lease.turnId, stepId: "criteria-step", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal })
    }
    const request = await buildRequest(true, false)
    const criteriaBlock = request.messages.flatMap(message => message.content).find(part => part.type === "text" && part.text.includes("root_task_success_criteria"))
    expect(criteriaBlock?.type).toBe("text")
    if (criteriaBlock?.type !== "text") throw new Error("goal_criteria_block_missing")
    expect(criteriaBlock.text).toContain('["Turn criterion","Shared criterion","Root criterion"]')
    expect(request.messages.some(message => message.role === "system" && message.content.some(part => part.type === "text" && part.text.includes("Turn criterion")))).toBe(false)
    expect(JSON.stringify(request.messages)).not.toMatch(/PRIVATE_TURN_ID|PRIVATE_TURN_SECRET|PRIVATE_ROOT_ID|PRIVATE_ROOT_CONTEXT/)
    expect(JSON.stringify((await buildRequest(false, false)).messages)).not.toContain("root_task_success_criteria")
    expect(JSON.stringify((await buildRequest(true, true)).messages)).not.toContain("root_task_success_criteria")
  })

  it("projects only canonical typed intent on initial and replan contexts", async () => {
    const goal = "Find EU roles"
    const rootTaskObjective = { goal, successCriteria: ["Explain the shortlist"], id: "PRIVATE_ROOT_ID", privateContext: "PRIVATE_ROOT_CONTEXT" }
    const buildFor = (turnInput: unknown, planningEnabled = true, selectedJobMode = false) => {
      const calls: unknown[] = []
      const inputStore = store(calls)
      const builder = createCanonicalTurnContextBuilder({
        pool: { connect: async () => { throw new Error("injected readers must avoid a database client") } } as unknown as Pick<pg.Pool, "connect">,
        store: inputStore, baseBuilder: new StepContextBuilder(inputStore), scope, lease,
        rootTaskId: "root-a", rootAttemptCount: 1, planningEnabled, selectedJobMode, turnInput, rootTaskObjective,
        rootTaskHistoryDirectReader: { load: async () => [] }, currentRootBudgetReader: async () => unavailableBudget,
      })
      return (stepId: string) => builder.build({
        scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId,
        snapshot: {
          system: [], profile: [], goal: { id: "goal", content: goal }, steerHistory: [], businessRefs: [],
          toolObservations: [{ id: ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID, content: { privateSpoof: "PRIVATE_SPOOFED_OBSERVATION" } }],
        },
      })
    }
    const turnInput = {
      goal, successCriteria: ["Legacy prose criterion"],
      verificationRequirements: {
        schemaVersion: "agent-harness.v2.objective-requirements.v1",
        requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
      },
      privateTurnId: "PRIVATE_TURN_ID",
      privateEnvelopeValue: "PRIVATE_ENVELOPE_VALUE",
    }
    const build = buildFor(turnInput)
    const initial = await build("initial-plan")
    const replan = await build("replan-plan")
    const observationId = `observation:${ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID}`
    for (const context of [initial, replan]) {
      const observations = context.blocks.filter(block => block.id === observationId)
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        layer: "tool_observation", role: "data", trust: "external_untrusted",
        content: {
          kind: "canonical_objective_verification_requirements", trust: "external_untrusted",
          source: "canonical_turn_objective", status: "valid",
          requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3 }],
        },
      })
      expect(context.blocks.find(block => block.id === "goal:root-task-success-criteria")?.content)
        .toEqual({ successCriteria: ["Legacy prose criterion", "Explain the shortlist"] })
      const serialized = JSON.stringify(context.blocks)
      expect(serialized).not.toMatch(/PRIVATE_ROOT_ID|PRIVATE_ROOT_CONTEXT|PRIVATE_TURN_ID|PRIVATE_ENVELOPE_VALUE|PRIVATE_SPOOFED_OBSERVATION/)
    }
    expect(replan.blocks.find(block => block.id === observationId)?.content).toEqual(initial.blocks.find(block => block.id === observationId)?.content)
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context: initial, model, tools: [], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "initial-plan", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal,
    })
    expect(JSON.stringify(request.messages)).toContain("candidate-count")
    expect(JSON.stringify(request.messages)).not.toMatch(/PRIVATE_ROOT_ID|PRIVATE_ROOT_CONTEXT|PRIVATE_TURN_ID|PRIVATE_ENVELOPE_VALUE|PRIVATE_SPOOFED_OBSERVATION/)

    const invalid = await buildFor({ input: { goal, verificationRequirements: { schemaVersion: "unsupported", privateMalformedValue: "PRIVATE_MALFORMED_VALUE" } } })("invalid-plan")
    expect(invalid.blocks.find(block => block.id === observationId)).toMatchObject({
      trust: "external_untrusted",
      content: { kind: "canonical_objective_verification_requirements", trust: "external_untrusted", source: "canonical_turn_objective", status: "invalid" },
    })
    expect(JSON.stringify(invalid.blocks)).not.toContain("PRIVATE_MALFORMED_VALUE")
    const absent = await buildFor({ input: { goal } })("absent-plan")
    expect(absent.blocks.some(block => block.id === observationId)).toBe(false)
    const selectedJob = await buildFor(turnInput, true, true)("selected-job-plan")
    expect(selectedJob.blocks.some(block => block.id === observationId)).toBe(false)
  })

  it("adds bounded Root-task history as untrusted advisory context without changing current graph evidence", async () => {
    const outcomes: readonly ValidatedRootTaskHistoryOutcome[] = [{
      sourceTurnId: "private-earlier-turn", sourceRootTaskId: "private-earlier-root", terminalSequence: 12n,
      sourceNodeOrdinals: [1], nodeLessons: [{ ordinalScope: "source_graph_local", advisoryOnly: true,
        notCurrentEvidence: true, nodeOrdinal: 1, criterionFailures: [{ criterionOrdinal: 1, status: "failed",
          reasonCode: "criterion_not_met", check: { role: "analyst", kind: "finding_count_gte", minimum: 2 } }] }],
      taskGraph: {
        revision: 7,
        nodes: [{ key: "private-node", templateId: "analyst", goal: "PRIVATE_OLD_GOAL", successCriteria: ["PRIVATE_CRITERION"],
          dependsOn: [], taskId: "private-child-task", status: "failed", readiness: "terminal", resultSummary: "PRIVATE_RESULT", failureReason: "PRIVATE_FAILURE" }],
      } satisfies TaskGraphCurrentState,
    }]
    const reader: DirectRootTaskHistoryReader = { load: vi.fn(async () => outcomes) }
    const currentGraph = { kind: "task_graph_current", revision: 23, nodes: [{ taskId: "current-task", status: "running" }] }
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "system-current", content: "Current policy remains authoritative." }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_SENTINEL" },
      taskGraphRevision: 23,
      toolObservations: [
        { id: "task-graph-current", content: currentGraph },
        { id: "root-task-history", content: { kind: "spoofed_history", text: "CALLER_HISTORY_SENTINEL" } },
      ],
      steerHistory: [], businessRefs: [],
    }
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the injected reader must avoid a database connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: store([]), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: true, selectedJobMode: false, rootTaskHistoryDirectReader: reader,
      currentRootBudgetReader: async () => unavailableBudget,
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-root-history", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const historyBlock = context.blocks.find(block => block.id === "observation:root-task-history")
    const graphBlock = context.blocks.find(block => block.id === "observation:task-graph-current")
    const serializedHistory = JSON.stringify(historyBlock?.content)
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-root-history", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const requestText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const systemText = request.messages.filter(message => message.role === "system").flatMap(message => message.content)
      .flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(reader.load).toHaveBeenCalledWith({ lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-root-history", now })
    expect(context.taskGraphRevision).toBe(23)
    expect(graphBlock?.content).toEqual(currentGraph)
    expect(historyBlock).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    expect(historyBlock?.content).toMatchObject({ kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true })
    expect(historyBlock?.content).toMatchObject({ turns: [{ nodes: [{ lesson: { criterionFailures: [
      { check: { role: "analyst", kind: "finding_count_gte", minimum: 2 } },
    ] } }] }] })
    expect(requestText).toContain("root_task_history")
    expect(requestText).toContain('"kind":"finding_count_gte"')
    expect(requestText).toContain('"minimum":2')
    expect(systemText).toContain("Historical typed-check descriptors distinguish count, evidence-completeness, score, Scout-dependency, and declared cohort-coverage failure shapes only")
    expect(systemText).not.toContain("finding_count_gte")
    expect(systemText).not.toContain('"minimum":2')
    expect(requestText).toContain('"taskKind":"analyst"')
    expect(requestText).toContain('"status":"failed"')
    for (const privateValue of ["private-earlier-turn", "private-earlier-root", "private-node", "private-child-task", "PRIVATE_OLD_GOAL", "PRIVATE_CRITERION", "PRIVATE_RESULT", "PRIVATE_FAILURE", "CALLER_HISTORY_SENTINEL", "spoofed_history"]) {
      expect(serializedHistory).not.toContain(privateValue)
      expect(requestText).not.toContain(privateValue)
    }
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlock?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })

  it("composes loaded Root-history lessons and result counts into the actual request without changing current Turn evidence", async () => {
    const loaded = loadedHistoryGraphFixture()
    const source = projectLoadedRootTaskHistoryGraph(loaded)
    if (!source) throw new Error("typed source history fixture did not produce a loaded graph projection")
    expect(source.sourceNodeOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(source.nodeLessons?.[0]).toMatchObject({ nodeOrdinal: 1, criterionFailures: [
      { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "candidate_count_gte", minimum: 8 } },
      { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "evidence_count_gte", minimum: 8 } },
    ] })
    expect(source.nodeLessons?.[1]).toMatchObject({ nodeOrdinal: 2, criterionFailures: [
      { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
      { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" },
    ] })
    expect(source.nodeLessons?.[2]?.successfulRepairs).toEqual([{ targetNodeOrdinal: 2, targetCriterionOrdinals: [1, 2], status: "passed" }])
    expect(source.reportedOutputs?.[3]).toEqual({ role: "scout", candidateCount: 5, resultStatus: "partial" })
    expect(source.reportedOutputs?.[4]).toEqual({ role: "analyst", findingCount: 6, resultStatus: "partial" })
    expect(source.reportedOutputs?.[7]).toEqual({ role: "scout", candidateCount: 0, resultStatus: "completed" })

    const outcome: ValidatedRootTaskHistoryOutcome = {
      sourceTurnId: "PRIVATE_HISTORY_SOURCE_TURN", sourceRootTaskId: HISTORY_ROOT_ID, terminalSequence: 19n,
      taskGraph: source.taskGraph, sourceNodeOrdinals: source.sourceNodeOrdinals,
      ...(source.nodeLessons ? { nodeLessons: source.nodeLessons } : {}),
      ...(source.reportedOutputs ? { reportedOutputs: source.reportedOutputs } : {}),
    }
    const historyReader: DirectRootTaskHistoryReader = { load: vi.fn(async () => [outcome]) }
    const originalText = "FULL_ORIGINAL_ROOT_REFERENCE: Find senior data roles in Amsterdam while preserving the complete initial task."
    const steerText = "CURRENT_ACCEPTED_STEER_SENTINEL: prioritize roles with platform ownership."
    const rootInput: StoredAgentInput = {
      id: "original-root-input", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "original-root-message", delivery: "follow_up", status: "consumed",
      content: [{ type: "text", text: originalText }], acceptedSequence: 4n,
      consumedByStepId: "step-before-history", consumedAt: now, createdAt: now,
    }
    const steerInput: StoredAgentInput = {
      id: "current-steer-input", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "current-steer-message", delivery: "steer", status: "consumed",
      content: [{ type: "text", text: steerText }], acceptedSequence: 5n,
      consumedByStepId: "step-history-composition", consumedAt: now, createdAt: now,
    }
    let persistedCheckpoint: { inputThroughSequence: bigint; consumedInputIds: readonly string[] } | undefined
    const claimStore: InputClaimStore = {
      scope,
      withTransaction: work => work({
        getCheckpoint: async () => ({ inputThroughSequence: 4n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [steerInput], newlyClaimedInputIds: [steerInput.id] }),
        loadUnresolvedSteeringInputs: async () => [],
        loadRootInputContext: async input => input.inputId === rootInput.id ? rootInput : null,
        persistCheckpoint: async input => { persistedCheckpoint = input.checkpoint },
      }),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const baseBuilder = new StepContextBuilder(claimStore, ownerFence)
    const currentCounts = {
      discoveredJobs: { knownCount: 23, coverage: "partial" as const },
      analyzedJobs: { knownCount: 11, coverage: "complete" as const },
      artifactReferences: { knownCount: null, coverage: "not_requested" as const },
      reviewOutcomes: { knownCount: null, coverage: "unavailable" as const },
    }
    const requestSnapshot = mergeTaskGraphCurrentObservation({
      system: [{ id: "current-policy", content: "System policy remains authoritative." }], profile: [],
      goal: { id: "current-goal", content: "CURRENT_GOAL_SENTINEL: find suitable platform roles." },
      steerHistory: [
        { id: "saved-question", content: { role: "assistant", type: "question", question: "Which city should I prioritize?" } },
        { id: "saved-answer", content: { role: "user", type: "answer", text: "Amsterdam, with Dublin as a backup." } },
      ],
      planningClarifications: [{ observedPlanRevision: 22, graphRevisionAtAsk: 23, pendingSteerCount: 1, unconsumedSteerCount: 0, inputThroughSequence: "4" }],
      planningClarificationHistoryPair: { questionEntryId: "saved-question", answerEntryId: "saved-answer" },
      businessRefs: [], toolObservations: [{ id: "root-task-history", content: { kind: "caller_spoof", text: "CALLER_HISTORY_SPOOF" } }],
    }, {
      revision: 23,
      nodes: [{
        key: "current-graph-node", templateId: "scout", goal: "CURRENT_GRAPH_SENTINEL: search current roles", successCriteria: ["current-only criterion"],
        dependsOn: [], taskId: "current-graph-task", status: "running", readiness: "active", resultSummary: null,
        resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" }, failureReason: null,
      }],
      planningFacts: { graphRevision: 23, counts: currentCounts },
    } satisfies TaskGraphCurrentState)
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("injected readers and the base builder must avoid a database connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: claimStore, baseBuilder, scope, lease, rootTaskId: "current-root-task", rootAttemptCount: 2,
      rootInputId: rootInput.id, planningEnabled: true, selectedJobMode: false, rootTaskHistoryDirectReader: historyReader,
      currentRootBudgetReader: async () => unavailableBudget,
    })
    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-history-composition", snapshot: requestSnapshot,
      rootInputId: rootInput.id, rootContextInputId: rootInput.id, mode: "new", now,
      lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.list", version: "1" }, { name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-history-composition", userId: scope.userId, taskId: "current-root-task", signal: new AbortController().signal,
    })
    const requestMessages = request.messages.map(message => ({
      role: message.role,
      text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"),
    }))
    const requestText = requestMessages.map(message => message.text).join("\n")
    const systemText = requestMessages.filter(message => message.role === "system").map(message => message.text).join("\n")
    const historyBlock = context.blocks.find(block => block.id === "observation:root-task-history")
    const graphBlock = context.blocks.find(block => block.id === "observation:task-graph-current")
    const historyJson = JSON.stringify(historyBlock?.content)
    const historyContent = historyBlock?.content as { turns?: Array<{ nodes?: Array<Record<string, unknown>> }> } | undefined
    const historyNodes = historyContent?.turns?.flatMap(turn => turn.nodes ?? []) ?? []
    const scoutFailure = historyNodes.find(node => (node.lesson as { nodeOrdinal?: number } | undefined)?.nodeOrdinal === 1)
    const analystFailure = historyNodes.find(node => (node.lesson as { nodeOrdinal?: number } | undefined)?.nodeOrdinal === 2)
    const exactRepair = historyNodes.find(node => (node.lesson as { nodeOrdinal?: number } | undefined)?.nodeOrdinal === 3)
    const unresolvedRepair = historyNodes.find(node => Array.isArray(node.negativeReasonHints) && node.negativeReasonHints.includes("repair_target_unresolved"))
    const scoutOutput = historyNodes.find(node => (node.reportedOutput as { candidateCount?: number } | undefined)?.candidateCount === 5)
    const analystOutput = historyNodes.find(node => (node.reportedOutput as { findingCount?: number } | undefined)?.findingCount === 6)
    const zeroOutput = historyNodes.find(node => (node.reportedOutput as { candidateCount?: number } | undefined)?.candidateCount === 0)
    const clarification = context.blocks.find(block => block.id === "planning-clarification:latest-answered-question")

    expect(historyReader.load).toHaveBeenCalledWith({ lease, rootTaskId: "current-root-task", rootAttemptCount: 2, stepId: "step-history-composition", now })
    expect(persistedCheckpoint).toEqual({ inputThroughSequence: 5n, consumedInputIds: [steerInput.id] })
    expect(context.inputThroughSequence).toBe(5n)
    expect(context.consumedInputIds).toEqual([steerInput.id])
    expect(context.taskGraphRevision).toBe(23)
    expect(clarification).toMatchObject({ source: "native_question_recovery", trust: "internal_record", content: { graphRevisionAtAsk: 23, observedPlanRevision: 22 } })
    expect(graphBlock?.content).toMatchObject({ kind: "task_graph_current", revision: 23, taskReportedCounts: currentCounts, nodes: [{ key: "current-graph-node", taskId: "current-graph-task" }] })
    expect(historyBlock).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    expect(historyBlock?.content).toMatchObject({ kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true })
    expect(scoutFailure).toMatchObject({ taskKind: "scout", status: "failed", lesson: {
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }, { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" }],
    } })
    expect(analystFailure).toMatchObject({ taskKind: "analyst", status: "failed", lesson: {
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }, { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" }],
    } })
    expect(exactRepair).toMatchObject({ taskKind: "analyst", status: "completed", lesson: {
      nodeOrdinal: 3, successfulRepairs: [{ targetNodeOrdinal: 2, targetCriterionOrdinals: [1, 2], status: "passed" }],
    } })
    expect(unresolvedRepair).toMatchObject({ taskKind: "scout", status: "failed", negativeReasonHints: ["repair_target_unresolved"] })
    expect(scoutOutput).toMatchObject({ reportedOutput: { role: "scout", candidateCount: 5, resultStatus: "partial" } })
    expect(analystOutput).toMatchObject({ reportedOutput: { role: "analyst", findingCount: 6, resultStatus: "partial" } })
    expect(zeroOutput).toMatchObject({ reportedOutput: { role: "scout", candidateCount: 0, resultStatus: "completed" } })
    expect(historyNodes.find(node => node.taskKind === "scout" && node.status === "failed" && !(node.negativeReasonHints as unknown[] | undefined)?.includes("repair_target_unresolved")))
      .not.toHaveProperty("reportedOutput")
    expect(requestMessages.some(message => message.role === "user" && message.text.includes("root_task_history") && message.text.includes("UNTRUSTED_DATA"))).toBe(true)
    expect(requestText).toContain("FULL_ORIGINAL_ROOT_REFERENCE")
    expect(requestText).toContain("CURRENT_ACCEPTED_STEER_SENTINEL")
    expect(requestText).toContain("CURRENT_GOAL_SENTINEL")
    expect(requestText).toContain("Which city should I prioritize?")
    expect(requestText).toContain("Amsterdam, with Dublin as a backup.")
    expect(requestText).toContain('"graphRevisionAtAsk":23')
    expect(requestText).toContain("CURRENT_GRAPH_SENTINEL")
    expect(requestText).toContain('"discoveredJobs":{"coverage":"partial","knownCount":23}')
    expect(requestText).toContain('"candidateCount":5')
    expect(requestText).toContain('"findingCount":6')
    expect(requestText).toContain('"candidateCount":0')
    expect(requestText).toContain('"kind":"candidate_count_gte"')
    expect(requestText).toContain('"kind":"evidence_count_gte"')
    expect(requestText).toContain('"minimum":8')
    expect(requestText).not.toContain("CALLER_HISTORY_SPOOF")
    const historyGuidance = requestMessages.filter(message => message.role === "system"
      && message.text.includes("Earlier same-session failures, repairs, and reported outputs are hypotheses only"))
    expect(historyGuidance).toHaveLength(1)
    expect(historyGuidance[0]?.text).toContain("current verifier evidence, and complete current result pages")
    expect(historyGuidance[0]?.text).toContain("owner-read graph observation for current node, criterion, and revision identities")
    expect(historyGuidance[0]?.text).toContain("visible agent.list only for matching result pages")
    expect(historyGuidance[0]?.text).toContain("expectedRevision 23")
    expect(historyGuidance[0]?.text).toContain("preserve the valid plan")
    expect(historyGuidance[0]?.text).toContain("Historical typed-check descriptors distinguish count, evidence-completeness, score, Scout-dependency, and declared cohort-coverage failure shapes only")
    expect(historyGuidance[0]?.text).not.toContain("root_task_history")
    for (const historicalFact of ["source_graph_local", "nodeOrdinal", "criterionOrdinal", "targetNodeOrdinal", "candidate_count_gte",
      '"minimum":8', '"candidateCount":5', '"findingCount":6']) {
      expect(historyGuidance[0]?.text).not.toContain(historicalFact)
    }
    const privateValues = [
      HISTORY_ROOT_ID, "PRIVATE_HISTORY_SOURCE_TURN", "PRIVATE_HISTORY_GRAPH_ITEM", "PRIVATE_HISTORY_SCOUT_FAILURE", "PRIVATE_HISTORY_ANALYST_FAILURE",
      "PRIVATE_HISTORY_ANALYST_REPAIR", "PRIVATE_HISTORY_SCOUT_TASK", "PRIVATE_HISTORY_ANALYST_TASK", "PRIVATE_HISTORY_REPAIR_TASK",
      "private-scout-count", "private-scout-evidence", "private-analyst-count-a", "private-analyst-count-b", "private-scout-repair-check",
      "PRIVATE_HISTORY_SCOUT_GOAL", "PRIVATE_HISTORY_ANALYST_GOAL", "PRIVATE_HISTORY_REPAIR_GOAL", "PRIVATE_SCOUT_JOB_1", "PRIVATE_ANALYST_JOB_1",
      "PRIVATE_SCOUT_EVIDENCE_1", "PRIVATE_ANALYST_EVIDENCE_1", "https://private.example/", "PRIVATE_SCOUT_SUMMARY", "PRIVATE_ANALYST_SUMMARY",
      "PRIVATE_HISTORY_FINAL_ITEM", "PRIVATE_HISTORY_FINAL_TEXT", "taskGraphRepairReceipt", "verificationReport", "evidenceDigest", "resultDigest",
      "sourceTurnId", "sourceRootTaskId", "terminalSequence", "repairNodeKey", "targetTaskId", "graphDigest",
    ]
    for (const privateValue of privateValues) {
      expect(historyJson).not.toContain(privateValue)
      expect(requestText).not.toContain(privateValue)
      expect(historyGuidance[0]?.text).not.toContain(privateValue)
    }
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlock?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })

  it("keeps Root-task history disabled for selected-job turns", async () => {
    const rootReader: DirectRootTaskHistoryReader = { load: vi.fn(async () => []) }
    const selectedJobReader: DirectSelectedJobHistoryReader = { load: vi.fn(async () => []) }
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("injected history readers avoid database connections") } } as unknown as Pick<pg.Pool, "connect">,
      store: store([]), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: true, selectedJobMode: true, selectedJobId: "job-a",
      rootTaskHistoryDirectReader: rootReader, selectedJobDirectHistoryReader: selectedJobReader,
      currentRootBudgetReader: async () => unavailableBudget,
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-selected-job", snapshot: {
        system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [],
      },
    })

    expect(rootReader.load).not.toHaveBeenCalled()
    expect(selectedJobReader.load).toHaveBeenCalledTimes(1)
    expect(context.blocks.find(block => block.id === "observation:turn-budget-current")).toMatchObject({
      layer: "tool_observation", role: "data", trust: "external_untrusted", content: unavailableBudget,
    })
  })

  it("rolls back and releases the owned budget snapshot client when tenant setup fails", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
        if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") return { rows: [] }
        if (sql === "SELECT set_config('app.user_id', $1, true)") throw new Error("budget_tenant_setup_failed")
        if (sql.includes('SELECT root_task."budgetSnapshot"')) throw new Error("budget_read_failed")
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => client } as unknown as Pick<pg.Pool, "connect">,
      store: store([]), baseBuilder: new StepContextBuilder(store([]), ownerFence), scope, lease,
      rootTaskId: "root-a", rootAttemptCount: 2, planningEnabled: true, selectedJobMode: false,
      rootTaskHistoryDirectReader: { load: async () => [] },
    })

    await expect(builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-budget-failure",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    })).rejects.toThrow("budget_tenant_setup_failed")
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT set_config('app.user_id', $1, true)",
      "ROLLBACK",
    ])
    expect(client.query.mock.calls[1]?.[1]).toEqual([scope.userId])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("adds validated same-job history to the actual request as untrusted data beside current Turn context", async () => {
    const jobId = "selected-job-a"
    const graphNode = {
      key: "current-analyst", templateId: "analyst", taskId: "current-task", goal: "CURRENT_GRAPH_SENTINEL",
      successCriteria: [], dependsOn: [], status: "completed", readiness: "terminal",
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId, score: 9, evidenceKinds: ["job"] }],
      },
    }
    const memory = (sourceTurnId: string, sourceRootTaskId: string, score: number) => {
      const value = projectSelectedJobMemory({ jobId, sourceTurnId, sourceRootTaskId, throughSequence: "17", graph: { revision: 4, nodes: [{
        ...graphNode, resultProjection: { ...graphNode.resultProjection, findings: [{ jobId, score, evidenceKinds: ["job"] }] },
      }] } })
      if (!value) throw new Error("selected-job memory fixture was invalid")
      return value
    }
    const currentMemory = memory(lease.turnId, "root-a", 9)
    const otherJobMemory = projectSelectedJobMemory({ jobId: "other-job", sourceTurnId: lease.turnId, sourceRootTaskId: "root-a", throughSequence: "17", graph: { revision: 4, nodes: [{
      ...graphNode, resultProjection: { ...graphNode.resultProjection, findings: [{ jobId: "other-job", score: 1, evidenceKinds: ["job"] }] },
    }] } })!
    const priorMemory = memory("private-prior-turn", "private-prior-root", 6.5)
    const historyReader: SelectedJobHistoryReader = {
      load: vi.fn(async () => [{ record: priorMemory, terminalSequence: 12n }]),
    }
    const steer: StoredAgentInput = {
      id: "steer-current", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "steer-current", delivery: "steer", status: "consumed",
      content: [{ type: "text", text: "CURRENT_STEERING_SENTINEL: include Berlin roles" }], acceptedSequence: 3n,
      consumedByStepId: "step-current", consumedAt: now, createdAt: now,
    }
    const claimStore: InputClaimStore = {
      scope,
      withTransaction: work => work({
        getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [steer], newlyClaimedInputIds: [steer.id] }),
        persistCheckpoint: async () => undefined,
      }),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const baseBuilder = new StepContextBuilder(claimStore, ownerFence)
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the injected history reader avoids another database client") } } as unknown as Pick<pg.Pool, "connect">,
      store: claimStore, baseBuilder, scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: false, selectedJobMode: true, selectedJobMemories: [otherJobMemory, currentMemory], selectedJobId: jobId,
      selectedJobHistoryReader: historyReader,
    })
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "system-rule", content: "fixed system policy" }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_SENTINEL: find suitable roles" },
      steerHistory: [{ id: "qa-current", content: { question: "Preferred city?", answer: "Berlin" } }],
      businessRefs: [{ id: jobId, kind: "job", ownerId: scope.userId, label: "Selected role" }],
      toolObservations: [
        { id: "task-graph-current", content: { kind: "task_graph_current", revision: 4, nodes: [graphNode] } },
        { id: "unrelated", content: { text: "must be filtered" } },
      ],
    }
    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-current", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-current", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const text = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const historyBlock = context.blocks.find(block => block.id === "observation:selected-job-history")
    const serializedHistory = JSON.stringify(historyBlock?.content)
    const systemText = request.messages.filter(message => message.role === "system").flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(historyReader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-current", jobId, records: [otherJobMemory, currentMemory], now,
    })
    expect(text).toContain("selected_job_history")
    expect(text).toContain('"score":6.5')
    expect(text).toContain("CURRENT_GOAL_SENTINEL")
    expect(text).toContain("CURRENT_STEERING_SENTINEL")
    expect(text).toContain("Preferred city?")
    expect(text).toContain("CURRENT_GRAPH_SENTINEL")
    expect(text).toContain("selected_job_memory")
    expect(text).not.toContain("other-job")
    expect(text).not.toContain("must be filtered")
    expect(historyBlock).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    for (const privateValue of ["private-prior-turn", "private-prior-root", jobId, "graphDigest", "terminalSequence", "verification", "criteria", "PASS"]) {
      expect(serializedHistory).not.toContain(privateValue)
    }
    expect(systemText).not.toContain("private-prior")
    expect(systemText).not.toContain(jobId)
    expect(request.tools).toEqual([{ name: "agent.plan", version: "1" }])
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlock?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })

  it("recalls direct outcomes with compaction records absent and keeps fresh current context through token admission", async () => {
    const jobId = "selected-job-direct-a"
    const failedNode: SelectedJobMemoryNode = {
      role: "analyst", status: "failed", readiness: "terminal", repairState: "none",
      verification: { status: "failed", criteria: [
        { status: "failed", reasonCode: "reported_score_below_minimum" },
        { status: "failed", reasonCode: "criterion_not_met" },
        { status: "failed", reasonCode: "reported_score_below_minimum" },
      ] },
      result: { availability: "available", role: "analyst", status: "completed", score: 6.5, evidenceKinds: ["job"] },
    }
    const unverifiedNode: SelectedJobMemoryNode = {
      ...failedNode, verification: { status: "unverified", criteria: [
        { status: "unverified", reasonCode: "canonical_evidence_missing" },
        { status: "unverified", reasonCode: "canonical_evidence_missing" },
      ] },
    }
    const outcomes: readonly ValidatedSelectedJobHistoryOutcome[] = [
      { jobId, sourceTurnId: "private-source-turn", sourceRootTaskId: "private-source-root", terminalSequence: 12n, nodes: [failedNode] },
      { jobId, sourceTurnId: "private-unverified-turn", sourceRootTaskId: "private-unverified-root", terminalSequence: 11n, nodes: [unverifiedNode] },
    ]
    const directReader: DirectSelectedJobHistoryReader = { load: vi.fn(async () => outcomes) }
    const steer: StoredAgentInput = {
      id: "fresh-steer-direct", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "fresh-steer-direct", delivery: "steer", status: "consumed",
      content: [{ type: "text", text: "FRESH_STEERING_SENTINEL: prioritize Dublin" }], acceptedSequence: 3n,
      consumedByStepId: "step-direct", consumedAt: now, createdAt: now,
    }
    const claimStore: InputClaimStore = {
      scope,
      withTransaction: work => work({
        getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [steer], newlyClaimedInputIds: [steer.id] }),
        persistCheckpoint: async () => undefined,
      }),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const baseBuilder = new StepContextBuilder(claimStore, ownerFence)
    const currentGraph = {
      key: "current-analyst", templateId: "analyst", taskId: "current-task", goal: "CURRENT_GRAPH_DIRECT_SENTINEL",
      successCriteria: [], dependsOn: [], status: "completed", readiness: "terminal",
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId, score: 8, evidenceKinds: ["job"] }],
      },
    }
    const sameTurnMemory = projectSelectedJobMemory({
      jobId, sourceTurnId: lease.turnId, sourceRootTaskId: "root-a", throughSequence: "18", graph: { revision: 5, nodes: [currentGraph] },
    })
    if (!sameTurnMemory) throw new Error("current selected-job memory fixture was invalid")
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the direct reader and injected builder avoid another client") } } as unknown as Pick<pg.Pool, "connect">,
      store: claimStore, baseBuilder, scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: false, selectedJobMode: true, selectedJobMemories: [sameTurnMemory], selectedJobId: jobId,
      selectedJobDirectHistoryReader: directReader,
    })
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "fixed-system", content: "Keep current authorization checks." }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_DIRECT_SENTINEL: find Dublin roles" },
      steerHistory: [{ id: "qa-current", content: { question: "Preferred location?", answer: "Dublin" } }],
      taskGraphRevision: 5,
      businessRefs: [{ id: jobId, kind: "job", ownerId: scope.userId, label: "Current selected role" }],
      toolObservations: [{ id: "task-graph-current", content: { kind: "task_graph_current", revision: 5, nodes: [currentGraph] } }],
    }
    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-direct", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-direct", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const messageText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const historyBlocks = context.blocks.filter(block => block.id === "observation:selected-job-history")
    const history = JSON.stringify(historyBlocks[0]?.content)
    const systemText = request.messages.filter(message => message.role === "system").flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(directReader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-direct", jobId, now,
    })
    expect(historyBlocks).toHaveLength(1)
    expect(messageText).toContain("selected_job_history")
    expect(messageText).toContain('"score":6.5')
    expect(messageText).toContain('"reasonHints":["criterion_not_met","reported_score_below_minimum"]')
    expect(messageText).toContain('"reasonHints":["canonical_evidence_missing"]')
    expect(messageText).toContain("selected_job_memory")
    expect(messageText).toContain('"score":8')
    expect(messageText).toContain("CURRENT_GOAL_DIRECT_SENTINEL")
    expect(messageText).toContain("FRESH_STEERING_SENTINEL")
    expect(messageText).toContain("Preferred location?")
    expect(messageText).toContain("CURRENT_GRAPH_DIRECT_SENTINEL")
    expect(context.taskGraphRevision).toBe(5)
    expect(historyBlocks[0]).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    for (const privateValue of ["private-source-turn", "private-source-root", "private-unverified-turn", "private-unverified-root", jobId,
      "terminalSequence", "verification", "criteria", "criteria_met", "criterionId", "evidenceDigest", "resultDigest", "PASS"]) {
      expect(history).not.toContain(privateValue)
    }
    for (const privateValue of ["private-source-turn", "private-source-root", "private-unverified-turn", "private-unverified-root", jobId]) {
      expect(systemText).not.toContain(privateValue)
    }
    expect(systemText).not.toContain("reported_score_below_minimum")
    expect(systemText).not.toContain("canonical_evidence_missing")
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlocks[0]?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })
})
