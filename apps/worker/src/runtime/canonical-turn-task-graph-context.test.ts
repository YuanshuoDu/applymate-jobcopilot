import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { isSelectedJobRootTool, loadTaskGraphCurrentObservation, mergeTaskGraphCurrentObservation, selectedJobSnapshot, selectedJobToolAllowed } from "./canonical-turn-task-graph-context.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import { StepContextBuilder, type StepContextSnapshot } from "./context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { buildModelRequest } from "./turns/turn-engine-messages.js"
import type { TurnLease } from "./turns/lease.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./subagents/task-graph-command-port.js"
import { applyCompletionRecovery, tagTaskGraphRepairRecovery } from "./turns/completion-recovery-context.js"
import { TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT } from "./subagents/task-graph-source-intent-context.js"

const state: TaskGraphCurrentState = {
  revision: 3,
  nodes: [{
    key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [],
    taskId: "child-1", status: "completed", readiness: "terminal", inputRelation: "predates_current_inputs",
    resultSummary: "Alice Example found two roles", failureReason: "Alice Example failed at https://private.example/apply",
    resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "scout", status: "completed",
      candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
    },
    verificationCriterionIds: ["candidate-count"],
    verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }], evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
    },
  }],
}

function snapshot(): StepContextSnapshot {
  return {
    system: [], profile: [], steerHistory: [], businessRefs: [],
    toolObservations: [
      { id: "existing", content: { kept: true } },
      { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1, nodes: [] } },
    ],
  }
}

