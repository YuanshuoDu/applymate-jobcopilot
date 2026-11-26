import { createHash } from "node:crypto"
import { canonicalTaskGraphReadObservations, createTaskGraphObservedReadEvidenceIndex, hydrateTaskGraphObservedReadEvidence,
  parseDurableDiscoveryReference, parseTaskGraphRestoredToolObservations, recordTaskGraphObservedReadOutput } from "@jobcopilot/shared/task-graph-read-observations"
import { canonicalTaskGraphReceiptJson, TASK_GRAPH_REPLAY_CALL_PREFIX, validateTaskGraphVerificationItems,
  type TaskGraphReplayReceipt, type TaskGraphToolVerificationScope } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import { isTaskGraphEvidenceToolName, taskGraphEvidenceDigest, taskGraphResultDigest } from "@jobcopilot/shared/task-graph-verification-digest"
import { parseObjectiveVerifiedSourceResultForRead } from "../broker/objective-application-review-source-verification"
import { objectiveJourneyAnalystGraphRequirements } from "./objective-journey-report-requirement-proof"
import type { ObjectiveTaskToolReceiptSet } from "./objective-journey-report-requirement-receipts"
import type { ObjectiveJourneyProofContext } from "./objective-journey-report-source"
import { OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA, parseObjectiveSourceToolReceiptEvidence,
  type ObjectiveSourceToolReceiptEvidence } from "./objective-source-tool-receipts-contract"

type Row = Record<string, unknown>
type Role = "scout" | "analyst"
type Group = "discoveredJobs" | "analyzedJobs"
type VerifiedReadIndexes = Readonly<{ evidence: ReturnType<typeof createTaskGraphObservedReadEvidenceIndex>; durable: ReturnType<typeof createTaskGraphObservedReadEvidenceIndex> }>
const VERIFIER = "agent-harness.v2.task-graph-verifier.v1"
const DIGEST = /^[a-f0-9]{64}$/
const KEY = /^src_[A-Za-z0-9_-]{43}$/
const RECEIPT_TOOLS = new Set(["jobs.discover", "jobs.search", "jobs.get", "tool_results.read"])
export type ObjectiveSourceToolScope = Readonly<{
  scope: TaskGraphToolVerificationScope; sourceKey: string; group: Group; role: Role
  source: Row; node: Row; task: Row
}>

/** Resolves one opaque source key to the current validated Objective group and task. */
export function resolveObjectiveSourceToolScope(context: ObjectiveJourneyProofContext | null | undefined,
  sourceKey: string): ObjectiveSourceToolScope | undefined {
  try {
    if (!context || !KEY.test(sourceKey) || !context.sourceGroups) return undefined
    const memberships = (Object.entries(context.sourceGroups.groups) as [Group, readonly string[]][]).flatMap(([group, keys]) =>
      keys.filter(key => key === sourceKey).map(() => ({ group, role: group === "discoveredJobs" ? "scout" as const : "analyst" as const })))
    if (memberships.length !== 1) return undefined
    const sourceRows = context.manifest.sources.filter(source => source.sourceKey === sourceKey)
    const membership = memberships[0]!, source = sourceRows.length === 1 ? sourceRows[0] : undefined
    const progress = source && context.progress.nodes[source.nodeIndex], node = source && context.graphNodes[source.nodeIndex]
    const task = progress && context.tasks.get(progress.taskId)
    if (!source || !progress || !node || !task || !row(node) || !row(task) || source.role !== membership.role
      || source.resultState !== "valid" || source.taskStatus !== "completed" || source.roleResultStatus === undefined
      || task.id !== progress.taskId || task.sessionId !== context.sessionId || task.turnId !== context.sourceTurnId
      || task.rootTaskId !== context.rootTaskId || task.parentTaskId !== context.rootTaskId || task.role !== membership.role
      || task.taskType !== (membership.role === "scout" ? "job_discovery" : "job_analysis") || task.status !== "completed"
      || task.failureReason !== null || task.leaseOwner !== null || task.leaseExpiresAt !== null || !positive(task.attemptCount)
      || node.key !== progress.key || node.taskId !== progress.taskId || node.templateId !== membership.role
      || node.verificationDisposition !== "typed" || !validVerification(node.verification, membership.role)) return undefined
    const scope = { userId: context.userId, sessionId: context.sessionId, turnId: context.sourceTurnId,
      rootTaskId: context.rootTaskId, parentTaskId: context.rootTaskId, taskId: task.id, attemptCount: Number(task.attemptCount) }
    return { scope, sourceKey, group: membership.group, role: membership.role, source, node, task }
  } catch { return undefined }
}

