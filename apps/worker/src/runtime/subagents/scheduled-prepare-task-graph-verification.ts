import { createHash } from "node:crypto"
import type pg from "pg"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { buildScheduledPipelineGraphAttestation } from "./scheduled-pipeline-current-attestation.js"
import { projectScheduledPipelineGraph } from "./scheduled-pipeline-graph-shape.js"
import { scheduledPrepareAnalyzeSnapshot } from "./scheduled-prepare-runtime-context.js"
import type { ScheduledAutomationPersistedRoot, ScheduledAutomationPersistedTurn } from "./scheduled-automation-pipeline-bridge.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { readScheduledPrepareCheckpoint, type ScheduledPrepareCheckpointStage } from "./scheduled-prepare-checkpoint.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledSnapshotMatches, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT,
  scheduledTaskGraphContinuationKeyVersion, scheduledTaskGraphStableContinuationKey, type ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { validateRoleResult, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES as TEMPLATES } from "./task-graph-templates.js"
import { verifyScheduledPrepareToolResultReference, type ScheduledPrepareToolResultVerificationMode } from "./scheduled-prepare-tool-result-verification.js"
export const SCHEDULED_PREPARE_COMPLETION_SCHEMA = "agent-harness.v2.scheduled-taskgraph-prepare-completion.v1" as const; export const SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA = "agent-harness.v2.scheduled-taskgraph-prepare-proof-facts.v1" as const
type Queryable = Pick<pg.PoolClient, "query">; type Row = Record<string, unknown>
export type ScheduledPrepareVerificationScope = TaskGraphVerificationScope
export type ScheduledPrepareCompletionNode = Readonly<{ taskId: string; attemptCount: number; role: "scout" | "analyst" | "prepare"; taskType: string; status: "completed"; verification: "passed"; dependsOnTaskIds: readonly string[]; tool?: "scheduled.application.prepare@1"; resultDigest?: string }>
export type ScheduledPrepareCompletionFacts = Readonly<{ schemaVersion: typeof SCHEDULED_PREPARE_COMPLETION_SCHEMA; graphRevision: number; nodes: readonly ScheduledPrepareCompletionNode[] }>
export type ScheduledPrepareTaskGraphProofFacts = Readonly<{ schemaVersion: typeof SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA; receipt: ScheduledTaskGraphContinuationReceipt; completion: ScheduledPrepareCompletionFacts; result: PrepareResult }>
export type ScheduledPrepareDependencyWait = Readonly<{ waitId: string; status: "ready"; mode: "all"; targetTaskIds: readonly [string]; matchedTaskIds: readonly [string] }>
export type ScheduledPrepareTaskGraphProof = Readonly<{ receipt: ScheduledTaskGraphContinuationReceipt; completion: ScheduledPrepareCompletionFacts & Readonly<{ wait: ScheduledPrepareDependencyWait }>; result: PrepareResult }>
export type ScheduledPrepareVerification = Readonly<{ verified: true; facts: ScheduledPrepareTaskGraphProofFacts }> | Readonly<{ verified: false; reasonCode: string }>
/** Verifies Prepare against its exact registered call, Analyze lineage, checkpoint, and immutable material rows. */
export async function verifyScheduledPrepareTaskGraphEvidence(client: Queryable, input: Readonly<{ scope: ScheduledPrepareVerificationScope; snapshot: TaskGraphSnapshot; current: TaskGraphCurrentState; tasks: ReadonlyMap<string, GraphTaskRow>; structuredResult: unknown; completionGraphRevision: number; referenceVerificationMode: ScheduledPrepareToolResultVerificationMode; checkpointStage?: ScheduledPrepareCheckpointStage }>): Promise<ScheduledPrepareVerification> {
  try { const scope = input.scope, result = validateRoleResult(input.structuredResult, "prepare")
    if (result.status !== "completed" || result.taskId !== scope.taskId || result.attemptCount !== scope.attemptCount)
      return rejected("scheduled_prepare_result_invalid")
    const snapshot = parseTaskGraphSnapshot(input.snapshot)
    const nodes = snapshot.nodes, current = input.current
    if (current.nodes.length !== nodes.length || !Number.isSafeInteger(current.revision)
      || input.completionGraphRevision !== current.revision || input.completionGraphRevision <= 0) return rejected("scheduled_prepare_graph_invalid")
    let scoutCount = 0
    while (scoutCount < nodes.length && nodes[scoutCount]?.templateId === "scout") scoutCount++
    const graphVersion = scoutCount === 1 ? "v1" : scoutCount >= 2 && scoutCount <= 4 ? "v2" : null
    const shape = graphVersion && projectScheduledPipelineGraph(nodes, graphVersion, "prepare")
    const prepare = shape?.prepare, prepareTask = prepare && input.tasks.get(prepare.taskId)
    if (!shape || !prepare || !prepareTask || prepare.taskId !== scope.taskId
      || !prepareGraphMatches(snapshot, current, scope, prepareTask, input.completionGraphRevision, prepare)) return rejected("scheduled_prepare_graph_invalid")
    const receipt = await readPrivateReceipt(client, scope)
    const root = receipt && await receiptOwnerMatchesCurrentRoot(client, scope, receipt)
    if (!receipt || !root) return rejected("scheduled_prepare_receipt_invalid")
    const version = scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
    if (!version || version !== graphVersion) return rejected("scheduled_prepare_receipt_invalid")
    const turnRows = await client.query(`SELECT "userId", "sessionId", "id" AS "turnId", "rootTaskId", "source", "executionMode", "input",
        "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4`, [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
    const turn = turnRows.rows[0] as ScheduledAutomationPersistedTurn | undefined
    if (turnRows.rows.length !== 1 || !turn || !scheduledSnapshotMatches(turn, receipt.snapshotDigest)) return rejected("scheduled_prepare_receipt_invalid")
    const automation = parseScheduledAutomationSnapshot(record(turn.input)?.scheduledAutomationSnapshot)
    const handoffKey = await verifyAnalyzePrefix(client, scope, snapshot, current, input.tasks, receipt, automation)
    if (!handoffKey) return rejected("scheduled_prepare_analyze_invalid")
    const checkpoint = automation ? await readScheduledPrepareCheckpoint(client, receipt, automation, handoffKey, input.checkpointStage ?? "prepare") : null
    if (!checkpoint || checkpoint.checkpointDigest !== receipt.checkpointDigest) return rejected("scheduled_prepare_checkpoint_invalid")
    const expectedIds = checkpoint.eligibleJobIds
    if (!sameIds(result.jobs.map(job => job.jobId), expectedIds) || result.snapshotDigest !== receipt.snapshotDigest
      || result.checkpointDigest !== receipt.checkpointDigest || !resultMatchesMaterials(result)) return rejected("scheduled_prepare_result_invalid")
    const verifiedResult = await verifyPrepareToolReceipt(client, scope, input.referenceVerificationMode, input.structuredResult, result)
    if (!verifiedResult || !await verifyMaterialRows(client, scope, verifiedResult)) return rejected("scheduled_prepare_artifact_invalid")
    const completion: ScheduledPrepareCompletionFacts = { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA,
      graphRevision: input.completionGraphRevision, nodes: [
        ...shape.scouts.map(node => completionNode(input.tasks.get(node.taskId)!, node, [])),
        completionNode(input.tasks.get(shape.analyst.taskId)!, shape.analyst, shape.scouts.map(node => input.tasks.get(node.taskId)!.id).sort()),
        { ...completionNode(prepareTask, prepare, [input.tasks.get(shape.analyst.taskId)!.id]), tool: "scheduled.application.prepare@1",
          resultDigest: scheduledPrepareResultDigest(verifiedResult) },
      ] }
    return { verified: true, facts: { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt, completion, result: verifiedResult } }
  } catch { return rejected("scheduled_prepare_evidence_invalid") }
}
/** Adds the ready TaskGraph dependency wait after the parent has observed its durable wait. */
export function buildScheduledPrepareTaskGraphProof(factsValue: unknown, waitValue: unknown): ScheduledPrepareTaskGraphProof | null {
  const facts = record(factsValue), receipt = parseScheduledTaskGraphContinuationReceipt(facts?.receipt), completion = record(facts?.completion)
  const resultValue = facts?.result
  if (!facts || !exact(facts, ["schemaVersion", "receipt", "completion", "result"]) || facts.schemaVersion !== SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA || !receipt || !completion
    || receipt.continuationKey !== scheduledTaskGraphStableContinuationKey(receipt)) return null
  const version = scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
  const sources = Array.isArray(completion.nodes) ? completion.nodes.slice(0, -2).map(parseCompletionNode) : []
  const analyst = Array.isArray(completion.nodes) ? parseCompletionNode(completion.nodes.at(-2)) : null
  const prepare = Array.isArray(completion.nodes) ? parseCompletionNode(completion.nodes.at(-1)) : null
  if (!exact(completion, ["schemaVersion", "graphRevision", "nodes"]) || completion.schemaVersion !== SCHEDULED_PREPARE_COMPLETION_SCHEMA
    || !positive(completion.graphRevision) || completion.graphRevision <= receipt.prepareScheduleRevision || !version
    || !Array.isArray(completion.nodes) || version === "v1" && completion.nodes.length !== 3
    || version === "v2" && (completion.nodes.length < 4 || completion.nodes.length > 6)) return null
  let result: PrepareResult
  try { result = validateRoleResult(resultValue, "prepare") } catch { return null }
  const parsedSources = sources.filter((node): node is ScheduledPrepareCompletionNode => Boolean(node))
  const ids = parsedSources.map(node => node.taskId), wait = prepare ? parseDependencyWait(waitValue, prepare.taskId) : null
  const expectedSourceCount = version === "v1" ? 1 : parsedSources.length
  if (!analyst || !prepare || !wait || parsedSources.length !== sources.length || parsedSources.length !== expectedSourceCount
    || expectedSourceCount < 1 || expectedSourceCount > 4
    || version === "v2" && expectedSourceCount < 2 || parsedSources.some(node => node.role !== "scout" || node.taskType !== TEMPLATES.scout.taskType
      || node.status !== "completed" || node.verification !== "passed" || node.dependsOnTaskIds.length !== 0)
    || analyst.role !== "analyst" || analyst.taskType !== TEMPLATES.analyst.taskType || analyst.status !== "completed"
    || analyst.verification !== "passed" || !same(ids.slice().sort(), analyst.dependsOnTaskIds)
    || prepare.role !== "prepare" || prepare.taskType !== TEMPLATES.prepare.taskType || prepare.dependsOnTaskIds.length !== 1
    || prepare.dependsOnTaskIds[0] !== analyst.taskId || new Set([...ids, analyst.taskId, prepare.taskId]).size !== ids.length + 2
    || result.status !== "completed" || result.taskId !== prepare.taskId || result.snapshotDigest !== receipt.snapshotDigest
    || result.checkpointDigest !== receipt.checkpointDigest || result.attemptCount !== prepare.attemptCount
    || prepare.resultDigest !== scheduledPrepareResultDigest(result)) return null
  return { receipt, completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: completion.graphRevision as number,
    nodes: [...parsedSources, analyst, prepare], wait }, result }
}
export function scheduledPrepareResultDigest(value: PrepareResult): string {
  return createHash("sha256").update(canonicalTaskGraphJson({ schemaVersion: value.schemaVersion, role: value.role, status: value.status, taskId: value.taskId,
    attemptCount: value.attemptCount, snapshotDigest: value.snapshotDigest, checkpointDigest: value.checkpointDigest, jobs: value.jobs, materials: value.materials }), "utf8").digest("hex")
}
async function verifyAnalyzePrefix(client: Queryable, scope: ScheduledPrepareVerificationScope, snapshot: TaskGraphSnapshot,
  current: TaskGraphCurrentState, tasks: ReadonlyMap<string, GraphTaskRow>, receipt: ScheduledTaskGraphContinuationReceipt,
  schedule: unknown): Promise<string | null> {
  const version = scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
  const shape = version && projectScheduledPipelineGraph(snapshot.nodes, version, "prepare")
  if (!version || !shape || receipt.continuationKey !== scheduledTaskGraphStableContinuationKey(receipt)
    || receipt.prepareScheduleRevision !== receipt.analyzeGraphRevision + 1 || receipt.prepareScheduleRevision > current.revision) return null
  const prefix = scheduledPrepareAnalyzeSnapshot(snapshot)
  const analyzeCurrent = { revision: receipt.analyzeGraphRevision, nodes: current.nodes.slice(0, prefix.nodes.length),
    ...(current.rootSuccessCriteria ? { rootSuccessCriteria: current.rootSuccessCriteria } : {}) }
  const owner = { userId: receipt.owner.userId, sessionId: receipt.owner.sessionId, turnId: receipt.owner.turnId,
    rootTaskId: receipt.owner.rootTaskId, rootAttemptCount: receipt.owner.rootAttemptCount,
    turnLeaseOwnerId: receipt.owner.turnLeaseOwnerId, turnLeaseVersion: receipt.owner.turnLeaseVersion }
  const proof = await buildScheduledPipelineGraphAttestation({ scope: owner, schedule, snapshot: prefix,
    current: analyzeCurrent, tasks, verifyCompletedNode: input => verifyCompletedTaskGraphNodeEvidence(client, input) })
  if (proof.status !== "ready" || ("scouts" in proof.attestation ? "v2" : "v1") !== version
    || proof.attestation.evidenceDigest !== receipt.evidenceDigest || proof.attestation.snapshotDigest !== receipt.snapshotDigest
    || proof.attestation.graphRevision !== receipt.analyzeGraphRevision) return null
  return scheduledTaskGraphContinuationKey(owner, proof.attestation, receipt.owner.executionId, receipt.owner.executionAttemptCount)
}
async function readPrivateReceipt(client: Queryable, scope: ScheduledPrepareVerificationScope): Promise<ScheduledTaskGraphContinuationReceipt | null> {
  const rows = await client.query(`SELECT event."type", event."itemId", event."taskId", event."actor", event."payload", event."idempotencyKey",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id" OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
      AND event."type" = $4`, [scope.sessionId, scope.turnId, scope.userId, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT])
  if (rows.rows.length !== 1) return null
  const row = record(rows.rows[0]), receipt = parseScheduledTaskGraphContinuationReceipt(row?.payload)
  if (!row || row.type !== SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT || row.itemId !== null || row.taskId !== null
    || row.actor !== "system" || row.hasOutbox !== false || typeof row.idempotencyKey !== "string"
    || !row.idempotencyKey.startsWith("scheduled-prepare:") || !receipt || !sameOwnerScope(receipt, scope)) return null
  return receipt
}
async function receiptOwnerMatchesCurrentRoot(client: Queryable, scope: ScheduledPrepareVerificationScope, receipt: ScheduledTaskGraphContinuationReceipt): Promise<ScheduledAutomationPersistedRoot | null> {
  if (!sameOwnerScope(receipt, scope)) return null
  const owner = receipt.owner, rows = await client.query(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."status", task."attemptCount"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL
      AND task."taskType" = 'root' AND turn."rootTaskId" = $1 AND session."userId" = $4 AND turn."userId" = $4`,
  [owner.rootTaskId, scope.sessionId, scope.turnId, scope.userId])
  const row = record(rows.rows[0])
  return rows.rows.length === 1 && row?.id === owner.rootTaskId && row.userId === scope.userId && row.sessionId === scope.sessionId
    && row.turnId === scope.turnId && row.status === "running" && Number(row.attemptCount) === owner.rootAttemptCount
    ? { id: owner.rootTaskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      status: "running", attemptCount: owner.rootAttemptCount } : null
}
async function verifyPrepareToolReceipt(client: Queryable, scope: TaskGraphVerificationScope, mode: ScheduledPrepareToolResultVerificationMode, rawResult: unknown, result: PrepareResult): Promise<PrepareResult | null> {
  const receipts = await loadTaskGraphVerificationReceipts(client, scope)
  if (receipts.items.length !== 2 || receipts.replayReceipts.length !== 0 || receipts.outcomes.size !== 1) return null
  const call = receipts.items.find(item => item.type === "tool_call"), output = receipts.items.find(item => item.type === "tool_result")
  const content = record(call?.content), resultContent = record(output?.content), callId = content?.toolCallId
  if (!call || !output || typeof callId !== "string" || callId.length === 0 || !content || !resultContent
    || content.toolName !== "scheduled.application.prepare" || content.toolVersion !== "1" || !emptyRecord(content.input)
    || content.status !== "completed" || content.errorCode !== null || receipts.outcomes.get(callId) !== "completed"
    || resultContent.errorCode !== null || !Object.hasOwn(resultContent, "output")
    || !same(rawResult, result)) return null
  return verifyPrepareToolResultOutput(client, { scope, mode, stepId: output.stepId, callStepId: call.stepId, toolCallId: callId, output: resultContent.output, rawResult, expectedResult: result })
}
export async function verifyPrepareToolResultOutput(client: Queryable, input: Readonly<{ scope: TaskGraphVerificationScope; mode: ScheduledPrepareToolResultVerificationMode; stepId: unknown; callStepId: unknown; toolCallId: string; output: unknown; rawResult: unknown; expectedResult: PrepareResult }>): Promise<PrepareResult | null> {
  if (!same(input.rawResult, input.expectedResult)) return null; const marker = record(input.output)
  if (marker && Object.hasOwn(marker, "$ref")) return typeof input.stepId === "string" && input.stepId === input.callStepId ? verifyScheduledPrepareToolResultReference(client, { reference: input.output, scope: input.scope, mode: input.mode, stepId: input.stepId, toolCallId: input.toolCallId, expectedResult: input.expectedResult }) : null
  return same(input.output, input.rawResult) ? input.expectedResult : null }
async function verifyMaterialRows(client: Queryable, scope: TaskGraphVerificationScope, result: PrepareResult): Promise<boolean> {
  for (const material of result.materials) {
    const rows = await client.query(`SELECT version_row."artifactId", version_row."version", version_row."userId", version_row."sessionId",
        version_row."jobId", version_row."artifactType", version_row."contentHash", version_row."sourceDigest", version_row."taskId", artifact."lifecycle"
      FROM "agent_artifact_version" AS version_row JOIN "agent_artifact" AS artifact
        ON artifact."id" = version_row."artifactId" AND artifact."userId" = version_row."userId" AND artifact."jobId" = version_row."jobId"
      WHERE version_row."userId" = $1 AND version_row."sessionId" = $2 AND version_row."jobId" = $3
        AND version_row."artifactId" = $4 AND version_row."version" = $5 AND version_row."contentHash" = $6
        AND version_row."sourceDigest" = $7 AND version_row."taskId" = $8 AND artifact."artifactType" = $9`,
    [scope.userId, scope.sessionId, material.jobId, material.artifactRef.artifactId, material.artifactRef.version,
      material.artifactRef.contentHash, material.artifactRef.sourceDigest, scope.taskId, material.kind])
    const row = record(rows.rows[0])
    if (rows.rows.length !== 1 || !row || row.userId !== scope.userId || row.sessionId !== scope.sessionId
      || row.jobId !== material.jobId || row.artifactId !== material.artifactRef.artifactId || Number(row.version) !== material.artifactRef.version
      || row.contentHash !== material.artifactRef.contentHash || row.sourceDigest !== material.artifactRef.sourceDigest
      || row.taskId !== scope.taskId || row.artifactType !== material.kind || row.lifecycle !== "draft") return false
  }
  return true
}
function prepareGraphMatches(snapshot: TaskGraphSnapshot, current: TaskGraphCurrentState, scope: ScheduledPrepareVerificationScope,
  task: GraphTaskRow, completionRevision: number, node: StoredTaskGraphNode): boolean {
  const state = current.nodes.find(value => value.key === node.key)
  return Boolean(node.key === "prepare" && node.templateId === "prepare" && node.depth === 3 && node.verificationDisposition === "specialized"
    && node.dependsOn.length === 1 && node.dependsOn[0] === snapshot.nodes[snapshot.nodes.length - 2]?.key && node.taskId === scope.taskId
     && state?.taskId === scope.taskId && state.templateId === "prepare" && state.status === "completed" && state.failureReason === null
     && task.status === "completed" && task.failureReason === null && task.role === TEMPLATES.prepare.role && task.taskType === TEMPLATES.prepare.taskType
    && same(task.expectedOutputSchema, TEMPLATES.prepare.expectedOutputSchema) && same(task.allowedActions, TEMPLATES.prepare.allowedActions)
    && task.attemptCount === scope.attemptCount && completionRevision > 0)
}
function completionNode(task: GraphTaskRow, node: StoredTaskGraphNode, dependsOnTaskIds: readonly string[]): ScheduledPrepareCompletionNode {
  const role = node.templateId as "scout" | "analyst" | "prepare"
  return { taskId: task.id, attemptCount: task.attemptCount!, role, taskType: task.taskType!, status: "completed", verification: "passed", dependsOnTaskIds }
}
function resultMatchesMaterials(result: PrepareResult): boolean {
  const statuses = new Map(result.jobs.map(job => [job.jobId, job.status])), kinds = new Set<string>()
  for (const material of result.materials) {
    const key = `${material.jobId}\0${material.kind}`
    if (statuses.get(material.jobId) !== "prepared" || kinds.has(key)) return false
    kinds.add(key)
  }
  return result.jobs.filter(job => job.status === "prepared").every(job => kinds.has(`${job.jobId}\0resume`))
    && result.materials.every(material => statuses.get(material.jobId) === "prepared")
}
function parseCompletionNode(value: unknown): ScheduledPrepareCompletionNode | null {
  const row = record(value), prepare = row?.role === "prepare", keys = ["attemptCount", "dependsOnTaskIds", "role", "status", "taskId", "taskType", "verification", ...(prepare ? ["tool", "resultDigest"] : [])]
  if (!row || !exact(row, keys) || !validId(row.taskId) || !positive(row.attemptCount) || !["scout", "analyst", "prepare"].includes(String(row.role))
    || typeof row.taskType !== "string" || row.status !== "completed" || row.verification !== "passed" || !stringArray(row.dependsOnTaskIds)) return null
  if (prepare && (row.tool !== "scheduled.application.prepare@1" || !hex(row.resultDigest)) || !prepare && (row.tool !== undefined || row.resultDigest !== undefined)) return null
  return row as unknown as ScheduledPrepareCompletionNode
}
function parseDependencyWait(value: unknown, taskId: string | undefined): ScheduledPrepareDependencyWait | null {
  const row = record(value)
  if (!row || !exact(row, ["waitId", "status", "mode", "targetTaskIds", "matchedTaskIds"]) || !validId(row.waitId) || row.waitId.length > 128
    || row.status !== "ready" || row.mode !== "all" || !taskId || !same(row.targetTaskIds, [taskId]) || !same(row.matchedTaskIds, [taskId])) return null
  return row as unknown as ScheduledPrepareDependencyWait
}
function sameOwnerScope(receipt: ScheduledTaskGraphContinuationReceipt, scope: ScheduledPrepareVerificationScope): boolean { const owner = receipt.owner; return owner.userId === scope.userId && owner.sessionId === scope.sessionId && owner.turnId === scope.turnId && owner.rootTaskId === scope.rootTaskId }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every(id => right.includes(id)) }
function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  const sorted = [...right].sort()
  return left.length === sorted.length && new Set(left).size === left.length && [...left].sort().every((value, index) => value === sorted[index])
}
function emptyRecord(value: unknown): boolean { const row = record(value); return Boolean(row && !Reflect.ownKeys(row).length) } function exact(value: Row, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)) }
function record(value: unknown): Row | null { const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null } catch { return null } }
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) } function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 } function hex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string") } function rejected(reasonCode: string): ScheduledPrepareVerification { return { verified: false, reasonCode } }