function emptyInputStore(): InputClaimStore {
  const scope: TenantScope = { userId: "user-1" }
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

async function selectedJobModelRequest(value: StepContextSnapshot) {
  const scope: TenantScope = { userId: "user-1" }
  const context = await new StepContextBuilder(emptyInputStore()).build({
    scope, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", snapshot: selectedJobSnapshot(value), now: new Date(0),
  })
  const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
  return buildModelRequest({ context, model, tools: [], sessionId: "session-1", turnId: "turn-1", stepId: "step-1", userId: "user-1", taskId: "root-1", signal: new AbortController().signal })
}

describe("TaskGraph turn observation", () => {
  it("keeps selected-job root observations scoped to coordination and the current graph", () => {
    const original = {
      ...snapshot(),
      toolObservations: [
        { id: "search-result", content: { toolName: "jobs.search" } },
        { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } },
        { id: "question-result:ask-1", content: { toolName: "agent.ask_user", status: "completed", output: { kind: "user_question", stage: "user_input", question: "Which city?" } } },
        { id: "reconciliation-result:keep-1", content: { toolName: "agent.reconcile", output: { decision: "keep", revision: 2, reconciledInputCount: 1 } } },
        { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1 } },
      ],
    }
    expect(selectedJobSnapshot(original).toolObservations.map(item => item.id)).toEqual(["wait-result:wait-1", "question-result:ask-1", "reconciliation-result:keep-1", "task-graph-current"])
    expect(isSelectedJobRootTool({ name: "agent.plan" })).toBe(true)
    expect(isSelectedJobRootTool({ name: "agent.ask_user" })).toBe(true)
    expect(isSelectedJobRootTool({ name: "agent.reconcile" })).toBe(true)
    expect(selectedJobToolAllowed("agent.ask_user")).toBe(true)
    expect(selectedJobToolAllowed("agent.reconcile")).toBe(true)
    expect(selectedJobToolAllowed("jobs.search")).toBe(false)
  })

  it("keeps durable session memory out of the selected-job captured model request", async () => {
    const original = {
      ...snapshot(),
      toolObservations: [
        { id: "snapshot-working-state:session-1:7", content: {
          kind: "durable_context_snapshot", status: "available", authority: "informational_only",
          provenance: { ownerId: "user-1", sessionId: "session-1", throughSequence: "7" },
          answers: [{ id: "answer-secret", answer: "work authorization answer" }], artifacts: [{ id: "resume-secret", hash: "private resume hash" }],
        } },
        { id: "snapshot-working-state:session-2:9", content: {
          kind: "durable_context_snapshot", status: "available", authority: "informational_only",
          provenance: { ownerId: "user-2", sessionId: "session-2", throughSequence: "9" },
          goal: "foreign job context",
        } },
        { id: "snapshot-working-state:session-1:invalid", content: { kind: "durable_context_snapshot", status: "unavailable" } },
        { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } },
        { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1, nodes: [] } },
      ],
    }

    const filtered = selectedJobSnapshot(original)
    expect(filtered.toolObservations.map(item => item.id)).toEqual(["wait-result:wait-1", "task-graph-current"])
    const request = await selectedJobModelRequest(original)
    const text = request.messages.flatMap(message => message.content)
      .flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(text).toContain("task_graph_current")
    expect(text).not.toContain("context_snapshot_working_state")
    expect(text).not.toContain("answer-secret")
    expect(text).not.toContain("private resume hash")
    expect(text).not.toContain("foreign job context")
  })

  it("refreshes the old graph observation while preserving other observations and live outcomes", () => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), state)

    expect(result.taskGraphRevision).toBe(3)
    expect(result.toolObservations).toEqual([
      { id: "existing", content: { kept: true } },
      { id: "task-graph-current", content: { kind: "task_graph_current", revision: 3, nodes: [{ ...state.nodes[0]!, resultSummary: null, failureReason: null }] } },
    ])
    const encoded = JSON.stringify(result.toolObservations.at(-1)?.content)
    expect(encoded).not.toContain("Alice Example")
    expect(encoded).not.toContain("private.example")
  })

  it("replaces stale revision metadata from the typed read, including graph revision zero", () => {
    const result = mergeTaskGraphCurrentObservation({ ...snapshot(), taskGraphRevision: 8 }, { revision: 0, nodes: [] })

    expect(result.taskGraphRevision).toBe(0)
    expect(result.toolObservations.at(-1)?.content).toEqual({ kind: "task_graph_current", revision: 0, nodes: [] })
  })

  it("retires stale ordinal recovery after a trusted refresh and keeps unrelated seeds", () => {
    const currentRepair = applyCompletionRecovery(snapshot(), "step-current", tagTaskGraphRepairRecovery(
      "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing. issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing",
      5,
    )).system[0]!
    const input = { ...snapshot(), system: [
      { id: "completion-recovery:task-graph:4", content: "old ordinal repair" },
      currentRepair,
      { id: "completion-recovery:task-graph:unversioned", content: "generic repair" },
      { id: "completion-recovery:old-step", content: "Durable TaskGraph verification blocked completion: legacy" },
      { id: "policy:task-graph", content: "Durable TaskGraph verification blocked completion: policy" },
    ] }
    const result = mergeTaskGraphCurrentObservation(input, { revision: 5, nodes: [] })
    expect(result.system.map(seed => seed.id)).toEqual(["completion-recovery:task-graph:5", "policy:task-graph"])
  })

  it("preserves safe native operation and structural result receipts in the current graph", () => {
    const native = { operationKind: "spawn" as const, operationId: "operation-1", requestFingerprint: "f".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: "c".repeat(64) }
    const nativeResult = { schemaVersion: "agent-harness.v2.task-graph.native-result.v1" as const, role: "scout", taskStatus: "completed" as const, disposition: "opaque" as const, resultDigest: "d".repeat(64) }
    const result = mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{
      ...state.nodes[0]!, native, nativeResult, context: { secret: true }, result: { secret: true },
      causationId: "private-step", sourceStepId: "private-step", inputThroughSequence: "42", consumedInputIds: ["private-input"],
    } as never] })
    const node = (result.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[0]!

    expect(node).toMatchObject({ native, nativeResult, inputRelation: "predates_current_inputs" })
    expect(JSON.stringify(node)).not.toContain("secret")
    expect(JSON.stringify(node)).not.toContain("private-step")
    expect(JSON.stringify(node)).not.toContain("private-input")
    expect(JSON.stringify(node)).not.toContain("inputThroughSequence")
  })

  it("fails closed instead of giving the model a partial or unbounded graph", () => {
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: Array.from({ length: 17 }, () => state.nodes[0]!) })).toThrow("task_graph_current_state_invalid")
    const bounded = mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, resultSummary: "x".repeat(30_000) }] })
    expect((bounded.toolObservations.at(-1)?.content as { nodes: Array<{ resultSummary: string | null }> }).nodes[0]?.resultSummary).toBeNull()
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, taskId: "x".repeat(129) }] })).toThrow("task_graph_current_state_invalid:taskId")
  })

  it("strictly preserves bounded verifier evidence and rejects mismatched criterion IDs", () => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), state)
    const node = (result.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[0]!
    expect(node).toMatchObject({ verificationCriterionIds: ["candidate-count"], verificationReport: state.nodes[0]!.verificationReport })
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, nodes: [{ ...state.nodes[0]!, verificationReport: { ...state.nodes[0]!.verificationReport!, privateText: "person@example.com" } as never }],
    })).toThrow("task_graph_current_state_invalid:verification")
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, nodes: [{ ...state.nodes[0]!, verificationCriterionIds: ["foreign"] }],
    })).toThrow("task_graph_current_state_invalid:verification")
    expect(JSON.stringify(node)).not.toContain("Alice Example")
  })

  it("keeps repair receipts separate and bound to a passing repair report", () => {
    const report = { ...state.nodes[0]!.verificationReport!, status: "passed" as const, reasonCode: "criteria_met" as const, criteria: [{ criterionId: "candidate-count", status: "passed" as const, reasonCode: "criteria_met" as const }], evidenceDigest: "b".repeat(64) }
    const repairOf = { graphRootTaskId: "root-1", nodeKey: "original", taskId: "target-1", criterionIds: ["candidate-count"] }
    const repairReceipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1", targetNodeKey: "original", targetTaskId: "target-1", criterionIds: ["candidate-count"], repairNodeKey: "research", repairTaskId: "child-1", verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: report.evidenceDigest }
    const projected = mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, verificationReport: report, repairOf, repairReceipt }] })
    const node = (projected.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[0]!
    expect(node).toMatchObject({ repairOf, repairReceipt, verificationReport: report })
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, verificationReport: state.nodes[0]!.verificationReport, repairOf, repairReceipt }] })).toThrow("task_graph_current_state_invalid:verification")
  })

  it("carries the bounded persisted result into a resumed root model observation", async () => {
    const persistedState: TaskGraphCurrentState = {
      ...state,
      nodes: [{ ...state.nodes[0]!, resultSummary: "Alice Example summary must stay hidden" }],
    }
    const readCurrent = vi.fn(async () => persistedState)
    const readCurrentForPlanning = vi.fn(async () => persistedState)
    const port: TaskGraphCommandPort = {
      readCurrent,
      readCurrentForPlanning,
      appendAndSchedule: async () => { throw new Error("unused") },
    }
    const lease: TurnLease = {
      turnId: "turn-1", sessionId: "session-1", ownerId: "turn-owner", userId: "user-1", leaseVersion: 2,
      leaseStartedAt: new Date("2026-09-25T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-25T00:01:00.000Z"),
    }
    const resumed = await loadTaskGraphCurrentObservation(snapshot(), port, lease, { id: "root-1", attemptCount: 2 })
    const observation = resumed.toolObservations.at(-1)?.content as {
      nodes: Array<{ resultSummary: string | null; resultProjection: unknown }>
    }

    expect(observation.nodes[0]).toMatchObject({
      resultSummary: null,
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
        trust: "untrusted", availability: "available", role: "scout", candidateCount: 1,
        candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
      },
    })
    expect(JSON.stringify(observation)).not.toContain("Alice Example")
    expect(JSON.stringify(observation)).not.toContain("private.example")
    expect(readCurrentForPlanning).toHaveBeenCalledOnce()
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it("replaces unsafe result projections with an untrusted unavailable marker", () => {
    const invalidProjection = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
      trust: "untrusted", availability: "available", role: "scout", status: "completed",
      candidateCount: 1, evidenceCount: 1,
      candidates: [{
        jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"],
        url: "https://private.example/apply", summary: "Jane Doe",
      }],
    }
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, nodes: [{ ...state.nodes[0]!, resultProjection: invalidProjection as never }],
    })
    const observation = result.toolObservations.at(-1)?.content as { nodes: Array<{ resultProjection: unknown }> }

    expect(observation.nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
    expect(JSON.stringify(observation)).not.toContain("private.example")
    expect(JSON.stringify(observation)).not.toContain("Jane Doe")
  })

  it("adds only fresh counts to the top-level Root observation", () => {
    const counts = {
      discoveredJobs: { knownCount: 12, coverage: "partial" },
      analyzedJobs: { knownCount: 7, coverage: "complete" },
      artifactReferences: { knownCount: null, coverage: "not_requested" },
      reviewOutcomes: { knownCount: null, coverage: "unavailable" },
    }
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, planningFacts: { graphRevision: 3, counts },
    } as unknown as TaskGraphCurrentState)
    const observation = result.toolObservations.at(-1)?.content as Record<string, unknown>

    expect(observation.taskReportedCounts).toEqual(counts)
    expect(JSON.stringify(observation.taskReportedCounts).length).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(observation.taskReportedCounts)).not.toContain("taskId")
    expect(JSON.stringify(observation.taskReportedCounts)).not.toContain("private-hash")
  })

  it.each([
    ["stale revision", { graphRevision: 2, counts: {
      discoveredJobs: { knownCount: 1, coverage: "complete" },
      analyzedJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "not_requested" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    } }],
    ["augmented facts", { graphRevision: 3, taskIds: ["private-task"], counts: {
      discoveredJobs: { knownCount: 1, coverage: "complete" },
      analyzedJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "not_requested" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    } }],
    ["invalid count combination", { graphRevision: 3, counts: {
      discoveredJobs: { knownCount: 0, coverage: "unavailable" },
      analyzedJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "not_requested" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    } }],
  ])("omits %s from the model observation", (_label, planningFacts) => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, planningFacts,
    } as unknown as TaskGraphCurrentState)
    const observation = result.toolObservations.at(-1)?.content as Record<string, unknown>

    expect(Object.hasOwn(observation, "taskReportedCounts")).toBe(false)
    expect(observation.nodes).toEqual((mergeTaskGraphCurrentObservation(snapshot(), state)
      .toolObservations.at(-1)?.content as { nodes: unknown[] }).nodes)
  })

  it("does not evaluate a planning-facts accessor on the current-state object", () => {
    let getterRead = false
    const unsafeState = { ...state }
    Object.defineProperty(unsafeState, "planningFacts", {
      enumerable: true,
      get() {
        getterRead = true
        return { graphRevision: 3, counts: {} }
      },
    })

    const result = mergeTaskGraphCurrentObservation(snapshot(), unsafeState as unknown as TaskGraphCurrentState)
    const observation = result.toolObservations.at(-1)?.content as Record<string, unknown>

    expect(getterRead).toBe(false)
    expect(Object.hasOwn(observation, "taskReportedCounts")).toBe(false)
  })

  it("keeps fresh counts when node result projections exceed the item budget", () => {
    const counts = {
      discoveredJobs: { knownCount: 27, coverage: "complete" },
      analyzedJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "not_requested" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    }
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      ...state.nodes[0]!,
      key: "research-" + index,
      taskId: "child-" + index,
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
        trust: "untrusted" as const,
        availability: "available" as const,
        role: "scout" as const,
        status: "completed" as const,
        candidateCount: 3,
        evidenceCount: 3,
        candidates: Array.from({ length: 3 }, (_, item) => ({
          jobId: "job-" + index + "-" + item, source: "greenhouse" as const, evidenceKinds: ["job" as const],
        })),
      },
    } as never))
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, nodes, planningFacts: { graphRevision: 3, counts },
    } as unknown as TaskGraphCurrentState)
    const observation = result.toolObservations.at(-1)?.content as {
      taskReportedCounts?: unknown
      nodes: Array<{ resultProjection: { availability: string } }>
    }

    expect(observation.taskReportedCounts).toEqual(counts)
    expect(observation.nodes.slice(0, 8).every(node => node.resultProjection.availability === "available")).toBe(true)
    expect(observation.nodes[8]?.resultProjection.availability).toBe("unavailable")
    expect(JSON.stringify(observation).length).toBeLessThan(160_000)
  })

  it("drops only optional relations when they alone overflow the Root observation cap", () => {
    const counts = {
      discoveredJobs: { knownCount: 12, coverage: "partial" as const },
      analyzedJobs: { knownCount: 7, coverage: "complete" as const },
      artifactReferences: { knownCount: null, coverage: "not_requested" as const },
      reviewOutcomes: { knownCount: null, coverage: "unavailable" as const },
    }
    const native = {
      operationKind: "spawn", operationId: "o".repeat(256), requestFingerprint: "f".repeat(64),
      callerTaskId: "c".repeat(128), role: "r".repeat(64), taskType: "t".repeat(128), contextDigest: "d".repeat(64),
      source: {
        taskId: "t".repeat(128), rootTaskId: "r".repeat(128), parentTaskId: "p".repeat(128), turnId: "u".repeat(128),
        role: "s".repeat(64), taskType: "y".repeat(128), status: "completed", attemptCount: 1,
        resultDigest: "a".repeat(64), graphNodeKey: "g".repeat(128), origin: "task_graph",
      },
    }
    const nativeResult = {
      schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: native.role,
      taskStatus: "completed", disposition: "opaque", resultDigest: "e".repeat(64),
    }
    const graphKeys = Array.from({ length: 16 }, (_, index) => `node-${index}-` + "k".repeat(118))
    const buildState = (goalLength: number): TaskGraphCurrentState => {
      const nodes = Array.from({ length: 16 }, (_, index) => {
        const key = graphKeys[index]!
        const taskId = `task-${index}-` + "i".repeat(120)
        const criterionIds = Array.from({ length: 8 }, (_, criterion) => `c${criterion}` + "x".repeat(62))
        const evidenceDigest = "b".repeat(64)
        const verificationReport = {
          verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
          criteria: criterionIds.map(criterionId => ({ criterionId, status: "passed", reasonCode: "criteria_met" })),
          evidenceDigest, resultDigest: "e".repeat(64),
        }
        const repairOf = {
          graphRootTaskId: "g".repeat(128), nodeKey: "n".repeat(128), taskId: "t".repeat(128), criterionIds,
        }
        const repairReceipt = {
          schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: repairOf.graphRootTaskId,
          targetNodeKey: repairOf.nodeKey, targetTaskId: repairOf.taskId, criterionIds,
          repairNodeKey: key, repairTaskId: taskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest,
        }
        return {
          key, templateId: "template-" + "m".repeat(119), goal: "g".repeat(goalLength),
          successCriteria: Array(8).fill("s".repeat(320)), dependsOn: graphKeys, taskId,
          status: "completed", readiness: "terminal", inputRelation: "unknown", native, nativeResult,
          resultProjection: {
            schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
            role: "scout", status: "completed", candidateCount: 3, evidenceCount: 12,
            candidates: Array.from({ length: 3 }, (_, candidate) => ({
              jobId: `job-${index}-${candidate}-` + "j".repeat(65), source: "greenhouse", evidenceKinds: ["job", "persona", "resume", "source"],
            })),
          },
          ...(index < 7 ? { verificationCriterionIds: criterionIds, verificationReport, repairOf, repairReceipt } : {}),
        }
      })
      return { revision: 3, nodes, planningFacts: { graphRevision: 3, counts } } as unknown as TaskGraphCurrentState
    }

    let lower = 0
    let upper = 1200
    let relationFreeWithCounts: Record<string, unknown> | undefined
    while (lower <= upper) {
      const goalLength = Math.floor((lower + upper) / 2)
      try {
        const result = mergeTaskGraphCurrentObservation(snapshot(), buildState(goalLength))
        const content = result.toolObservations.at(-1)?.content as Record<string, unknown>
        const nodes = content.nodes as Array<Record<string, unknown>>
        if (Object.hasOwn(nodes[0]!, "inputRelation")) lower = goalLength + 1
        else {
          if (Object.hasOwn(content, "taskReportedCounts")) relationFreeWithCounts = content
          lower = goalLength + 1
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "task_graph_current_state_too_large") throw error
        upper = goalLength - 1
      }
    }

    expect(relationFreeWithCounts).toBeDefined()
    const content = relationFreeWithCounts!
    const nodes = content.nodes as Array<Record<string, unknown>>
    expect(nodes).toHaveLength(16)
    expect(nodes.every(node => !Object.hasOwn(node, "inputRelation"))).toBe(true)
    expect(nodes[0]).toMatchObject({ native, nativeResult, resultProjection: { availability: "available" } })
    expect(nodes[0]?.verificationReport).toMatchObject({ status: "passed", reasonCode: "criteria_met" })
    expect(content.taskReportedCounts).toEqual(counts)
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
    expect(JSON.stringify({
      ...content, nodes: nodes.map(node => ({ ...node, inputRelation: "unknown" })),
    }).length).toBeGreaterThan(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
  })
})
