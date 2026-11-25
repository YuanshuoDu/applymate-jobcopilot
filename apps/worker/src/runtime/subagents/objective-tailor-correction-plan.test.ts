import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphState } from "./task-graph-snapshot.js"
import { bindObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection, objectiveTailorWavePairPlan } from "./objective-tailor-wave-witness.js"
import { prepareObjectiveTailorCorrectionPlan } from "./objective-tailor-correction-plan.js"
import type { ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const sha = (char: string) => `sha256:${char.repeat(64)}`
const verification = (role: "scout" | "analyst", dependencyNodeKey?: string) => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
  criteria: [{ id: "proof", check: role === "scout" ? { kind: "candidate_count_gte" as const, minimum: 1 }
    : { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: dependencyNodeKey! } }],
})

function fixture(options: { sourceDepth?: number; slots?: number; occupiedCorrection?: boolean } = {}) {
  const sourceDepth = options.sourceDepth ?? 2, slots = options.slots ?? 8
  const sourceNodes = Array.from({ length: sourceDepth }, (_, index) => {
    const scout = index < sourceDepth - 1, key = scout ? `scout-${index + 1}` : "analyst-1"
    const dependency = index ? [index === sourceDepth - 1 ? `scout-${index}` : `scout-${index}`] : []
    return { key, taskId: `${key}-task`, templateId: scout ? "scout" : "analyst",
      goal: scout ? "Find candidate jobs" : "Verify candidate evidence", successCriteria: [scout ? "Find jobs" : "Verify jobs"],
      dependsOn: dependency, depth: index + 1, verificationDisposition: "typed",
      verification: scout ? verification("scout") : verification("analyst", dependency[0]) }
  })
  const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: sourceNodes })
  const sourceGraphDigest = taskGraphFingerprint(sourceSnapshot)
  const sourceStatusDigest = taskGraphFingerprint(sourceNodes.map(node => ({ key: node.key, status: "completed" })))
  const sourceAnalystKey = sourceNodes.at(-1)!.key
  const witnesses = Array.from({ length: slots }, (_, index) => {
    const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest,
      sourceStatusDigest, analystProofDigest: "c".repeat(64),
      candidate: { jobId: `f47ac10b-58cc-4372-a567-0e02b2c3d47${index + 1}`, score: 9 - index / 10, materialDigest: sha("d") },
      sourceAnalystKey })!
    const slotId = `tailor-${index + 1}` as ObjectiveTailorGraph["slots"][number]["slotId"]
    return bindObjectiveTailorWaveCandidateWitness(selection, { slotId, admittedRevision: index + 2 })!
  })
  const nodes: Record<string, unknown>[] = [...sourceNodes]
  const statuses = new Map<string, { status: "completed"; failureReason: null }>()
  for (const node of sourceNodes) statuses.set(node.taskId, { status: "completed", failureReason: null })
  const marker: ObjectiveTailorGraph = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
    sourceNodeCount: sourceNodes.length, slots: witnesses.map(witness => ({ slotId: witness.slotId as ObjectiveTailorGraph["slots"][number]["slotId"],
      sourceAnalystNodeKey: sourceAnalystKey, writerNodeKey: witness.writerNodeKey, reviewerNodeKey: witness.reviewerNodeKey })) }
  for (const witness of witnesses) {
    const pair = objectiveTailorWavePairPlan(witness)!
    const writerDepth = sourceNodes.length + 1, reviewerDepth = writerDepth + 1
    nodes.push({ ...pair.proposal.nodes[0], taskId: `${witness.slotId}-writer-task`, depth: writerDepth, verificationDisposition: "specialized" })
    nodes.push({ ...pair.proposal.nodes[1], taskId: `${witness.slotId}-reviewer-task`, depth: reviewerDepth, verificationDisposition: "specialized" })
    statuses.set(`${witness.slotId}-writer-task`, { status: "completed", failureReason: null })
    statuses.set(`${witness.slotId}-reviewer-task`, { status: "completed", failureReason: null })
  }
  let currentMarker: ObjectiveTailorGraph = marker
  if (options.occupiedCorrection) {
    const slot = marker.slots[0]!, writerKey = "objective-tailor-wave-correction-writer-tailor-1"
    const reviewerKey = "objective-tailor-wave-correction-reviewer-tailor-1"
    currentMarker = { ...marker, slots: marker.slots.map(value => value.slotId === slot.slotId
      ? { ...value, correction: { writerNodeKey: writerKey, reviewerNodeKey: reviewerKey } } : value) }
    nodes.push({ key: writerKey, taskId: "old-correction-writer", templateId: "cover_letter_writer", goal: "Revise letter",
      successCriteria: ["Save correction"], dependsOn: [slot.reviewerNodeKey], depth: sourceNodes.length + 3, verificationDisposition: "specialized" })
    nodes.push({ key: reviewerKey, taskId: "old-correction-reviewer", templateId: "cover_letter_reviewer", goal: "Review letter",
      successCriteria: ["Review correction"], dependsOn: [writerKey], depth: sourceNodes.length + 4, verificationDisposition: "specialized" })
    statuses.set("old-correction-writer", { status: "completed", failureReason: null })
    statuses.set("old-correction-reviewer", { status: "completed", failureReason: null })
  }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes, objectiveTailor: currentMarker })
  const current = taskGraphState(snapshot, 20, statuses, [])
  const target = witnesses[options.occupiedCorrection ? 0 : slots - 1]!
  const writerTaskId = `${target.slotId}-writer-task`, reviewerTaskId = `${target.slotId}-reviewer-task`
  const artifactRef = { artifactId: `cover-letter-${target.slotId}`, version: 3, contentHash: sha("e"), sourceDigest: sha("f") }
  const artifactVersion = { ...artifactRef, artifactType: "cover_letter" as const, taskId: writerTaskId, previousHash: sha("a") }
  const reviewReceipt = { jobId: target.candidate.jobId, ...artifactRef, currentSourceDigest: artifactRef.sourceDigest,
    status: "needs_revision" as const, taskId: reviewerTaskId, toolCallId: "review-call", reviewHash: sha("b") }
  const makeProof = (ids = { writerTaskId, reviewerTaskId }) => bindObjectiveTailorCorrectionProof({ graphRevision: current.revision,
    slotId: target.slotId, candidateWitness: target, ...ids,
    artifactRef, artifactVersion: { ...artifactVersion, taskId: ids.writerTaskId },
    reviewReceipt: { ...reviewReceipt, taskId: ids.reviewerTaskId } })
  return { current, marker: currentMarker, target, makeProof, witnesses, sourceNodes }
}

