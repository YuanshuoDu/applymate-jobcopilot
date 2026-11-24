import { OBJECTIVE_TAILOR_GRAPH_MAX_NODES, parseObjectiveTailorGraph, type ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { appendObjectiveTailorTaskGraphProposal, TASK_GRAPH_LIMITS, type TaskGraphProposal, type TaskGraphState } from "../planning/task-graph.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { objectiveTailorWavePairPlan, parseObjectiveTailorWaveCandidateWitness, type ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { isObjectiveTailorWaveBudgetSnapshot } from "./objective-tailor-wave-profile.js"
import { parseObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"

type Row = Record<string, unknown>
export type ObjectiveTailorWaveCreatePlan = Readonly<{
  proposal: TaskGraphProposal
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  marker: ObjectiveTailorGraph
  templatesByNodeKey: ReadonlyMap<string, TaskGraphTaskTemplate>
}>

/** Composes only canonical per-candidate pair plans into one marker-checked wave append. */
export function prepareObjectiveTailorWaveCreatePlan(input: Readonly<{
  current: TaskGraphState
  witnesses: readonly unknown[]
  nextMarker: unknown
}>): ObjectiveTailorWaveCreatePlan | undefined {
  if (!dense(input.witnesses, 4) || input.witnesses.length < 1) return undefined
  const currentMarkerValue = ownData(input.current, "objectiveTailor")
  if (currentMarkerValue === invalid) return undefined
  const currentMarker = currentMarkerValue === absent ? null : parseObjectiveTailorGraph(currentMarkerValue, input.current.nodes)
  if (currentMarkerValue !== absent && !currentMarker) return undefined
  const plans = input.witnesses.map(objectiveTailorWavePairPlan)
  if (plans.some(plan => !plan)) return undefined
  const pairs = plans as NonNullable<typeof plans[number]>[]
  const revision = input.current.revision
  if (!Number.isSafeInteger(revision) || revision < 0 || pairs.some(plan => plan.proposal.expectedRevision !== revision
    || plan.witness.admittedRevision !== revision + 1 || plan.witness.sourceGraphRevision > revision)) return undefined
  const anchors = pairs.map(plan => [plan.witness.sourceGraphRevision, plan.witness.sourceGraphDigest, plan.witness.sourceStatusDigest] as const)
  if (anchors.some(anchor => canonicalTaskGraphJson(anchor) !== canonicalTaskGraphJson(anchors[0]))) return undefined
  if (!currentMarker && pairs.some(plan => plan.witness.sourceGraphRevision !== revision)) return undefined
  const refs = pairs.map(plan => plan.witness.candidateRef), jobs = pairs.map(plan => plan.witness.candidate.jobId)
  const slots = pairs.map(plan => plan.witness.slotId)
  if (!unique(refs) || !unique(jobs) || !unique(slots)) return undefined
  const sourceCount = currentMarker?.sourceNodeCount ?? input.current.nodes.length
  const sourceNodes = input.current.nodes.slice(0, sourceCount)
  if (pairs.some(plan => {
    const analyst = sourceNodes.find(node => node.key === plan.witness.sourceAnalystKeys[0])
    return !analyst || analyst.templateId !== "analyst" || analyst.status !== "completed" || analyst.verificationDisposition !== "typed"
  })) return undefined
  const proposalNodes = pairs.flatMap(plan => plan.proposal.nodes)
  const marker = parseObjectiveTailorGraph(input.nextMarker, [...input.current.nodes, ...proposalNodes])
  const priorSlots = currentMarker?.slots.length ?? 0
  if (!marker || marker.sourceNodeCount !== sourceCount || marker.slots.length !== priorSlots + pairs.length) return undefined
  const addedSlots = marker.slots.slice(priorSlots)
  if (pairs.some((plan, index) => {
    const witness = plan.witness, slot = addedSlots[index]
    return !slot || slot.slotId !== witness.slotId || slot.sourceAnalystNodeKey !== witness.sourceAnalystKeys[0]
      || slot.writerNodeKey !== witness.writerNodeKey || slot.reviewerNodeKey !== witness.reviewerNodeKey || slot.correction !== undefined
  })) return undefined
  const templatesByNodeKey = new Map(pairs.flatMap(plan => [...plan.templatesByNodeKey]))
  if (templatesByNodeKey.size !== pairs.length * 2 || proposalNodes.length !== pairs.length * 2) return undefined
  const first = pairs[0]!, writer = first.templatesByNodeKey.get(first.witness.writerNodeKey)
  const reviewer = first.templatesByNodeKey.get(first.witness.reviewerNodeKey)
  if (!writer || !reviewer) return undefined
  const proposal = { expectedRevision: revision, nodes: proposalNodes }
  const appended = appendObjectiveTailorTaskGraphProposal(input.current, proposal, {
    registeredTemplateIds: new Set(["cover_letter_writer", "cover_letter_reviewer"]),
    maxNodes: OBJECTIVE_TAILOR_GRAPH_MAX_NODES, maxDepth: TASK_GRAPH_LIMITS.maxDepth,
  }, marker)
  if (!appended.ok) return undefined
  return { proposal, templates: { cover_letter_writer: writer, cover_letter_reviewer: reviewer }, marker: appended.state.objectiveTailor!, templatesByNodeKey }
}

/** Used by the existing child-action gate; does not confer or bypass its owner/lease checks. */
export function isRegisteredObjectiveTailorWaveChild(candidate: Row, nodeKey: string): boolean {
  const context = plainRecord(candidate.context)
  if (context && Object.hasOwn(context, "objectiveTailorCorrectionProof")) return isRegisteredObjectiveTailorCorrectionChild(candidate, nodeKey)
  const plan = context && objectiveTailorWavePairPlan(context.objectiveTailorCandidateWitness)
  const roleKey = candidate.role === "writer" && candidate.taskType === "cover_letter_draft" ? plan?.witness.writerNodeKey
    : candidate.role === "reviewer" && candidate.taskType === "cover_letter_review" ? plan?.witness.reviewerNodeKey : undefined
  const expected = roleKey && plan?.templatesByNodeKey.get(roleKey)
  if (!context || context.objectiveTailorCandidateMode !== true || !plan || !expected || roleKey !== nodeKey) return false
  const actualContext = { ...context }, dependencyContext = actualContext.taskGraphDependencyResults
  delete actualContext.taskGraphDependencyResults
  if (canonicalTaskGraphJson({ ...candidate, context: actualContext }) !== canonicalTaskGraphJson(expected)) return false
  return candidate.role === "writer"
    ? validDependencyContext(dependencyContext, plan.witness)
    : dependencyContext === undefined
}

/** Admits a correction only with its closed prior-review proof and direct Reviewer dependency. */
export function isRegisteredObjectiveTailorCorrectionChild(candidate: Row, nodeKey: string): boolean {
  const context = plainRecord(candidate.context), proof = context && parseObjectiveTailorCorrectionProof(context.objectiveTailorCorrectionProof)
  const roleKey = candidate.role === "writer" && candidate.taskType === "cover_letter_draft" ? proof?.writerNodeKey
    : candidate.role === "reviewer" && candidate.taskType === "cover_letter_review" ? proof?.reviewerNodeKey : undefined
  const base = proof && taskGraphTemplatesForSelectedJob({ jobId: proof.candidateWitness.candidate.jobId })
  const template = roleKey && base ? base[candidate.role === "writer" ? "cover_letter_writer" : "cover_letter_reviewer"] : undefined
  if (!context || !proof || !template || roleKey !== nodeKey || context.objectiveTailorCandidateMode !== true
    || canonicalTaskGraphJson(context.objectiveTailorCandidateWitness) !== canonicalTaskGraphJson(proof.candidateWitness)) return false
  const actual = { ...context }, dependencyContext = actual.taskGraphDependencyResults
  delete actual.taskGraphDependencyResults
  const expectedContext = { objectiveTailorCandidateMode: true,
    selectedJobPreparation: { jobId: proof.candidateWitness.candidate.jobId },
    objectiveTailorCandidateWitness: proof.candidateWitness, objectiveTailorCorrectionProof: proof }
  if (canonicalTaskGraphJson({ ...candidate, context: actual }) !== canonicalTaskGraphJson({ ...template, context: expectedContext })) return false
  return candidate.role === "writer" ? validCorrectionDependency(dependencyContext, proof) : dependencyContext === undefined
}

export function objectiveTailorWaveChildExecutionAllowed(value: unknown): boolean {
  const row = plainRecord(value), input = row && plainRecord(row.turnInput ?? row.input)
  let actions: unknown = row?.rootAllowedActions
  if (typeof actions === "string") { try { actions = JSON.parse(actions) as unknown } catch { return false } }
  return Boolean(row && row.executionMode === "canonical_task_graph" && input
    && !Object.hasOwn(input, "selectedJobPreparation") && !Object.hasOwn(input, "verifiedShortlistSelection")
    && !Object.hasOwn(input, "selectedJobBatchPreparation")
    && isObjectiveTailorWaveBudgetSnapshot(row.rootBudgetSnapshot)
    && Array.isArray(actions) && actions.includes("agent.tailor"))
}

function validDependencyContext(value: unknown, witness: ObjectiveTailorWaveCandidateWitness): boolean {
  const context = exactRecord(value, "items,schemaVersion")
  if (!context || context.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence"
    || !dense(context.items, TASK_GRAPH_LIMITS.maxDependencies) || context.items.length !== witness.sourceAnalystKeys.length) return false
  return context.items.every((raw, index) => {
    const item = plainRecord(raw)
    return item?.dependencyKey === witness.sourceAnalystKeys[index] && item.role === "analyst" && item.taskStatus === "completed"
  })
}

function validCorrectionDependency(value: unknown, proof: import("./objective-tailor-correction-proof.js").ObjectiveTailorCorrectionProof): boolean {
  const context = exactRecord(value, "items,schemaVersion")
  if (!context || context.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence" || !dense(context.items, 1)
    || context.items.length !== 1) return false
  const item = exactRecord(context.items[0], "dependencyKey,dependencyTaskId,result,role,taskStatus")
  const result = item && exactRecord(item.result, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
  const ref = proof.prior.artifactRef
  return !!item && item.dependencyKey === proof.candidateWitness.reviewerNodeKey
    && item.dependencyTaskId === proof.prior.reviewerTaskId && item.role === "reviewer" && item.taskStatus === "completed"
    && !!result && result.schemaVersion === "agent-harness.v2.task-graph.result-projection" && result.trust === "untrusted"
    && result.availability === "available" && result.role === "reviewer" && result.status === "completed"
    && result.reviewStatus === "needs_revision" && result.reviewHash === proof.prior.reviewReceipt.reviewHash
    && canonicalTaskGraphJson(result.artifactRef) === canonicalTaskGraphJson(ref)
}

function dense(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !("value" in descriptor)) return false
  }
  return true
}
function plainRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const row = value as Row, keys = Reflect.ownKeys(row)
    return Object.getPrototypeOf(row) === Object.prototype && keys.every(key => typeof key === "string"
      && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!)) ? row : null
  } catch { return null }
}
function exactRecord(value: unknown, keys: string): Row | null {
  const row = plainRecord(value), expected = keys.split(",")
  return row && Reflect.ownKeys(row).length === expected.length && Reflect.ownKeys(row).every(key => typeof key === "string"
    && expected.includes(key) && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable
      && "value" in Object.getOwnPropertyDescriptor(row, key)!)) ? row : null
}
function ownData(value: object, key: string): unknown | typeof absent | typeof invalid {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return !descriptor ? absent : descriptor.enumerable && "value" in descriptor ? descriptor.value : invalid
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length }
const absent = Symbol("absent"), invalid = Symbol("invalid")
