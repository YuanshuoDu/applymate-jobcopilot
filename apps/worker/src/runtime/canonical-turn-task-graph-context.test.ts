import { describe, expect, it } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { isSelectedJobRootTool, loadTaskGraphCurrentObservation, mergeTaskGraphCurrentObservation, selectedJobSnapshot, selectedJobToolAllowed } from "./canonical-turn-task-graph-context.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState, TaskGraphVerificationReport } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import { StepContextBuilder, type StepContextSnapshot } from "./context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { buildModelRequest } from "./turns/turn-engine-messages.js"
import type { TurnLease } from "./turns/lease.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./subagents/task-graph-command-port.js"
import { applyCompletionRecovery, tagTaskGraphRepairRecovery } from "./turns/completion-recovery-context.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "./planning/task-graph-verification.js"
import { taskGraphCurrentVerificationMetadataBytes } from "./canonical-turn-task-graph-verification-context.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./subagents/child-discovery-attempt.js"

const state: TaskGraphCurrentState = {
  revision: 3,
  nodes: [{
    key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [],
    taskId: "child-1", status: "completed", readiness: "terminal",
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

const currentScoutVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
    { id: "candidate-floor", check: { kind: "candidate_count_gte", minimum: 2 } },
    { id: "evidence-floor", check: { kind: "evidence_count_gte", minimum: 3 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 2 } },
  ],
}
const currentAnalystVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
    { id: "finding-floor", check: { kind: "finding_count_gte", minimum: 1 } },
    { id: "analyst-evidence-floor", check: { kind: "evidence_count_gte", minimum: 2 } },
    { id: "finding-evidence", check: { kind: "all_findings_have_evidence", minimumItems: 1 } },
    { id: "reported-score", check: { kind: "reported_score_gte", minimumScore: 7.5, minimumFindings: 1, aggregation: "all" } },
    { id: "scout-source", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
  ],
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

function ordinaryFailedNode(): Record<string, unknown> {
  const ordinary = { ...state.nodes[0]! }
  delete ordinary.verificationCriterionIds
  delete ordinary.verificationReport
  return { ...ordinary, status: "failed", readiness: "terminal", failureReason: "selected_job_context_unavailable",
    resultSummary: "private provider detail person@example.test" }
}

function structuredOutputFailureNode(category: unknown): Record<string, unknown> {
  const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
    criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }
  return {
    ...ordinaryFailedNode(), failureReason: "task_graph_verification_unverified",
    verificationCriterionIds: ["candidate-count"], verification,
    verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null },
    structuredOutputFailureCategory: category,
  }
}

