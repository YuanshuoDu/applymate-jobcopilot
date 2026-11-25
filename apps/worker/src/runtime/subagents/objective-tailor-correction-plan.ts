import { OBJECTIVE_TAILOR_GRAPH_MAX_NODES, parseObjectiveTailorGraph, type ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { appendObjectiveTailorTaskGraphProposal, TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphProposal, type TaskGraphState } from "../planning/task-graph.js"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { taskGraphFingerprint, taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphTaskTemplate } from "./task-graph-schedule-input.js"
import { objectiveTailorCorrectionNodeKeys, parseObjectiveTailorCorrectionProof,
  type ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { isTaskGraphTerminal } from "../planning/task-graph-transition-rules.js"

type CurrentState = TaskGraphState & Readonly<{ rootSuccessCriteria?: readonly string[] }>
export type ObjectiveTailorCorrectionPlan = Readonly<{
  proof: ObjectiveTailorCorrectionProof
  proposal: TaskGraphProposal
  marker: ObjectiveTailorGraph
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  templatesByNodeKey: ReadonlyMap<string, TaskGraphTaskTemplate>
}>

/** Creates one server-derived successor pair only from its exact completed current Reviewer. */
export function prepareObjectiveTailorCorrectionPlan(input: Readonly<{
  current: CurrentState
  proof: unknown
}>): ObjectiveTailorCorrectionPlan | undefined {
  try { return prepare(input) } catch { return undefined }
}

function prepare(input: Readonly<{ current: CurrentState; proof: unknown }>): ObjectiveTailorCorrectionPlan | undefined {
  const current = input.current, proof = parseObjectiveTailorCorrectionProof(input.proof)
  if (!proof || !Number.isSafeInteger(current.revision) || proof.graphRevision !== current.revision) return undefined
  const markerField = Object.getOwnPropertyDescriptor(current, "objectiveTailor")
  if (!markerField?.enumerable || !("value" in markerField)) return undefined
  const previous = parseObjectiveTailorGraph(markerField.value, current.nodes)
  if (!previous) return undefined
  const matches = previous.slots.filter(slot => slot.slotId === proof.slotId), slot = matches[0]
  if (matches.length !== 1 || !slot || slot.correction) return undefined
  const witness = proof.candidateWitness
  if (witness.slotId !== slot.slotId || witness.writerNodeKey !== slot.writerNodeKey
    || witness.reviewerNodeKey !== slot.reviewerNodeKey || witness.sourceAnalystKeys[0] !== slot.sourceAnalystNodeKey
    || !sourceProofMatches(current, previous, witness)) return undefined
  const writers = current.nodes.filter(node => node.key === slot.writerNodeKey), reviewers = current.nodes.filter(node => node.key === slot.reviewerNodeKey)
  const writer = writers[0], reviewer = reviewers[0]
  if (writers.length !== 1 || reviewers.length !== 1 || !writer || !reviewer
    || writer.templateId !== "cover_letter_writer" || writer.status !== "completed" || writer.verificationDisposition !== "specialized"
    || writer.taskId !== proof.prior.writerTaskId || !oneDependency(writer.dependsOn, slot.sourceAnalystNodeKey)
    || reviewer.templateId !== "cover_letter_reviewer" || reviewer.status !== "completed" || reviewer.verificationDisposition !== "specialized"
    || reviewer.taskId !== proof.prior.reviewerTaskId || !oneDependency(reviewer.dependsOn, writer.key)
    || current.nodes.filter(node => node.taskId === proof.prior.writerTaskId).length !== 1
    || current.nodes.filter(node => node.taskId === proof.prior.reviewerTaskId).length !== 1) return undefined
  const keys = objectiveTailorCorrectionNodeKeys(slot.slotId)
  if (!keys || current.nodes.some(node => node.key === keys.writerNodeKey || node.key === keys.reviewerNodeKey)) return undefined
  const selected = taskGraphTemplatesForSelectedJob({ jobId: witness.candidate.jobId })
  const writerBase = selected.cover_letter_writer, reviewerBase = selected.cover_letter_reviewer
  if (!writerBase || !reviewerBase) return undefined
  const context = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId: witness.candidate.jobId },
    objectiveTailorCandidateWitness: witness, objectiveTailorCorrectionProof: proof }
  const writerTemplate = { ...writerBase, context }, reviewerTemplate = { ...reviewerBase, context }
  const nodes: readonly TaskGraphNodeProposal[] = [
    { key: keys.writerNodeKey, templateId: "cover_letter_writer", goal: "Revise this job's cover letter using its verified review receipt.",
      successCriteria: ["Save a current immutable correction artifact for this job."], dependsOn: [slot.reviewerNodeKey] },
    { key: keys.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Review only the exact correction artifact for this job.",
      successCriteria: ["Persist a review receipt for the exact correction artifact."], dependsOn: [keys.writerNodeKey] },
  ]
  const proposal: TaskGraphProposal = { expectedRevision: current.revision, nodes }
  const nextMarker = { schemaVersion: previous.schemaVersion, sourceNodeCount: previous.sourceNodeCount,
    ...(previous.schemaVersion === "agent-harness.v2.objective-tailor-graph.v2" ? { reportScoreFloor: previous.reportScoreFloor } : {}),
    slots: previous.slots.map(value => value.slotId === slot.slotId ? { ...value, correction: keys } : value) }
  const appended = appendObjectiveTailorTaskGraphProposal(current, proposal, {
    registeredTemplateIds: new Set(["cover_letter_writer", "cover_letter_reviewer"]),
    maxNodes: OBJECTIVE_TAILOR_GRAPH_MAX_NODES, maxDepth: TASK_GRAPH_LIMITS.maxDepth,
  }, nextMarker)
  if (!appended.ok || !appended.state.objectiveTailor) return undefined
  return { proof, proposal, marker: appended.state.objectiveTailor,
    templates: { cover_letter_writer: writerTemplate, cover_letter_reviewer: reviewerTemplate },
    templatesByNodeKey: new Map([[keys.writerNodeKey, writerTemplate], [keys.reviewerNodeKey, reviewerTemplate]]) }
}

function sourceProofMatches(current: CurrentState, marker: ObjectiveTailorGraph,
  witness: ObjectiveTailorCorrectionProof["candidateWitness"]): boolean {
  const source = current.nodes.slice(0, marker.sourceNodeCount), analyst = source.find(node => node.key === witness.sourceAnalystKeys[0])
  if (source.length !== marker.sourceNodeCount || !analyst || analyst.templateId !== "analyst"
    || analyst.status !== "completed" || analyst.verificationDisposition !== "typed"
    || source.some(node => !isTaskGraphTerminal(node.status))
    || witness.sourceGraphRevision >= witness.admittedRevision || witness.admittedRevision > current.revision) return false
  const taskIds = new Map<string, string>()
  for (const node of source) {
    if (typeof node.taskId !== "string" || !node.taskId) return false
    taskIds.set(node.key, node.taskId)
  }
  const sourceState: TaskGraphState = { revision: current.revision, nodes: source, appliedEvents: [] }
  const snapshot: TaskGraphSnapshot = taskGraphSnapshot(sourceState, taskIds, current.rootSuccessCriteria)
  const statuses = source.map(node => ({ key: node.key, status: node.status }))
  return taskGraphFingerprint(snapshot) === witness.sourceGraphDigest
    && taskGraphFingerprint(statuses) === witness.sourceStatusDigest
}

function oneDependency(value: readonly string[], expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected
}
