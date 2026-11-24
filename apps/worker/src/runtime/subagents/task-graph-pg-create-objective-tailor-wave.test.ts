import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphState } from "../planning/task-graph.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { bindObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection, objectiveTailorWavePairPlan } from "./objective-tailor-wave-witness.js"
import { isRegisteredObjectiveTailorWaveChild, objectiveTailorWaveChildExecutionAllowed, prepareObjectiveTailorWaveCreatePlan } from "./task-graph-pg-create-objective-tailor-wave.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const source: TaskGraphState["nodes"] = [
  { key: "scout-a", templateId: "scout", goal: "Find roles", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
    status: "completed" as const, taskId: "scout-task", verificationDisposition: "typed" as const,
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
  { key: "analyst-a", templateId: "analyst", goal: "Analyze roles", successCriteria: ["Return findings"], dependsOn: ["scout-a"], depth: 2,
    status: "completed" as const, taskId: "analyst-task", verificationDisposition: "typed" as const,
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const, criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
]
const initial: TaskGraphState = { revision: 1, nodes: source, appliedEvents: [] }

function witness(index: number, slotId: string, revision = 2) {
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "a".repeat(64),
    sourceStatusDigest: "b".repeat(64), analystProofDigest: `${index}`.repeat(64),
    candidate: { jobId: `c${String(index).padStart(24, "0")}`, score: 8, materialDigest: `sha256:${String(index).repeat(64)}` }, sourceAnalystKey: "analyst-a" })!
  return bindObjectiveTailorWaveCandidateWitness(selection, { slotId, admittedRevision: revision })!
}

function marker(witnesses: readonly ReturnType<typeof witness>[]) {
  return { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: source.length,
    slots: witnesses.map(value => ({ slotId: value.slotId, sourceAnalystNodeKey: value.sourceAnalystKeys[0],
      writerNodeKey: value.writerNodeKey, reviewerNodeKey: value.reviewerNodeKey })) }
}