/** Revalidates stored result, evidence, dependencies and receipt lifecycle before projection. */
export function proveObjectiveSourceToolReceipts(context: ObjectiveJourneyProofContext | null | undefined,
  resolved: ObjectiveSourceToolScope | undefined, receiptSet: ObjectiveTaskToolReceiptSet | null | undefined): ObjectiveSourceToolReceiptEvidence | undefined {
  try {
    const current = context && resolved && resolveObjectiveSourceToolScope(context, resolved.sourceKey)
    if (!context || !current || !resolved || !receiptSet || !sameResolved(current, resolved)
      || !sameScope(current.scope, receiptSet, current.task)) return undefined
    const verifiedIndex = resultProof(context, current, receiptSet)
    if (!verifiedIndex) return undefined
    const candidates = receiptCandidates(resolved.scope, receiptSet, verifiedIndex.durable)
    if (!candidates || candidates.length < 1 || candidates.length > 64) return undefined
    return parseObjectiveSourceToolReceiptEvidence({ schemaVersion: OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA,
      graphRevision: context.graphRevision, sourceKey: current.sourceKey, role: current.role,
      receipts: candidates.map((candidate, index) => ({ ordinal: index + 1, receiptKey: receiptKey(context, current, candidate),
        toolName: candidate.toolName, delivery: candidate.replay ? "replayed" : "fresh" })) })
  } catch { return undefined }
}

type Candidate = Readonly<{ call: Row; result: Row; toolName: string; toolVersion: unknown; replay?: TaskGraphReplayReceipt }>
function resultProof(context: ObjectiveJourneyProofContext, resolved: ObjectiveSourceToolScope, read: ObjectiveTaskToolReceiptSet): VerifiedReadIndexes | undefined {
  const result = parseObjectiveVerifiedSourceResultForRead(resolved.task.result, resolved.role, String(resolved.task.id)), envelope = record(parseJson(resolved.task.result))
  const report = envelope && record(envelope.taskGraphVerificationReport), verification = record(resolved.node.verification)
  if (!result || result.status !== resolved.source.roleResultStatus || !report || !verification
    || !validReport(report, verification, resolved.role, context, resolved, read)) return undefined
  if (!validReceiptSet(resolved.scope, read)) return undefined
  const index = createTaskGraphObservedReadEvidenceIndex()
  try { hydrateTaskGraphObservedReadEvidence(index, read.evidenceObservations) } catch { return undefined }
  if (index.conflicts.size > 0 || !boundEvidence(result, index)) return undefined
  const ids = [...index.entries.values()].map(item => item.id), resultDigest = taskGraphResultDigest(result)
  if (report.resultDigest !== resultDigest || taskGraphEvidenceDigest(read.items, read.outcomes, ids, resultDigest, read.replayReceipts) !== report.evidenceDigest) return undefined
  if (resolved.role === "analyst" && !validDependencies(context, resolved, report)) return undefined
  const durable = createTaskGraphObservedReadEvidenceIndex()
  try {
    for (const observation of parseTaskGraphRestoredToolObservations(read.evidenceObservations)) {
      if (observation.failed || (observation.toolName !== "jobs.discover" && observation.toolName !== "tool_results.read")) continue
      if (!recordTaskGraphObservedReadOutput(durable, observation.toolName, observation.output, observation.input)) return undefined
    }
  } catch { return undefined }
  return { evidence: index, durable }
}

