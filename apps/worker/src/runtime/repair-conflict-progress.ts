import { Value } from "@sinclair/typebox/value"

import { TASK_GRAPH_LIMITS } from "./planning/task-graph.js"
import { validateTaskGraphVerificationContract } from "./planning/task-graph-verification.js"
import { TaskGraphProposalInputSchema } from "./tools/planning-executors.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { stableJson } from "./turns/turn-engine-replay.js"
import type { TurnEngineToolCall } from "./turns/turn-engine-tool-types.js"

const CONFLICT_CODE = "task_graph_repair_conflict"
const RESULT_PREFIX = "tool-result:"
const MAX_OBSERVATIONS = 512
const MAX_CHECKPOINT_INPUTS = 512
const REPEATED_REPAIR_OBSERVATION = Object.freeze({
  signature: "repair_conflict_retry",
  stateFingerprint: "unchanged_trusted_repair_epoch",
})

type CurrentCheckpoint = Readonly<{
  inputThroughSequence: bigint
  consumedInputIds: ReadonlySet<string>
  taskGraphRevision: number
}>
type ObservationRow = Readonly<{ id: string; content: unknown }>
type IntentResult = Readonly<{ identity: string; callId: string }>
type RepairConflictEpoch = {
  checkpoint: CurrentCheckpoint
  seenObservationIds: Set<string>
  denialsByIdentity: Map<string, Set<string>>
}