describe("Objective Tailor per-node PG create adapter", () => {
  it("composes four exact per-Job pairs while persisting only the closed public marker", () => {
    const witnesses = Array.from({ length: 4 }, (_, index) => witness(index + 1, `tailor-${index + 1}`))
    const result = prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses, nextMarker: marker(witnesses) })

    expect(result?.proposal.expectedRevision).toBe(1)
    for (const value of witnesses) {
      expect(result?.proposal.nodes).toContainEqual(expect.objectContaining({ key: value.writerNodeKey,
        templateId: "cover_letter_writer", dependsOn: ["analyst-a"] }))
      expect(result?.proposal.nodes).toContainEqual(expect.objectContaining({ key: value.reviewerNodeKey,
        templateId: "cover_letter_reviewer", dependsOn: [value.writerNodeKey] }))
    }
    expect(result?.proposal.nodes).toHaveLength(8)
    expect(result?.templatesByNodeKey.size).toBe(8)
    expect(result?.marker.slots.map(slot => slot.slotId)).toEqual(witnesses.map(value => value.slotId))
    expect(JSON.stringify(result?.marker)).not.toContain(witnesses[0]!.candidateRef)
    expect(result?.templatesByNodeKey.get(witnesses[0]!.writerNodeKey)?.context).toMatchObject({
      selectedJobPreparation: { jobId: witnesses[0]!.candidate.jobId }, objectiveTailorCandidateWitness: witnesses[0],
    })
    expect(result?.templatesByNodeKey.get(witnesses[1]!.writerNodeKey)?.context).toMatchObject({
      selectedJobPreparation: { jobId: witnesses[1]!.candidate.jobId }, objectiveTailorCandidateWitness: witnesses[1],
    })
  })

  it("preserves an existing marked wave and only appends new slots at the next revision", () => {
    const first = [witness(1, "tailor-1"), witness(2, "tailor-2")]
    const firstPlan = prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses: first, nextMarker: marker(first) })!
    const current: TaskGraphState = { revision: 2, appliedEvents: [], objectiveTailor: firstPlan.marker,
      nodes: [...source, ...firstPlan.proposal.nodes.map((node, index) => ({ ...node, depth: index % 2 ? 4 : 3, status: "queued" as const }))] }
    const next = [witness(3, "tailor-3", 3), witness(4, "tailor-4", 3)]
    const result = prepareObjectiveTailorWaveCreatePlan({ current, witnesses: next, nextMarker: {
      ...marker([...first, ...next]), sourceNodeCount: source.length,
    } })

    expect(result?.proposal.expectedRevision).toBe(2)
    expect(result?.proposal.nodes).toHaveLength(4)
    expect(result?.marker.slots.map(slot => slot.slotId)).toEqual(["tailor-1", "tailor-2", "tailor-3", "tailor-4"])
    expect(result?.marker.slots.slice(0, 2)).toEqual(firstPlan.marker.slots)
  })

  it("rejects duplicate, stale, mismatched, and over-cap adapter input", () => {
    const first = witness(1, "tailor-1"), second = witness(2, "tailor-2")
    expect(prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses: [first, first], nextMarker: marker([first, first]) })).toBeUndefined()
    expect(prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses: [first], nextMarker: marker([second]) })).toBeUndefined()
    expect(prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses: [first], nextMarker: { ...marker([first]), sourceNodeCount: 1 } })).toBeUndefined()
    expect(prepareObjectiveTailorWaveCreatePlan({ current: initial, witnesses: Array.from({ length: 5 }, (_, index) => witness(index + 1, `tailor-${index + 1}`)), nextMarker: marker([first]) })).toBeUndefined()
  })

  it("requires canonical V2 child proof, exact Analyst evidence, profile, mode, and tailor permission", () => {
    const value = witness(1, "tailor-1"), plan = objectiveTailorWavePairPlan(value)!
    const writer = plan.templatesByNodeKey.get(value.writerNodeKey)!
    const context = { ...(writer.context as Record<string, unknown>), taskGraphDependencyResults: {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence",
      items: [{ dependencyKey: "analyst-a", role: "analyst", taskStatus: "completed" }],
    } }
    const child = { role: writer.role, taskType: writer.taskType, allowedActions: writer.allowedActions,
      constraints: writer.constraints ?? [], context, expectedOutputSchema: writer.expectedOutputSchema ?? {} }
    expect(isRegisteredObjectiveTailorWaveChild(child, value.writerNodeKey)).toBe(true)
    expect(isRegisteredObjectiveTailorWaveChild(child, value.reviewerNodeKey)).toBe(false)
    expect(isRegisteredObjectiveTailorWaveChild({ ...child, context: { ...context, selectedJobPreparation: { jobId: "other" } } }, value.writerNodeKey)).toBe(false)
    expect(isRegisteredObjectiveTailorWaveChild({ ...child, context: { ...context, taskGraphDependencyResults: {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ dependencyKey: "other", role: "analyst", taskStatus: "completed" }],
    } } }, value.writerNodeKey)).toBe(false)

    const validLive = { input: { goal: "Objective", intent: { kind: "objective_task_graph_execution", version: 1 } },
      executionMode: "canonical_task_graph", rootBudgetSnapshot: { limits: { maxSteps: 96 },
        objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v1" }, rootAllowedActions: ["agent.tailor"] }
    expect(objectiveTailorWaveChildExecutionAllowed(validLive)).toBe(true)
    expect(objectiveTailorWaveChildExecutionAllowed({ ...validLive, executionMode: null })).toBe(false)
    expect(objectiveTailorWaveChildExecutionAllowed({ ...validLive, rootBudgetSnapshot: { limits: { maxSteps: 32 },
      objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v1" } })).toBe(false)
    expect(objectiveTailorWaveChildExecutionAllowed({ ...validLive, rootAllowedActions: [] })).toBe(false)
    expect(objectiveTailorWaveChildExecutionAllowed({ ...validLive, input: { ...validLive.input, verifiedShortlistSelection: {} } })).toBe(false)
  })

  it("admits a correction pair only with its exact prior Reviewer and needs-revision evidence", () => {
    const candidate = witness(1, "tailor-1"), sha = (value: string) => `sha256:${value.repeat(64)}`
    const ref = { artifactId: "cover-letter-1", version: 3, contentHash: sha("a"), sourceDigest: sha("b") }
    const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 4, slotId: candidate.slotId, candidateWitness: candidate,
      writerTaskId: "initial-writer", reviewerTaskId: "initial-reviewer", artifactRef: ref,
      artifactVersion: { ...ref, artifactType: "cover_letter", taskId: "initial-writer", previousHash: sha("c") },
      reviewReceipt: { jobId: candidate.candidate.jobId, ...ref, currentSourceDigest: ref.sourceDigest,
        status: "needs_revision", taskId: "initial-reviewer", toolCallId: "review-call", reviewHash: sha("d") } })!
    const context = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId: candidate.candidate.jobId },
      objectiveTailorCandidateWitness: candidate, objectiveTailorCorrectionProof: proof }
    const dependency = { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{
      dependencyKey: candidate.reviewerNodeKey, dependencyTaskId: proof.prior.reviewerTaskId, role: "reviewer", taskStatus: "completed",
      result: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef: ref, reviewStatus: "needs_revision", reviewHash: proof.prior.reviewReceipt.reviewHash },
    }] }
    const writerTemplate = planFor(candidate).templatesByNodeKey.get(candidate.writerNodeKey)!
    const writer = { role: writerTemplate.role, taskType: writerTemplate.taskType, allowedActions: writerTemplate.allowedActions,
      constraints: writerTemplate.constraints ?? [], context: { ...context, taskGraphDependencyResults: dependency },
      expectedOutputSchema: writerTemplate.expectedOutputSchema ?? {} }
    expect(isRegisteredObjectiveTailorWaveChild(writer, proof.writerNodeKey)).toBe(true)
    expect(isRegisteredObjectiveTailorWaveChild({ ...writer, context: { ...writer.context, taskGraphDependencyResults: {
      ...dependency, items: [{ ...dependency.items[0], dependencyKey: "other-reviewer" }],
    } } }, proof.writerNodeKey)).toBe(false)
    expect(isRegisteredObjectiveTailorWaveChild({ ...writer, context: { ...writer.context, taskGraphDependencyResults: {
      ...dependency, items: [{ ...dependency.items[0], result: { ...dependency.items[0].result, reviewStatus: "passed" } }],
    } } }, proof.writerNodeKey)).toBe(false)
  })
})

function planFor(value: ReturnType<typeof witness>) {
  return objectiveTailorWavePairPlan(value)!
}
