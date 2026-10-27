import { SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA } from "@jobcopilot/agent-protocol"
import type { ScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { scheduledTaskGraphContinuationKey, type ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey, type ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

type Parsed = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "waiting_for_choice"; waitId: string }>
  | Readonly<{ status: "ready"; prepareProof: unknown; choice: { required: true; status: "answered"; scheduledWaitId: string } | { required: false } }>

export function parseScheduledPipelinePrepareContinuationResult(
  value: unknown,
  owner: ScheduledAutomationPipelineBridgeScope,
  attestation: ScheduledPipelineAttestation,
  handoff: ScheduledPipelineAnalyzeCheckpointProof,
  finalStepId: string,
  finalStepOrdinal: number,
): Parsed | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    const result = value as Record<string, unknown>
    if (result.status === "waiting_for_dependency" && keys.length === 2 && keys.includes("waitId") && validText(result.waitId, 128)) {
      return { status: "waiting_for_dependency", waitId: result.waitId }
    }
    if (result.status === "waiting_for_choice" && keys.length === 2 && keys.includes("waitId") && validText(result.waitId, 256)) {
      return { status: "waiting_for_choice", waitId: result.waitId }
    }
    if (result.status !== "ready" || keys.length !== 3 || !keys.includes("prepareProof") || !keys.includes("choice")) return null
    const choice = strictRecord(result.choice)
    const choiceRequired = choice?.required === true && Object.keys(choice).sort().join(",") === "required,scheduledWaitId,status"
      && choice.status === "answered" && validText(choice.scheduledWaitId, 256)
    const choiceDisabled = choice?.required === false && Object.keys(choice).sort().join(",") === "required"
    if (!choiceRequired && !choiceDisabled) return null
    const proof = strictRecord(result.prepareProof), receipt = parseScheduledTaskGraphContinuationReceipt(proof?.receipt)
    const completion = strictRecord(proof?.completion), wait = strictRecord(completion?.wait), nodes = completion?.nodes
    const sourceCount = attestation.schemaVersion === SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA ? 1 : attestation.scouts.length
    const prepareIndex = sourceCount + 1
    if (!proof || Object.keys(proof).sort().join(",") !== "completion,receipt,result" || !receipt || !completion || !wait
      || Object.keys(completion).sort().join(",") !== "graphRevision,nodes,schemaVersion,wait"
      || !Number.isSafeInteger(completion.graphRevision) || Number(completion.graphRevision) < receipt.prepareScheduleRevision
      || !Array.isArray(nodes) || nodes.length !== sourceCount + 2 || !Array.isArray(wait.targetTaskIds) || !Array.isArray(wait.matchedTaskIds)
      || Object.keys(wait).sort().join(",") !== "matchedTaskIds,mode,status,targetTaskIds,waitId"
      || wait.status !== "ready" || wait.mode !== "all" || wait.targetTaskIds.length !== 1 || wait.matchedTaskIds.length !== 1
      || wait.targetTaskIds[0] !== strictRecord(nodes[prepareIndex])?.taskId || wait.matchedTaskIds[0] !== strictRecord(nodes[prepareIndex])?.taskId
      || !validText(wait.waitId, 128) || !prepareProofMatches(owner, attestation, handoff, receipt, nodes)
      || choiceRequired && scheduledPrepareChoiceWaitId({ receipt, finalStepId, finalStepOrdinal }) !== choice.scheduledWaitId) return null
    return { status: "ready", prepareProof: result.prepareProof,
      choice: choiceRequired ? { required: true, status: "answered", scheduledWaitId: choice!.scheduledWaitId as string } : { required: false } }
  } catch { return null }
}

function prepareProofMatches(owner: ScheduledAutomationPipelineBridgeScope, attestation: ScheduledPipelineAttestation,
  handoff: ScheduledPipelineAnalyzeCheckpointProof, receipt: ScheduledTaskGraphContinuationReceipt, nodes: unknown[]): boolean {
  const v1 = attestation.schemaVersion === SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA
  const expectedSourceProofs = v1 ? [{ taskId: attestation.scout.taskId, attemptCount: attestation.scout.attemptCount }]
    : attestation.scouts.map(source => ({ taskId: source.taskId, attemptCount: source.attemptCount }))
  const expectedSources = expectedSourceProofs.map(source => source.taskId)
  const sourceRows = nodes.slice(0, expectedSources.length).map(strictRecord), sourceIds = sourceRows.map(row => row?.taskId)
  const analyst = strictRecord(nodes[expectedSources.length]), prepare = strictRecord(nodes[expectedSources.length + 1])
  const actualIds = sourceIds.filter((id): id is string => typeof id === "string")
  const expectedAnalystId = attestation.analyst.taskId
  const sourceAttemptsMatch = expectedSourceProofs.every(source => sourceRows.some(row => row?.taskId === source.taskId && row.attemptCount === source.attemptCount))
  const ownerMatches = receipt.owner.userId === owner.userId && receipt.owner.sessionId === owner.sessionId
    && receipt.owner.turnId === owner.turnId && receipt.owner.rootTaskId === owner.rootTaskId
    && receipt.owner.rootAttemptCount === owner.rootAttemptCount && receipt.owner.turnLeaseOwnerId === owner.turnLeaseOwnerId
    && receipt.owner.turnLeaseVersion === owner.turnLeaseVersion && receipt.owner.executionId === handoff.executionId
    && receipt.owner.executionAttemptCount === handoff.executionAttemptCount
  const sortedSources = [...expectedSources].sort()
  return ownerMatches && sourceRows.length === expectedSources.length && sourceRows.every(row => row?.role === "scout"
    && row.taskType === TASK_GRAPH_TEMPLATES.scout.taskType && row.status === "completed" && row.verification === "passed"
    && positive(row.attemptCount) && Array.isArray(row.dependsOnTaskIds) && row.dependsOnTaskIds.length === 0)
    && sameSet(actualIds, sortedSources) && sourceAttemptsMatch && analyst?.taskId === expectedAnalystId
    && analyst.taskType === TASK_GRAPH_TEMPLATES.analyst.taskType && analyst.status === "completed" && analyst.verification === "passed"
    && analyst.attemptCount === attestation.analyst.attemptCount && sameArray(analyst.dependsOnTaskIds, sortedSources)
    && prepare?.role === "prepare" && prepare.taskType === TASK_GRAPH_TEMPLATES.prepare.taskType
    && prepare.status === "completed" && prepare.verification === "passed" && positive(prepare.attemptCount)
    && validText(prepare.taskId, 256) && new Set([...actualIds, expectedAnalystId, prepare.taskId]).size === expectedSources.length + 2
    && Array.isArray(prepare.dependsOnTaskIds) && prepare.dependsOnTaskIds.length === 1 && prepare.dependsOnTaskIds[0] === expectedAnalystId
    && handoff.continuationKey === scheduledTaskGraphContinuationKey(owner, attestation, handoff.executionId, handoff.executionAttemptCount)
    && receipt.continuationKey === scheduledTaskGraphStableContinuationKey(receipt)
    && receipt.snapshotDigest === attestation.snapshotDigest && receipt.evidenceDigest === attestation.evidenceDigest
    && receipt.checkpointDigest === handoff.checkpointDigest && receipt.analyzeGraphRevision === attestation.graphRevision
    && receipt.prepareScheduleRevision === attestation.graphRevision + 1
}

function sameSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every(item => typeof item === "string") && value.length === expected.length
    && new Set(value).size === value.length && expected.every(item => value.includes(item))
}
function sameArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
}
function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== "string")) return null
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    result[key] = descriptor.value
  }
  return result
}
function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