export type RepairConflictProgressInput = Readonly<{
  snapshot: Pick<StepContextSnapshot, "toolObservations">
  toolCalls: readonly TurnEngineToolCall[]
}>
export type RepairConflictProgressCheckpoint = Readonly<{
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
  taskGraphRevision?: number
}>
export type RepairConflictProgressObservation = Readonly<{
  signature: "repair_conflict_retry"
  stateFingerprint: "unchanged_trusted_repair_epoch"
}>

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string")) return null
    const names = keys as string[]
    const allowed = new Set([...required, ...optional])
    if (required.some(key => !names.includes(key)) || names.some(key => !allowed.has(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of names) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseArray(value: unknown, minimum: number, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < minimum || Number(length) > maximum || keys.length !== Number(length) + 1) return null
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function parseCheckpoint(value: unknown): CurrentCheckpoint | null {
  const parsed = record(value, ["inputThroughSequence", "consumedInputIds"], ["taskGraphRevision"])
  if (!parsed || !Object.hasOwn(parsed, "taskGraphRevision") || typeof parsed.inputThroughSequence !== "bigint" || parsed.inputThroughSequence < 0n
    || !Number.isSafeInteger(parsed.taskGraphRevision) || Number(parsed.taskGraphRevision) < 0) return null
  const ids = denseArray(parsed.consumedInputIds, 0, MAX_CHECKPOINT_INPUTS)
  if (!ids) return null
  const consumedInputIds = new Set<string>()
  for (const id of ids) {
    if (!boundedText(id, 512) || consumedInputIds.has(id)) return null
    consumedInputIds.add(id)
  }
  return { inputThroughSequence: parsed.inputThroughSequence, consumedInputIds, taskGraphRevision: Number(parsed.taskGraphRevision) }
}

function observationRows(snapshot: RepairConflictProgressInput["snapshot"]): ObservationRow[] | null {
  const values = denseArray(snapshot.toolObservations, 0, MAX_OBSERVATIONS)
  if (!values) return null
  const rows: ObservationRow[] = []
  for (const value of values) {
    const parsed = record(value, ["id", "content"])
    if (!parsed || !boundedText(parsed.id, 512)) return null
    rows.push({ id: parsed.id, content: parsed.content })
  }
  return rows
}

function checkpointAdvance(previous: CurrentCheckpoint, next: CurrentCheckpoint): { kind: "same" | "advanced" | "uncertain"; checkpoint: CurrentCheckpoint } {
  if (next.inputThroughSequence < previous.inputThroughSequence || next.taskGraphRevision < previous.taskGraphRevision) return { kind: "uncertain", checkpoint: next }
  const inputIdsCanAdvance = next.inputThroughSequence >= previous.inputThroughSequence
  const consumedInputIds = new Set(previous.consumedInputIds)
  const addedInputId = inputIdsCanAdvance && [...next.consumedInputIds].some(id => !previous.consumedInputIds.has(id))
  if (inputIdsCanAdvance) for (const id of next.consumedInputIds) consumedInputIds.add(id)
  const advanced = next.inputThroughSequence > previous.inputThroughSequence || next.taskGraphRevision > previous.taskGraphRevision || addedInputId
  return {
    kind: advanced ? "advanced" : "same",
    checkpoint: {
      inputThroughSequence: next.inputThroughSequence > previous.inputThroughSequence ? next.inputThroughSequence : previous.inputThroughSequence,
      consumedInputIds,
      taskGraphRevision: Math.max(previous.taskGraphRevision, next.taskGraphRevision),
    },
  }
}

function repairIntent(value: unknown, revision: number): string | null {
  try {
    const proposal = record(value, ["expectedRevision", "nodes"])
    if (!proposal || proposal.expectedRevision !== revision || !Number.isSafeInteger(proposal.expectedRevision)
      || !Value.Check(TaskGraphProposalInputSchema, value)) return null
    const encoded = JSON.stringify(value)
    if (!encoded || new TextEncoder().encode(encoded).byteLength > TASK_GRAPH_LIMITS.maxProposalBytes) return null
    const nodes = denseArray(proposal.nodes, 1, 1)
    const node = nodes && record(nodes[0], ["key", "templateId", "goal", "successCriteria", "dependsOn", "verification", "repairOf"])
    if (!node || !boundedText(node.key, TASK_GRAPH_LIMITS.maxKeyLength) || !boundedText(node.templateId, TASK_GRAPH_LIMITS.maxTemplateIdLength)
      || !boundedText(node.goal, TASK_GRAPH_LIMITS.maxGoalLength)) return null
    const relation = record(node.repairOf, ["nodeKey", "taskId", "criterionIds"], ["graphRootTaskId"])
    if (!relation || !boundedText(relation.nodeKey, TASK_GRAPH_LIMITS.maxKeyLength) || !boundedText(relation.taskId, TASK_GRAPH_LIMITS.maxKeyLength)
      || (Object.hasOwn(relation, "graphRootTaskId") && !boundedText(relation.graphRootTaskId, TASK_GRAPH_LIMITS.maxKeyLength))
      || relation.nodeKey === node.key) return null
    const dependencies = denseArray(node.dependsOn, 0, TASK_GRAPH_LIMITS.maxDependencies)
    if (!dependencies || dependencies.some(item => !boundedText(item, TASK_GRAPH_LIMITS.maxKeyLength))
      || new Set(dependencies).size !== dependencies.length || dependencies.includes(relation.nodeKey)) return null
    const verification = validateTaskGraphVerificationContract(node.verification, node.templateId)
    if (!verification.ok) return null
    const relationIds = denseArray(relation.criterionIds, 1, TASK_GRAPH_LIMITS.maxSuccessCriteria)
    if (!relationIds || relationIds.some(id => !boundedText(id, 64)) || new Set(relationIds).size !== relationIds.length) return null
    const verificationIds = verification.contract.criteria.map(criterion => criterion.id)
    if (verificationIds.length !== relationIds.length || verificationIds.some(id => !relationIds.includes(id))) return null
    const criteria = verification.contract.criteria.map(criterion => [criterion.id, criterion.check] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    return stableJson({
      expectedRevision: revision,
      key: node.key,
      templateId: node.templateId,
      repairRoot: Object.hasOwn(relation, "graphRootTaskId") ? { present: true, value: relation.graphRootTaskId } : { present: false },
      target: { nodeKey: relation.nodeKey, taskId: relation.taskId },
      criterionIds: [...relationIds].sort(),
      verification: { schemaVersion: verification.contract.schemaVersion, role: verification.contract.role, criteria },
      dependsOn: dependencies,
    })
  } catch { return null }
}

function deniedIntent(row: ObservationRow, revision: number): IntentResult | null {
  if (!row.id.startsWith(RESULT_PREFIX)) return null
  const callId = row.id.slice(RESULT_PREFIX.length)
  if (!boundedText(callId, 256)) return null
  const result = record(row.content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"])
  if (!result || result.toolCallId !== callId || result.toolName !== "agent.plan" || result.status !== "failed"
    || result.errorCode !== CONFLICT_CODE) return null
  const output = record(result.output, ["code"])
  if (!output || output.code !== CONFLICT_CODE) return null
  const identity = repairIntent(result.input, revision)
  return identity ? { identity, callId } : null
}

function newEpoch(checkpoint: CurrentCheckpoint, rows: readonly ObservationRow[]): RepairConflictEpoch {
  return { checkpoint, seenObservationIds: new Set(rows.map(row => row.id)), denialsByIdentity: new Map() }
}

export function createRepairConflictProgressDetector(repeatLimit = 2): Readonly<{
  observe(input: RepairConflictProgressInput, checkpoint: RepairConflictProgressCheckpoint | undefined): RepairConflictProgressObservation | null
}> {
  if (!Number.isInteger(repeatLimit) || repeatLimit < 2) throw new TypeError("repeatLimit must be an integer of at least 2")
  let epoch: RepairConflictEpoch | undefined
  return {
    observe(input, rawCheckpoint) {
      const checkpoint = parseCheckpoint(rawCheckpoint)
      const rows = observationRows(input.snapshot)
      if (!checkpoint || !rows) { epoch = undefined; return null }
      if (!epoch) {
        epoch = newEpoch(checkpoint, rows)
        return null
      }
      const advance = checkpointAdvance(epoch.checkpoint, checkpoint)
      if (advance.kind !== "same") {
        epoch = newEpoch(advance.checkpoint, rows)
        return null
      }
      epoch.checkpoint = advance.checkpoint
      const occurrences = new Map<string, number>()
      for (const row of rows) occurrences.set(row.id, (occurrences.get(row.id) ?? 0) + 1)
      const seenBefore = new Set(epoch.seenObservationIds)
      const uniqueRows = new Map<string, ObservationRow>()
      for (const row of rows) if (occurrences.get(row.id) === 1) uniqueRows.set(row.id, row)
      for (const row of rows) epoch.seenObservationIds.add(row.id)
      for (const row of uniqueRows.values()) {
        if (seenBefore.has(row.id)) continue
        const denial = deniedIntent(row, checkpoint.taskGraphRevision)
        if (!denial) continue
        const callIds = epoch.denialsByIdentity.get(denial.identity) ?? new Set<string>()
        callIds.add(denial.callId)
        epoch.denialsByIdentity.set(denial.identity, callIds)
      }
      if (input.toolCalls.length !== 1 || input.toolCalls[0]?.name !== "agent.plan") return null
      const candidate = repairIntent(input.toolCalls[0].arguments, checkpoint.taskGraphRevision)
      if (!candidate || (epoch.denialsByIdentity.get(candidate)?.size ?? 0) < repeatLimit) return null
      return REPEATED_REPAIR_OBSERVATION
    },
  }
}