describe("Objective Tailor correction plan", () => {
  it("appends a completed slot's exact same-Job successor at the end of an eight-slot graph", () => {
    const { current, target, makeProof, marker } = fixture(), proof = makeProof()!
    const plan = prepareObjectiveTailorCorrectionPlan({ current, proof })
    expect(plan).toBeDefined()
    expect(plan?.proposal.expectedRevision).toBe(current.revision)
    expect(plan?.proposal.nodes.map(node => [node.templateId, node.dependsOn])).toEqual([
      ["cover_letter_writer", [target.reviewerNodeKey]],
      ["cover_letter_reviewer", ["objective-tailor-wave-correction-writer-tailor-8"]],
    ])
    expect(plan?.marker.slots.slice(0, -1)).toEqual(marker.slots.slice(0, -1))
    expect(plan?.marker.slots.at(-1)).toMatchObject({ ...marker.slots.at(-1), correction: {
      writerNodeKey: "objective-tailor-wave-correction-writer-tailor-8",
      reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-8",
    } })
    for (const [key, template] of plan?.templatesByNodeKey.entries() ?? []) {
      expect(template.context).toMatchObject({ objectiveTailorCandidateMode: true,
        selectedJobPreparation: { jobId: target.candidate.jobId }, objectiveTailorCandidateWitness: target,
        objectiveTailorCorrectionProof: proof })
      expect(JSON.stringify(template.context)).not.toContain("draft prose")
      const base = taskGraphTemplatesForSelectedJob({ jobId: target.candidate.jobId })
      expect(template.allowedActions).toEqual(key.includes("correction-writer")
        ? base.cover_letter_writer?.allowedActions : base.cover_letter_reviewer?.allowedActions)
    }
  })

  it("rejects stale graph, cross-slot task receipts, and source drift", () => {
    const { current, makeProof, witnesses, sourceNodes } = fixture(), proof = makeProof()!
    expect(prepareObjectiveTailorCorrectionPlan({ current: { ...current, revision: current.revision + 1 }, proof })).toBeUndefined()
    const other = witnesses[6]!
    expect(prepareObjectiveTailorCorrectionPlan({ current,
      proof: makeProof({ writerTaskId: `${other.slotId}-writer-task`, reviewerTaskId: `${other.slotId}-reviewer-task` }) })).toBeUndefined()
    const drifted = { ...current, nodes: current.nodes.map(node => node.key === sourceNodes.at(-1)!.key
      ? { ...node, goal: "Changed source" } : node) }
    expect(prepareObjectiveTailorCorrectionPlan({ current: drifted, proof })).toBeUndefined()
  })

  it("rejects a slot with an existing correction and a pair beyond the depth limit", () => {
    const occupied = fixture({ occupiedCorrection: true })
    expect(prepareObjectiveTailorCorrectionPlan({ current: occupied.current, proof: occupied.makeProof() })).toBeUndefined()
    const deep = fixture({ sourceDepth: 6, slots: 1 })
    expect(prepareObjectiveTailorCorrectionPlan({ current: deep.current, proof: deep.makeProof() })).toBeUndefined()
  })

  it("preserves the explicit V2 score floor when appending a correction", () => {
    const { current, makeProof } = fixture()
    const previous = current.objectiveTailor!
    const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
      sourceNodeCount: previous.sourceNodeCount, reportScoreFloor: 0, slots: previous.slots }
    const plan = prepareObjectiveTailorCorrectionPlan({ current: { ...current, objectiveTailor: marker }, proof: makeProof() })
    expect(plan?.marker).toEqual({ ...marker, slots: marker.slots.map((slot, index) => index === 7
      ? { ...slot, correction: { writerNodeKey: "objective-tailor-wave-correction-writer-tailor-8",
        reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-8" } } : slot) })
  })
})