function projectedNode(row: Record<string, unknown>): Record<string, unknown> {
  const projected = mergeTaskGraphCurrentObservation(snapshot(), {
    revision: state.revision, nodes: [row as unknown as TaskGraphCurrentState["nodes"][number]],
  })
  return (projected.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[0]!
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
      { id: "task-graph-current", content: {
        kind: "task_graph_current", revision: 3,
        nodes: [{ ...state.nodes[0]!, resultSummary: null, failureReason: null }],
        nodeCapacity: { nodeCount: 1, maxNodes: 8, remaining: 7, ordinaryRemaining: 6, reserveActive: true, repairRecorded: false },
      } },
    ])
    const encoded = JSON.stringify(result.toolObservations.at(-1)?.content)
    expect(encoded).not.toContain("Alice Example")
    expect(encoded).not.toContain("private.example")
  })

  it("projects only a closed advisory category for an ordinary failed node", () => {
    const node = projectedNode({ ...ordinaryFailedNode(), executionFailureCategory: "structured_output_invalid" })

    expect(node).toMatchObject({
      status: "failed", readiness: "terminal", executionFailureCategory: "execution_setup_unavailable",
      failureReason: null, resultSummary: null,
    })
    expect(JSON.stringify(node)).not.toContain("selected_job_context_unavailable")
    expect(JSON.stringify(node)).not.toContain("private provider detail")
    expect(JSON.stringify(node)).not.toContain("person@example.test")
  })

  it("omits the category for unknown reasons, nonfailed tasks, verified failures, and native nodes", () => {
    const unknown = projectedNode({ ...ordinaryFailedNode(), failureReason: "provider-private-secret", executionFailureCategory: "execution_setup_unavailable" })
    const completed = projectedNode({ ...ordinaryFailedNode(), status: "completed" })
    const reported = projectedNode({ ...ordinaryFailedNode(), verificationCriterionIds: ["candidate-count"], verificationReport: state.nodes[0]!.verificationReport })
    const native = projectedNode({ ...ordinaryFailedNode(), native: {
      operationKind: "spawn", operationId: "operation-1", requestFingerprint: "f".repeat(64), callerTaskId: "root-1",
      role: "scout", taskType: "research", contextDigest: "c".repeat(64),
    } })

    for (const node of [unknown, completed, reported, native]) {
      expect(Object.hasOwn(node, "executionFailureCategory")).toBe(false)
      expect(node.failureReason).toBeNull()
      expect(node.resultSummary).toBeNull()
    }
    expect(JSON.stringify(unknown)).not.toContain("provider-private-secret")
  })

  it("projects only the four closed structured-output categories on eligible typed failures", () => {
    const categories = ["missing_final_output", "result_too_large", "result_shape_invalid", "evidence_binding_invalid"]
    for (const category of categories) {
      const node = projectedNode(structuredOutputFailureNode(category))
      expect(node).toMatchObject({ status: "failed", templateId: "scout", verificationReport: {
        status: "unverified", reasonCode: "result_invalid", evidenceDigest: null, resultDigest: null,
      }, structuredOutputFailureCategory: category, failureReason: null, resultSummary: null })
    }
  })

  it("requires the exact own enumerable data failure reason for raw structured subtype exposure", () => {
    const reason = "task_graph_verification_unverified"
    const valid = structuredOutputFailureNode("result_shape_invalid")
    expect(projectedNode(valid).structuredOutputFailureCategory).toBe("result_shape_invalid")

    let getterCalls = 0
    const inherited = Object.create({ failureReason: reason }) as Record<string, unknown>
    for (const [key, value] of Object.entries(valid)) {
      if (key !== "failureReason") Object.defineProperty(inherited, key, { value, enumerable: true, configurable: true, writable: true })
    }
    const accessor = { ...valid }
    Object.defineProperty(accessor, "failureReason", {
      enumerable: true, configurable: true, get: () => { getterCalls += 1; return reason },
    })
    const hidden = { ...valid }
    Object.defineProperty(hidden, "failureReason", { value: reason, enumerable: false, configurable: true })

    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["null", { ...valid, failureReason: null }],
      ["wrong reason", { ...valid, failureReason: "task_graph_verification_failed" }],
      ["inherited reason", inherited],
      ["accessor reason", accessor],
      ["non-enumerable reason", hidden],
    ]
    for (const [label, row] of invalidCases) {
      const projected = projectedNode(row)
      expect(projected, label).not.toHaveProperty("structuredOutputFailureCategory")

      const descriptors = Object.getOwnPropertyDescriptors(row)
      delete descriptors.structuredOutputFailureCategory
      const withoutSubtype = Object.create(Object.getPrototypeOf(row)) as Record<string, unknown>
      Object.defineProperties(withoutSubtype, descriptors)
      expect(JSON.stringify(projected), label).toBe(JSON.stringify(projectedNode(withoutSubtype)))
    }
    expect(getterCalls).toBe(0)
  })

  it("keeps validated discovery-attempt health separate from an unavailable failed result projection", () => {
    const discoveryAttemptHealth = {
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
      candidateCount: 0, providerFailures: 0, materializationFailures: 0, hasMore: false,
    }
    const projected = projectedNode({ ...structuredOutputFailureNode("result_shape_invalid"),
      resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" }, discoveryAttemptHealth })
    const malformed = projectedNode({ ...structuredOutputFailureNode("result_shape_invalid"), discoveryAttemptHealth: { ...discoveryAttemptHealth, privateProvider: "secret" } })
    const untyped = projectedNode({ ...ordinaryFailedNode(), discoveryAttemptHealth })

    expect(projected).toMatchObject({ status: "failed", discoveryAttemptHealth })
    expect(projected.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
    expect(JSON.stringify(projected)).not.toContain("attemptCount")
    expect(JSON.stringify(projected)).not.toContain("privateProvider")
    expect(malformed).not.toHaveProperty("discoveryAttemptHealth")
    expect(untyped).not.toHaveProperty("discoveryAttemptHealth")
  })

  it("omits unknown, malformed, inherited, accessor, and non-enumerable subtype values", () => {
    const eligible = structuredOutputFailureNode("result_shape_invalid")
    const absentCategory = { ...structuredOutputFailureNode(undefined) }
    delete absentCategory.structuredOutputFailureCategory
    const undefinedCategory = structuredOutputFailureNode(undefined)
    const unknownCategory = structuredOutputFailureNode("future_category")
    expect(JSON.stringify(projectedNode(undefinedCategory))).toBe(JSON.stringify(projectedNode(absentCategory)))
    expect(JSON.stringify(projectedNode(unknownCategory))).toBe(JSON.stringify(projectedNode(absentCategory)))
    const wrongReport = { ...eligible, verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }],
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
    } }
    const unknown = projectedNode({ ...eligible, structuredOutputFailureCategory: { code: "result_shape_invalid" } })
    const completed = projectedNode({ ...eligible, status: "completed" })
    const verified = projectedNode(wrongReport)
    const unsupportedRole = projectedNode({ ...ordinaryFailedNode(), templateId: "writer", structuredOutputFailureCategory: "result_shape_invalid" })
    const inherited = structuredOutputFailureNode(undefined)
    delete inherited.structuredOutputFailureCategory
    Object.setPrototypeOf(inherited, { structuredOutputFailureCategory: "result_shape_invalid" })
    const accessor = structuredOutputFailureNode(undefined)
    let reads = 0
    Object.defineProperty(accessor, "structuredOutputFailureCategory", {
      enumerable: true, get: () => { reads += 1; throw new Error("category getter must not run") },
    })
    const nonEnumerable = structuredOutputFailureNode(undefined)
    Object.defineProperty(nonEnumerable, "structuredOutputFailureCategory", { enumerable: false, value: "result_shape_invalid" })

    for (const node of [unknown, completed, verified, unsupportedRole, projectedNode(inherited), projectedNode(accessor), projectedNode(nonEnumerable)]) {
      expect(Object.hasOwn(node, "structuredOutputFailureCategory")).toBe(false)
    }
    expect(reads).toBe(0)
  })

  it("rejects malformed repair and native markers before a subtype can enter current context", () => {
    for (const key of ["repairOf", "repairReceipt"]) {
      for (const value of [undefined, null, {}]) {
        expect(() => projectedNode({ ...structuredOutputFailureNode("result_shape_invalid"), [key]: value }))
          .toThrow("task_graph_current_state_invalid:verification")
      }
    }
    for (const key of ["native", "nativeResult"]) {
      for (const value of [undefined, null, {}]) {
        expect(() => projectedNode({ ...structuredOutputFailureNode("result_shape_invalid"), [key]: value }))
          .toThrow("task_graph_current_state_invalid:native")
      }
    }
    const native = projectedNode({ ...structuredOutputFailureNode("result_shape_invalid"), native: {
      operationKind: "spawn", operationId: "operation-1", requestFingerprint: "f".repeat(64), callerTaskId: "root-1",
      role: "scout", taskType: "research", contextDigest: "c".repeat(64),
    } })
    expect(Object.hasOwn(native, "structuredOutputFailureCategory")).toBe(false)

    const repairVerification: TaskGraphVerificationContract = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
    }
    const repairReport: TaskGraphVerificationReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" }],
      evidenceDigest: null, resultDigest: null,
    }
    const target: TaskGraphCurrentNode = {
      key: "original", templateId: "scout", goal: "Find roles", successCriteria: ["Return evidence"], dependsOn: [],
      taskId: "target-1", status: "failed", readiness: "terminal", resultSummary: null,
      failureReason: "task_graph_verification_unverified", verificationCriterionIds: ["candidate-count"],
      verification: repairVerification, verificationReport: repairReport,
    }
    const repair: TaskGraphCurrentNode = {
      ...target, key: "repair", taskId: "repair-1", structuredOutputFailureCategory: "result_shape_invalid",
      repairOf: { graphRootTaskId: "root-1", nodeKey: "original", taskId: "target-1", criterionIds: ["candidate-count"] },
    }
    const repaired = mergeTaskGraphCurrentObservation(snapshot(), { revision: 3, nodes: [target, repair] })
    const repairNode = (repaired.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[1]!
    expect(Object.hasOwn(repairNode, "structuredOutputFailureCategory")).toBe(false)
  })

  it("counts the optional structured subtype inside the existing 32 KiB verifier budget", () => {
    const makeNodes = (width: number, includeCategory: boolean): TaskGraphCurrentState["nodes"] => Array.from({ length: 16 }, (_, index) => {
      const criteria = Array.from({ length: 8 }, (_, criterionIndex) => ({
        id: `c${criterionIndex}-${"x".repeat(width)}`,
        check: { kind: "candidate_count_gte" as const, minimum: 1 },
      }))
      const ids = criteria.map(criterion => criterion.id)
      return {
        key: `typed-${index}`, taskId: `task-${index}`, templateId: "scout", goal: "Find roles", successCriteria: ["Return evidence"],
        dependsOn: [], status: "failed", readiness: "terminal", resultSummary: null,
        failureReason: includeCategory ? "task_graph_verification_unverified" : null,
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria } as TaskGraphVerificationContract,
        verificationCriterionIds: ids,
        verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
          criteria: ids.map(criterionId => ({ criterionId, status: "unverified" as const, reasonCode: "result_invalid" as const })), evidenceDigest: null, resultDigest: null },
        ...(includeCategory ? { structuredOutputFailureCategory: "result_shape_invalid" as const } : {}),
      }
    })
    let categoryBytesCauseRejection = false
    for (let width = 1; width <= 60 && !categoryBytesCauseRejection; width += 1) {
      const withoutCategory = makeNodes(width, false)
      const baseBytes = withoutCategory.reduce((total, item) => total + taskGraphCurrentVerificationMetadataBytes(item), 0)
      if (baseBytes > 32 * 1024) continue
      expect(() => mergeTaskGraphCurrentObservation(snapshot(), { revision: 3, nodes: withoutCategory })).not.toThrow()
      const withCategory = makeNodes(width, true)
      try {
        mergeTaskGraphCurrentObservation(snapshot(), { revision: 3, nodes: withCategory })
      } catch (error) {
        if (error instanceof Error && error.message === "task_graph_current_verification_too_large") categoryBytesCauseRejection = true
        else throw error
      }
    }
    expect(categoryBytesCauseRejection).toBe(true)
  })

  it("ignores inherited and accessor failure reasons without invoking getters", () => {
    const withoutReason = ordinaryFailedNode()
    delete withoutReason.failureReason
    const inherited = Object.assign(Object.create({ failureReason: "selected_job_context_unavailable" }), withoutReason) as Record<string, unknown>
    const accessor = ordinaryFailedNode()
    Object.defineProperty(accessor, "failureReason", {
      enumerable: true, get: () => { throw new Error("failure getter must not run") },
    })

    expect(Object.hasOwn(projectedNode(inherited), "executionFailureCategory")).toBe(false)
    expect(Object.hasOwn(projectedNode(accessor), "executionFailureCategory")).toBe(false)
  })

  it("rejects malformed verification before reading native fields", () => {
    let nativeReads = 0
    const malformed = { ...ordinaryFailedNode(), verificationCriterionIds: ["candidate-count"], verificationReport: {} }
    Object.defineProperty(malformed, "native", {
      enumerable: true, get: () => { nativeReads += 1; return {} },
    })

    expect(() => projectedNode(malformed)).toThrow("task_graph_current_state_invalid:verification")
    expect(nativeReads).toBe(0)
  })

  it("replaces stale revision metadata from the typed read, including graph revision zero", () => {
    const result = mergeTaskGraphCurrentObservation({ ...snapshot(), taskGraphRevision: 8 }, { revision: 0, nodes: [] })

    expect(result.taskGraphRevision).toBe(0)
    expect(result.toolObservations.at(-1)?.content).toEqual({
      kind: "task_graph_current", revision: 0, nodes: [],
      nodeCapacity: { nodeCount: 0, maxNodes: 8, remaining: 8, ordinaryRemaining: 8, reserveActive: false, repairRecorded: false },
    })
  })

  it("projects only server-derived numeric capacity and ignores a caller-supplied field", () => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state,
      nodeCapacity: { nodeCount: 8, maxNodes: 8, remaining: 0, ordinaryRemaining: 0, reserveActive: false, repairRecorded: true },
    } as unknown as TaskGraphCurrentState)
    const observation = result.toolObservations.at(-1)?.content as Record<string, unknown>
    const capacity = observation.nodeCapacity as Record<string, unknown>

    expect(capacity).toEqual({ nodeCount: 1, maxNodes: 8, remaining: 7, ordinaryRemaining: 6, reserveActive: true, repairRecorded: false })
    expect(Object.keys(capacity).sort()).toEqual([
      "maxNodes", "nodeCount", "ordinaryRemaining", "remaining", "repairRecorded", "reserveActive",
    ])
    expect(JSON.stringify(capacity)).not.toContain("child-1")
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

  it("restores pinned root criteria after snapshot serialization as untrusted model context", async () => {
    const criteria = ["Find roles across the full requested EU market", "Include evidence for each shortlisted role"]
    const merged = mergeTaskGraphCurrentObservation(snapshot(), { ...state, rootSuccessCriteria: criteria })
    const reloaded = JSON.parse(JSON.stringify(merged)) as StepContextSnapshot
    const observation = reloaded.toolObservations.find(item => item.id === "task-graph-current")?.content as Record<string, unknown>
    const context = await new StepContextBuilder(emptyInputStore()).build({
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
      snapshot: selectedJobSnapshot(reloaded), now: new Date(0),
    })
    const block = context.blocks.find(item => item.id === "observation:task-graph-current")
    const request = await selectedJobModelRequest(reloaded)
    const modelText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(observation).toMatchObject({ kind: "task_graph_current", rootSuccessCriteria: criteria })
    expect(block?.trust).toBe("external_untrusted")
    expect(block?.content).toMatchObject({ rootSuccessCriteria: criteria })
    expect(reloaded.system).toEqual([])
    expect(modelText).toContain("Find roles across the full requested EU market")
    expect(modelText).toContain("Include evidence for each shortlisted role")
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, rootSuccessCriteria: ["x".repeat(2_001)] })).toThrow(
      "task_graph_current_state_invalid:rootSuccessCriteria",
    )
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, rootSuccessCriteria: [criteria[0]!, criteria[0]!] })).toThrow(
      "task_graph_current_state_invalid:rootSuccessCriteria",
    )
    let getterReads = 0
    const accessorState = { ...state }
    Object.defineProperty(accessorState, "rootSuccessCriteria", {
      enumerable: true, get: () => { getterReads += 1; return criteria },
    })
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), accessorState as unknown as TaskGraphCurrentState)).toThrow(
      "task_graph_current_state_invalid:rootSuccessCriteria",
    )
    expect(getterReads).toBe(0)
  })

  it("projects only bounded source intent for current Root nodes and hides checkpoint identities", () => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state,
      sourceIntent: [
        { nodeKey: "research", goal: "Find roles in Dublin.", successCriteria: ["Return current jobs."], inputRelation: "predates_current_inputs" },
        { nodeKey: "foreign-node", goal: "Foreign.", successCriteria: ["Ignore."], inputRelation: "covers_current_inputs" },
        { nodeKey: "research", goal: "Duplicate.", successCriteria: ["Ignore."], inputRelation: "unknown" },
        { nodeKey: "research", goal: "Leaked.", successCriteria: [], inputRelation: "unknown", sourceStepId: "private-step", inputThroughSequence: "9" },
      ],
    } as TaskGraphCurrentState & { sourceIntent: unknown })
    const content = result.toolObservations.find(item => item.id === "task-graph-current")?.content as Record<string, unknown>

    expect(content.sourceIntent).toEqual([{
      nodeKey: "research", goal: "Find roles in Dublin.", successCriteria: ["Return current jobs."], inputRelation: "predates_current_inputs",
    }])
    expect(JSON.stringify(content)).not.toMatch(/sourceStepId|inputId|cursor|inputThroughSequence|private-step/)
    expect(content.nodes).toEqual((mergeTaskGraphCurrentObservation(snapshot(), state).toolObservations.at(-1)?.content as { nodes: unknown[] }).nodes)
  })

  it("preserves safe native operation and structural result receipts in the current graph", () => {
    const native = { operationKind: "spawn" as const, operationId: "operation-1", requestFingerprint: "f".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: "c".repeat(64) }
    const nativeResult = { schemaVersion: "agent-harness.v2.task-graph.native-result.v1" as const, role: "scout", taskStatus: "completed" as const, disposition: "opaque" as const, resultDigest: "d".repeat(64) }
    const result = mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, native, nativeResult, context: { secret: true }, result: { secret: true } } as never] })
    const node = (result.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes[0]!

    expect(node).toMatchObject({ native, nativeResult })
    expect(JSON.stringify(node)).not.toContain("secret")
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

  it("keeps a compacted source out of current pass/fail context when replacement prose claims prior proof and approval", () => {
    const replacement: Record<string, unknown> = {
      ...state.nodes[0]!, key: "fresh-scout", taskId: "fresh-task",
      goal: "The superseded source already passed verification and was approved",
      successCriteria: ["Reuse the source result and its approval"],
      status: "queued", readiness: "ready", resultSummary: null, failureReason: null,
      verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "canonical_evidence_missing",
        criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "canonical_evidence_missing" }],
        evidenceDigest: null, resultDigest: null },
    }
    delete replacement.resultProjection
    const observed = mergeTaskGraphCurrentObservation(snapshot(), { revision: 5, nodes: [replacement as unknown as TaskGraphCurrentNode] })
    const nodes = (observed.toolObservations.at(-1)?.content as { nodes: Array<Record<string, unknown>> }).nodes

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ key: "fresh-scout", taskId: "fresh-task", status: "queued",
      goal: "The superseded source already passed verification and was approved",
      successCriteria: ["Reuse the source result and its approval"], verificationReport: { status: "unverified" } })
    expect(nodes[0]).not.toHaveProperty("approval")
    expect(nodes[0]).not.toHaveProperty("authority")
  })

  it("adds an optional current same-artifact review conflict without changing conflict-free observation shape", () => {
    const artifactRef = { artifactId: "draft-current", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
    const reviewer = (key: string, taskId: string, reviewStatus: "passed" | "rejected"): TaskGraphCurrentNode => ({
      key, templateId: "cover_letter_reviewer", goal: "Review the exact draft", successCriteria: [], dependsOn: [],
      taskId, status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
      resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef, reviewStatus, reviewHash: `sha256:${"c".repeat(64)}` },
    })
    const conflictContent = mergeTaskGraphCurrentObservation(snapshot(), { revision: 6, nodes: [
      reviewer("review-passed", "reviewer-passed", "passed"), reviewer("review-rejected", "reviewer-rejected", "rejected"),
    ] }).toolObservations.at(-1)?.content as Record<string, unknown>
    const unchangedContent = mergeTaskGraphCurrentObservation(snapshot(), state).toolObservations.at(-1)?.content as Record<string, unknown>

    expect(conflictContent.reviewConflicts).toEqual([{
      artifactId: "draft-current", version: 3,
      outcomes: [
        { taskId: "reviewer-passed", reviewStatus: "passed" },
        { taskId: "reviewer-rejected", reviewStatus: "rejected" },
      ], truncated: false,
    }])
    expect(conflictContent.kind).toBe("task_graph_current")
    expect(Object.hasOwn(unchangedContent, "reviewConflicts")).toBe(false)
  })

  it("sends the validated full current check contract as untrusted model data", async () => {
    const failedReport = (contract: TaskGraphVerificationContract, digest: string) => ({
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed" as const, reasonCode: "criterion_not_met" as const,
      criteria: contract.criteria.map(item => ({ criterionId: item.id, status: "failed" as const, reasonCode: "criterion_not_met" as const })),
      evidenceDigest: digest.repeat(64), resultDigest: "e".repeat(64),
    })
    const current = mergeTaskGraphCurrentObservation(snapshot(), {
      revision: 4,
      nodes: [
        { ...state.nodes[0]!, key: "scout", taskId: "task-scout", verification: currentScoutVerification,
          verificationCriterionIds: currentScoutVerification.criteria.map(item => item.id),
          verificationReport: failedReport(currentScoutVerification, "a") },
        { ...state.nodes[0]!, key: "analyst", taskId: "task-analyst", templateId: "analyst", dependsOn: ["scout"],
          verification: currentAnalystVerification, verificationCriterionIds: currentAnalystVerification.criteria.map(item => item.id),
          verificationReport: failedReport(currentAnalystVerification, "b") },
      ],
    })
    const context = await new StepContextBuilder(emptyInputStore()).build({
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
      snapshot: selectedJobSnapshot(current), now: new Date(0),
    })
    const block = context.blocks.find(item => item.id === "observation:task-graph-current")
    expect(block?.trust).toBe("external_untrusted")
    expect(block?.content).toMatchObject({ kind: "task_graph_current", revision: 4, nodes: [
      { key: "scout", verification: currentScoutVerification, verificationCriterionIds: currentScoutVerification.criteria.map(item => item.id) },
      { key: "analyst", dependsOn: ["scout"], verification: currentAnalystVerification, verificationCriterionIds: currentAnalystVerification.criteria.map(item => item.id) },
    ] })
    const model = { profile: { provider: "test", model: "test-model", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({ context, model, tools: [], sessionId: "session-1", turnId: "turn-1", stepId: "step-1", userId: "user-1", taskId: "root-1", signal: new AbortController().signal })
    const text = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    expect(text).toContain('"kind":"candidate_count_gte"')
    expect(text).toContain('"minimum":2')
    expect(text).toContain('"kind":"all_candidates_have_evidence"')
    expect(text).toContain('"kind":"finding_count_gte"')
    expect(text).toContain('"kind":"all_findings_have_evidence"')
    expect(text).toContain('"kind":"reported_score_gte"')
    expect(text).toContain('"aggregation":"all"')
    expect(text).toContain('"kind":"findings_from_scout_dependency"')
    expect(text).toContain('"dependencyNodeKey":"scout"')
  })

  it("charges full typed contracts to the existing aggregate verifier byte limit", () => {
    const criteria = Array.from({ length: 8 }, (_, index) => ({
      id: `criterion-${index}-${"x".repeat(52)}`,
      check: { kind: "candidate_count_gte" as const, minimum: 50 },
    }))
    const verification: TaskGraphVerificationContract = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria }
    const ids = criteria.map(item => item.id)
    const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified" as const,
      reasonCode: "canonical_evidence_ambiguous" as const,
      criteria: ids.map(criterionId => ({ criterionId, status: "unverified" as const, reasonCode: "canonical_evidence_ambiguous" as const })),
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) }
    const nodes = Array.from({ length: 16 }, (_, index) => ({
      key: `typed-${index}`, taskId: `task-${index}`, templateId: "scout", goal: "Find roles", successCriteria: ["Return evidence"],
      dependsOn: [], status: "failed" as const, readiness: "terminal" as const, resultSummary: null, failureReason: null,
      verification: { ...verification, criteria: criteria.map(item => ({ ...item, id: `${item.id.slice(0, 60)}${String(index).padStart(2, "0")}` })) },
      verificationCriterionIds: ids.map(id => `${id.slice(0, 60)}${String(index).padStart(2, "0")}`),
      verificationReport: { ...report, criteria: report.criteria.map(item => ({ ...item, criterionId: `${item.criterionId.slice(0, 60)}${String(index).padStart(2, "0")}` })) },
    })) as TaskGraphCurrentState["nodes"]

    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { revision: 3, nodes }))
      .toThrow("task_graph_current_verification_too_large")
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
    const port: TaskGraphCommandPort = {
      readCurrent: async () => persistedState,
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
      prepareJobs: { knownCount: null, coverage: "not_requested" },
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

  it("rejects an oversized base observation even when fresh planning facts are supplied", () => {
    const keys = Array.from({ length: 16 }, (_, index) => "k".repeat(120) + String(index).padStart(8, "0"))
    const nodes = keys.map((key, index) => ({
      key,
      templateId: "m".repeat(128),
      goal: "\"".repeat(1_200),
      successCriteria: Array.from({ length: 8 }, () => "\"".repeat(320)),
      dependsOn: keys.slice(Math.max(0, index - 8), index),
      taskId: "t".repeat(120) + String(index).padStart(8, "0"),
      status: "completed" as const,
      readiness: "terminal" as const,
      native: {
        operationKind: "spawn" as const,
        operationId: "o".repeat(256),
        requestFingerprint: "a".repeat(64),
        callerTaskId: "p".repeat(128),
        role: "r".repeat(64),
        taskType: "y".repeat(128),
        contextDigest: "b".repeat(64),
        source: {
          taskId: "s".repeat(128),
          rootTaskId: "r".repeat(128),
          parentTaskId: "p".repeat(128),
          turnId: "u".repeat(128),
          role: "x".repeat(64),
          taskType: "z".repeat(128),
          status: "completed" as const,
          attemptCount: 1,
          resultDigest: "c".repeat(64),
          graphNodeKey: "g".repeat(128),
          origin: "task_graph" as const,
        },
      },
    }))
    const baseState = { revision: 3, nodes } as unknown as TaskGraphCurrentState
    const planningFacts = {
      graphRevision: 3,
      counts: {
        discoveredJobs: { knownCount: 12, coverage: "partial" },
        analyzedJobs: { knownCount: 7, coverage: "complete" },
        artifactReferences: { knownCount: null, coverage: "not_requested" },
        reviewOutcomes: { knownCount: null, coverage: "unavailable" },
      },
    }

    expect(() => mergeTaskGraphCurrentObservation(snapshot(), baseState))
      .toThrow("task_graph_current_state_too_large")
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), {
      ...baseState, planningFacts,
    } as unknown as TaskGraphCurrentState)).toThrow("task_graph_current_state_too_large")
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
      prepareJobs: { knownCount: null, coverage: "not_requested" },
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
})