function validReport(report: Row, verification: Row, role: Role, context: ObjectiveJourneyProofContext,
  resolved: ObjectiveSourceToolScope, read: ObjectiveTaskToolReceiptSet): boolean {
  const criteria = dense(report.criteria, 8), expected = dense(verification.criteria, 8)
  if (!exact(report, Object.hasOwn(report, "dependencyBindings") ? ["criteria", "dependencyBindings", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion"] : ["criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion"])
    || report.verifierVersion !== VERIFIER || report.status !== "passed" || report.reasonCode !== "criteria_met"
    || !DIGEST.test(String(report.resultDigest)) || !DIGEST.test(String(report.evidenceDigest)) || !criteria || !expected || criteria.length !== expected.length
    || !criteria.every((item, index) => { const row = record(item), criterion = record(expected[index]); return !!row && !!criterion && exact(row, ["criterionId", "reasonCode", "status"])
      && row.criterionId === criterion.id && row.status === "passed" && row.reasonCode === "criteria_met" })) return false
  if (role === "scout") return !Object.hasOwn(report, "dependencyBindings")
  const info = objectiveJourneyAnalystGraphRequirements(verification)
  return !!info?.hasScoutMembership && Object.hasOwn(report, "dependencyBindings") && !!read && resolved.scope.taskId === resolved.task.id && context.graphRevision > 0
}

function validDependencies(context: ObjectiveJourneyProofContext, resolved: ObjectiveSourceToolScope, report: Row): boolean {
  const verification = record(resolved.node.verification), info = verification && objectiveJourneyAnalystGraphRequirements(verification)
  const bindings = report && dense(report.dependencyBindings, 8), keys = info?.dependencyNodeKeys ?? []
  const direct = dense(resolved.node.dependsOn, 8)
  if (!info || !bindings || bindings.length !== keys.length || new Set(keys).size !== keys.length
    || !direct || keys.some(key => !direct.includes(key))) return false
  const sorted = [...keys].sort()
  return sorted.every((key, index) => {
    const binding = record(bindings[index]), progress = context.progress.nodes.find(node => node.key === key), depNode = progress && row(context.graphNodes[context.progress.nodes.indexOf(progress)])
    const task = progress && row(context.tasks.get(progress.taskId)), envelope = task && record(parseJson(task.result)), depReport = envelope && record(envelope.taskGraphVerificationReport)
    const depResult = task ? parseObjectiveVerifiedSourceResultForRead(task.result, "scout", String(task.id)) : undefined
    return !!binding && exact(binding, ["attemptCount", "evidenceDigest", "nodeDigest", "nodeKey", "reportDigest", "resultDigest", "taskId"])
      && binding.nodeKey === key && !!progress && progress.templateId === "scout" && !!depNode && depNode.key === key && depNode.templateId === "scout"
      && depNode.verificationDisposition === "typed" && validVerification(depNode.verification, "scout")
      && !!task && task.id === progress.taskId && task.sessionId === context.sessionId && task.turnId === context.sourceTurnId
      && task.rootTaskId === context.rootTaskId && task.parentTaskId === context.rootTaskId && task.role === "scout"
      && task.taskType === "job_discovery" && task.status === "completed"
      && task.failureReason === null && task.leaseOwner === null && task.leaseExpiresAt === null && positive(task.attemptCount)
      && !!depResult && !!depReport && depReport.status === "passed" && binding.taskId === task.id && binding.attemptCount === task.attemptCount
      && binding.resultDigest === taskGraphResultDigest(depResult) && binding.evidenceDigest === depReport.evidenceDigest
      && binding.nodeDigest === digest(depNode) && binding.reportDigest === digest(depReport)
  })
}

function receiptCandidates(scope: TaskGraphToolVerificationScope, read: ObjectiveTaskToolReceiptSet,
  index: ReturnType<typeof createTaskGraphObservedReadEvidenceIndex>): Candidate[] | undefined {
  const results = new Map<string, Row>(), replayByCall = new Map(read.replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const))
  for (const item of read.items) if (item.type === "tool_result") { const content = record(item.content); if (content?.toolCallId) results.set(String(content.toolCallId), item) }
  const output: Candidate[] = []
  for (const call of read.items) {
    const content = record(call.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined
    const result = callId ? results.get(callId) : undefined
    if (call.type !== "tool_call" || !content || !callId || !RECEIPT_TOOLS.has(String(content.toolName)) || read.outcomes.get(callId) !== "completed") continue
    const resultContent = record(result?.content), replay = callId ? replayByCall.get(callId) : undefined
    if (!result || !resultContent || !callId || resultContent.toolCallId !== callId || result.status !== "completed" || call.status !== "completed"
      || content.errorCode !== null || resultContent.errorCode !== null || !Object.hasOwn(resultContent, "output") || !isTaskGraphEvidenceToolName(content.toolName)) return undefined
    if (content.toolName === "tool_results.read" && !durableReadBelongs(read, index, call, result, content, resultContent)) continue
    output.push({ call, result, toolName: content.toolName, toolVersion: content.toolVersion, ...(replay ? { replay } : {}) })
  }
  return output.sort((left, right) => read.items.indexOf(left.call) - read.items.indexOf(right.call) || Number(left.call.attempt) - Number(right.call.attempt) || Number(left.call.ordinal) - Number(right.call.ordinal)
    || String(left.call.id).localeCompare(String(right.call.id)))
}

function receiptKey(context: ObjectiveJourneyProofContext, resolved: ObjectiveSourceToolScope, candidate: Candidate): string {
  const replay = candidate.replay ? { currentCallId: candidate.replay.currentCallId, sourceCallItem: candidate.replay.sourceCallItem,
    sourceResultItem: candidate.replay.sourceResultItem } : null
  const raw = canonicalTaskGraphReceiptJson({ finalItemId: context.finalItemId, graphRevision: context.graphRevision,
    sourceKey: resolved.sourceKey, scope: resolved.scope, toolName: candidate.toolName, toolVersion: candidate.toolVersion,
    call: [candidate.call.id, candidate.call.revision, candidate.call.attempt, candidate.call.ordinal],
    result: [candidate.result.id, candidate.result.revision, candidate.result.attempt, candidate.result.ordinal], replay })
  return `rcp_${createHash("sha256").update(raw).digest("base64url")}`
}

function boundEvidence(result: Row, index: ReturnType<typeof createTaskGraphObservedReadEvidenceIndex>): boolean {
  const evidence = dense(result.evidence, 256), seen = new Set<string>()
  return !!evidence && evidence.every(value => { const item = record(value), id = item && text(item.id) ? item.id : undefined,
    ref = item && text(item.ref) ? item.ref : undefined, source = item && text(item.source) ? item.source : undefined
    if (!item || !exact(item, ["id", "kind", "ref", "source"]) || !id || !ref || !source || seen.has(id)) return false
    const observed = index.entries.get(`${item.kind}\u0000${ref}`); if (!observed || observed.id !== id || observed.source !== source) return false
    seen.add(id); return true })
}

function sameScope(scope: TaskGraphToolVerificationScope, read: ObjectiveTaskToolReceiptSet, task: Row): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId].every(value => text(value))
    && scope.rootTaskId === scope.parentTaskId && scope.attemptCount === task.attemptCount
    && read.items.every(item => item.sessionId === scope.sessionId && item.turnId === scope.turnId && item.taskId === scope.taskId
      && item.rootTaskId === scope.rootTaskId && item.turnRootTaskId === scope.rootTaskId && Number(item.attempt) === scope.attemptCount)
}
function sameResolved(left: ObjectiveSourceToolScope, right: ObjectiveSourceToolScope): boolean {
  return left.sourceKey === right.sourceKey && left.group === right.group && left.role === right.role
    && JSON.stringify(left.scope) === JSON.stringify(right.scope) && digest(left.source) === digest(right.source)
    && digest(left.node) === digest(right.node) && digest(left.task) === digest(right.task)
}
function validReceiptSet(scope: TaskGraphToolVerificationScope, read: ObjectiveTaskToolReceiptSet): boolean {
  let checked: Row[]
  try { checked = validateTaskGraphVerificationItems(read.items, scope) } catch { return false }
  try {
    if (canonicalTaskGraphReceiptJson(canonicalTaskGraphReadObservations(checked, read.outcomes))
      !== canonicalTaskGraphReceiptJson(read.evidenceObservations)) return false
  } catch { return false }
  const calls = new Map(checked.filter(item => item.type === "tool_call").map(item => [String(record(item.content)?.toolCallId), item] as const))
  for (const [callId, status] of read.outcomes) {
    if (!calls.has(callId) || (status !== "completed" && status !== "failed")) return false
  }
  if (calls.size !== read.outcomes.size) return false
  const replayIds = new Set<string>()
  for (const replay of read.replayReceipts) {
    if (!text(replay.currentCallId) || !replay.currentCallId.startsWith(TASK_GRAPH_REPLAY_CALL_PREFIX) || replayIds.has(replay.currentCallId)
      || !calls.has(replay.currentCallId) || !Array.isArray(replay.sourceCallItem) || replay.sourceCallItem.length !== 2
      || !Array.isArray(replay.sourceResultItem) || replay.sourceResultItem.length !== 2 || !text(replay.sourceCallItem[0])
      || !text(replay.sourceResultItem[0]) || !Number.isSafeInteger(replay.sourceCallItem[1]) || !Number.isSafeInteger(replay.sourceResultItem[1])) return false
    replayIds.add(replay.currentCallId)
  }
  return true
}
function validVerification(value: unknown, role: Role): boolean {
  const rowValue = record(value), criteria = rowValue && dense(rowValue.criteria, 8)
  return !!rowValue && exact(rowValue, ["criteria", "role", "schemaVersion"]) && rowValue.role === role
    && (rowValue.schemaVersion === "agent-harness.v2.task-graph-verification.v1" || rowValue.schemaVersion === "agent-harness.v2.task-graph-verification.v2")
    && !!criteria && criteria.length > 0 && criteria.every(item => { const criterion = record(item); return !!criterion && exact(criterion, ["check", "id"]) && text(criterion.id) })
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphReceiptJson(value)).digest("hex") }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function record(value: unknown): Row | undefined { const parsed = parseJson(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined; try { return Object.getPrototypeOf(parsed) === Object.prototype || Object.getPrototypeOf(parsed) === null ? parsed as Row : undefined } catch { return undefined } }
function dense(value: unknown, max: number): unknown[] | undefined { return Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 ? [...value] : undefined }
function exact(row: Row, keys: readonly string[]): boolean { return Reflect.ownKeys(row).length === keys.length && Object.keys(row).sort().join(",") === [...keys].sort().join(",") }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function row(value: unknown): Row | undefined { return record(value) }

function durableReadBelongs(read: ObjectiveTaskToolReceiptSet, index: ReturnType<typeof createTaskGraphObservedReadEvidenceIndex>,
  call: Row, result: Row, content: Row, resultContent: Row): boolean {
  const inputRef = record(content.input)?.referenceId, outputRef = record(resultContent.output)?.ref
  if (typeof inputRef !== "string" || inputRef !== outputRef || call.id === result.id) return false
  const assembly = index.durableDiscoveries.get(inputRef), jobRefs = index.durableDiscoveryJobRefs.get(inputRef)
  if (!assembly || assembly.invalid || !assembly.complete || !jobRefs || jobRefs.length === 0) return false
  const readPosition = read.items.indexOf(call)
  if (readPosition < 0) return false
  return read.items.slice(0, readPosition).some(item => {
    if (item.type !== "tool_call" || read.outcomes.get(String(record(item.content)?.toolCallId)) !== "completed") return false
    const discover = record(item.content), discoverId = discover?.toolCallId
    if (discover?.toolName !== "jobs.discover" || typeof discoverId !== "string") return false
    const pair = read.items.find(candidate => candidate.type === "tool_result" && record(candidate.content)?.toolCallId === discoverId)
    const output = record(record(pair?.content)?.output)
    try { return parseDurableDiscoveryReference(output)?.ref === inputRef } catch { return false }
  })
}
