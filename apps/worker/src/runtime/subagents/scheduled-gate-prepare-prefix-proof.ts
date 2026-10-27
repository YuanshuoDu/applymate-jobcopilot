import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledTaskGraphContinuationKeyVersion } from "./scheduled-taskgraph-continuation-receipt.js"
import { projectScheduledPipelineGraph, projectScheduledPipelineGraphAtCurrentStage } from "./scheduled-pipeline-graph-shape.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import type { ScheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"

type Row = Record<string, unknown>
type Scope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
type ProofLoader = (client: Queryable, scope: Scope, taskId: string, result: unknown, continuationKey: string,
  waitId: string) => Promise<ScheduledPrepareTaskGraphProof | null>

/** Loads the exact receipt-bound Prepare proof and verifies its source rows against the current Gate graph. */
export async function readScheduledGatePreparePrefixProof(input: Readonly<{
  client: Queryable; scope: Scope; gateTaskId: string; gateRow: Row; evidence: ScheduledGateCheckpointEvidence
  graph: LoadedGraph; prepareTask: Readonly<{ id: string; result: unknown }>; loadProof: ProofLoader
}>): Promise<ScheduledPrepareTaskGraphProof | null> {
  const { client, scope, gateTaskId, gateRow, evidence, graph, prepareTask } = input
  const owner = { ...scope, rootAttemptCount: Number(gateRow.rootAttemptCount), executionId: String(gateRow.executionId),
    executionAttemptCount: Number(gateRow.executionAttemptCount) }
  const receipt = await readScheduledGateRegistrationReceipt(client, { ...scope, owner, gateTaskId })
  const completion = record(record(record(prepareTask.result)?.taskGraphScheduledPrepareProofFacts)?.completion)
  if (!receipt || !completion || !positive(completion.graphRevision) || receipt.continuationKey !== evidence.continuationKey || receipt.snapshotDigest !== evidence.snapshotDigest
    || receipt.evidenceDigest !== evidence.evidenceDigest || receipt.checkpointDigest !== evidence.checkpointDigest
    || receipt.owner.rootAttemptCount !== evidence.owner.rootAttemptCount || receipt.owner.executionId !== evidence.owner.executionId
    || receipt.owner.executionAttemptCount !== evidence.owner.executionAttemptCount || receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision
    || receipt.gateAppendRevision <= completion.graphRevision
    || receipt.gateAppendRevision > Number(graph.state?.revision)) return null
  const proof = await input.loadProof(client, scope, prepareTask.id, prepareTask.result,
    evidence.prepareWaitContinuationKey, receipt.prepareWaitId)
  return proof && receipt.prepareScheduleRevision === proof.receipt.prepareScheduleRevision
    && receipt.prepareWaitId === proof.completion.wait.waitId
    && gateAppendRevisionMatches(graph, gateTaskId, gateRow, receipt.gateAppendRevision, scope.rootTaskId) ? proof : null
}

/** Requires every source, Analyst, and Prepare completion binding to match current graph/task rows. */
export function scheduledGatePreparePrefixMatches(graph: LoadedGraph, proof: ScheduledPrepareTaskGraphProof): boolean {
  const nodes = graph.snapshot?.nodes, current = graph.state?.nodes
  const version = scheduledTaskGraphContinuationKeyVersion(proof.receipt.continuationKey)
  const currentShape = nodes && projectScheduledPipelineGraphAtCurrentStage(nodes)
  const shape = currentShape && (currentShape.projection.stage === "prepare" || currentShape.projection.stage === "gate"
    || currentShape.projection.stage === "audit")
    ? currentShape.projection : null
  const prefixCount = shape && shape.scouts.length + 2, prefixNodes = prefixCount ? nodes?.slice(0, prefixCount) : undefined
  const prefix = prefixNodes && version && projectScheduledPipelineGraph(prefixNodes, version, "prepare")
  if (!nodes || !current || !shape || !prefix || !prefixCount || !version || currentShape?.version !== version
    || proof.completion.nodes.length !== prefixCount
    || current.filter(value => prefixNodes?.some(node => node.key === value.key)).length !== prefixCount) return false
  const sourceCount = shape.scouts.length
  for (let index = 0; index < prefixCount; index += 1) {
    const node = prefixNodes[index]!, certified = proof.completion.nodes[index]!, state = current.find(value => value.key === node.key)
    const task = graph.tasks.get(node.taskId), role = index < sourceCount ? "scout" : index === sourceCount ? "analyst" : "prepare"
    const dependencies = node.dependsOn.map(key => nodes.find(value => value.key === key)?.taskId).filter((value): value is string => Boolean(value)).sort()
    if (certified.role !== role || node.templateId !== role || node.taskId !== certified.taskId
      || node.depth !== (role === "scout" ? 1 : role === "analyst" ? 2 : 3)
      || node.verificationDisposition !== (role === "prepare" ? "specialized" : "typed")
      || certified.status !== "completed" || certified.verification !== "passed" || !task || certified.attemptCount !== task.attemptCount
      || certified.taskType !== task.taskType || !sameArray([...certified.dependsOnTaskIds].sort(), dependencies)
      || !state || state.taskId !== node.taskId || state.status !== "completed"
      || state.failureReason !== null && state.failureReason !== undefined
      || task.id !== certified.taskId || task.status !== "completed" || task.failureReason !== null
      || task.role !== certified.role || task.taskType !== certified.taskType || task.attemptCount !== certified.attemptCount) return false
  }
  return true
}

function gateAppendRevisionMatches(graph: LoadedGraph, gateTaskId: string, row: Row, revision: number, rootTaskId: string): boolean {
  const events = graph.state?.appliedEvents.filter(event => event.nodeKey === "gate" && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, "gate", 1, "task.started")) ?? []
  return events.length === 1 ? events[0]?.expectedRevision === revision
    : events.length === 0 && row.id === gateTaskId && row.status === "queued" && Number(row.attemptCount) === 0
      && graph.state?.revision === revision
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function record(value: unknown): Row | null {
  const row = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  try { const prototype = Object.getPrototypeOf(row); return prototype === Object.prototype || prototype === null ? row as Row : null } catch { return null }
}
