import type pg from "pg"
import { createHash } from "node:crypto"
import { evaluateTaskGraphVerification, evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery, taskGraphVerificationDependencyNodeKeys, taskGraphVerificationRole, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationContract, type TaskGraphVerificationEvaluation, type TaskGraphVerificationEvidenceProjection, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult } from "./child-evidence.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { taskGraphEvidenceDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { TASK_GRAPH_VERIFIER_VERSION, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { validateRoleResult, type AnalystResult } from "./role-results.js"
import { scheduledAutomationCriteria } from "./scheduled-automation-snapshot.js"
export { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
export type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_ROLE_RESULT_BYTES = 8 * 1024
export type TaskGraphPgVerificationResult = Readonly<{ verified: boolean; report: TaskGraphVerificationReport; evaluation: TaskGraphVerificationEvaluation; projection?: TaskGraphVerificationEvidenceProjection; structuredResult?: unknown }>
/** Load canonical call/result receipts in one caller-owned transaction and evaluate the immutable node contract. */
export async function verifyTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "running")
}
/** Server-only completed-source path; ordinary child verification remains running-only. */
export async function verifyCompletedTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "completed")
}
async function verifyTaskGraphEvidenceForStatus(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
}>, expectedStatus: "running" | "completed"): Promise<TaskGraphPgVerificationResult> {
  let parsedSnapshot: TaskGraphSnapshot
  try { parsedSnapshot = parseTaskGraphSnapshot(input.snapshot) } catch { return unavailable(undefined, "contract_invalid") }
  const storedNode = parsedSnapshot.nodes.find(node => node.taskId === input.scope.taskId)
  if (!storedNode || canonicalTaskGraphJson(storedNode) !== canonicalTaskGraphJson(input.node)) return unavailable(undefined, "contract_invalid")
  const contract = storedNode.verification
  const role = taskGraphVerificationRole(storedNode.templateId)
  if (storedNode.verificationDisposition !== "typed" || !contract || !role || contract.role !== role) return unavailable(contract, "contract_invalid")
  if (!validScope(input.scope)) return unavailable(contract, "canonical_evidence_invalid")
  const taskRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", turn."rootTaskId" AS "turnRootTaskId", task."attemptCount", task."status", task."role", task."result", session."userId" AS "userId", turn."source" AS "turnSource", turn."executionMode" AS "turnExecutionMode", turn."input" AS "turnInput" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [input.scope.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
  const task = taskRows.rows[0] as Row | undefined
  if (!task || task.status !== expectedStatus || task.role !== role || task.turnRootTaskId !== input.scope.rootTaskId || Number(task.attemptCount) !== input.scope.attemptCount) return unavailable(contract, "canonical_evidence_invalid")
  try {
    const emptyAnalyst = expectedStatus === "completed" && role === "analyst" ? persistedEmptyAnalystResult(task.result, input.structuredResult) : undefined
    if (emptyAnalyst) {
      const digest = await verifiedEmptyScoutDependencyDigest(client, input.scope, parsedSnapshot, storedNode, input.dependencies)
      if (!digest) return unavailable(contract, "canonical_evidence_missing")
      if (!await hasNoTaskGraphToolReceipts(client, input.scope)) return unavailable(contract, "canonical_evidence_invalid")
      const projection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst", findings: [], evidenceIds: [], emptyDiscoveryReceipt: { digest } }
      const evaluation = evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery(contract, projection, input.dependencies, digest), resultDigest = taskGraphResultDigest(emptyAnalyst)
      const evidenceDigest = sha256(canonicalJson({ schemaVersion: "agent-harness.v2.task-graph.empty-analyst-receipt.v1", scope: input.scope, scoutDigest: digest, resultDigest, items: [], events: [] }))
      return { verified: evaluation.status === "passed", report: report(evaluation, evidenceDigest, resultDigest), evaluation, projection, structuredResult: emptyAnalyst }
    }
    const receipts = await loadTaskGraphVerificationReceipts(client, input.scope)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, receipts.evidenceObservations)
    if (index.conflicts.size > 0) return unavailable(contract, "canonical_evidence_ambiguous")
    let raw: string | undefined
    try { raw = JSON.stringify(input.structuredResult) } catch { return unavailable(contract, "result_invalid") }
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ROLE_RESULT_BYTES) return unavailable(contract, "result_invalid")
    const bound = parseAndBindStructuredResult(raw, role, index)
    if (!bound || bound.status !== "completed") return unavailable(contract, index.entries.size === 0 ? "canonical_evidence_missing" : "result_invalid")
    let verifiedEmptyDiscoveryDigest: string | undefined
    let projection: TaskGraphVerificationEvidenceProjection
    if (index.entries.size === 0 && role === "scout" && bound.role === "scout" && bound.candidates.length === 0) {
      const persistedScout = persistedEmptyScoutResult(task.result, input.structuredResult)
      if (!persistedScout) return unavailable(contract, "canonical_evidence_missing")
      verifiedEmptyDiscoveryDigest = await completedZeroDiscoveryDigest(client, input.scope, receipts, task)
      if (!verifiedEmptyDiscoveryDigest) return unavailable(contract, "canonical_evidence_missing")
      projection = {
        schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role,
        candidates: [], evidenceIds: [`read:source:jobs.discover:${verifiedEmptyDiscoveryDigest}`],
        emptyDiscoveryReceipt: { digest: verifiedEmptyDiscoveryDigest },
      }
    } else if (index.entries.size === 0 && role === "analyst" && bound.role === "analyst" && bound.findings.length === 0) {
      verifiedEmptyDiscoveryDigest = await verifiedEmptyScoutDependencyDigest(client, input.scope, parsedSnapshot, storedNode, input.dependencies)
      if (!verifiedEmptyDiscoveryDigest) return unavailable(contract, "canonical_evidence_missing")
      projection = {
        schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role,
        findings: [], evidenceIds: [], emptyDiscoveryReceipt: { digest: verifiedEmptyDiscoveryDigest },
      }
    } else {
      if (index.entries.size === 0) return unavailable(contract, "canonical_evidence_missing")
      projection = role === "scout"
        ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, candidates: bound.role === "scout" ? bound.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
        : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, findings: bound.role === "analyst" ? bound.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
    }
    const evaluation = verifiedEmptyDiscoveryDigest
      ? evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery(contract, projection, input.dependencies, verifiedEmptyDiscoveryDigest)
      : evaluateTaskGraphVerification(contract, projection, input.dependencies)
    const resultDigest = taskGraphResultDigest(bound)
    const digestEvidenceIds = verifiedEmptyDiscoveryDigest ? [...projection.evidenceIds, `read:source:jobs.discover:${verifiedEmptyDiscoveryDigest}`] : projection.evidenceIds
    const digest = taskGraphEvidenceDigest(receipts.items, receipts.outcomes, digestEvidenceIds, resultDigest, receipts.replayReceipts)
    return { verified: evaluation.status === "passed", report: report(evaluation, digest, resultDigest), evaluation, projection, structuredResult: bound }
  } catch (error) {
    const reason = error instanceof Error && /ambiguous|duplicate|conflict|replay_uncertain/.test(error.message)
      ? "canonical_evidence_ambiguous" : "canonical_evidence_invalid"
    return unavailable(contract, reason)
  }
}

function persistedEmptyScoutResult(envelopeValue: unknown, resultValue: unknown): unknown | undefined {
  try { const envelope = record(envelopeValue), parsed = validateRoleResult(resultValue, "scout"); return envelope?.status === "completed" && canonicalJson(envelope.structuredResult) === canonicalJson(resultValue) && parsed.status === "completed" && parsed.candidates.length === 0 && parsed.evidence.length === 0 ? parsed : undefined } catch { return undefined }
}
function persistedEmptyAnalystResult(envelopeValue: unknown, resultValue: unknown): AnalystResult | undefined {
  try { const envelope = record(envelopeValue), parsed = validateRoleResult(resultValue, "analyst"); return envelope?.status === "completed" && canonicalJson(envelope.structuredResult) === canonicalJson(resultValue) && parsed.status === "completed" && parsed.findings.length === 0 && parsed.evidence.length === 0 ? parsed as AnalystResult : undefined } catch { return undefined }
}
async function hasNoTaskGraphToolReceipts(client: Queryable, scope: TaskGraphVerificationScope): Promise<boolean> {
  const values = [scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, scope.attemptCount]
  const items = await client.query(`SELECT item."id" FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 AND step."attempt" = $7 AND item."type" IN ('tool_call', 'tool_result') LIMIT 1`, values)
  if (items.rows.length > 0) return false
  const events = await client.query(`SELECT event."id" FROM "agent_events" AS event JOIN "sub_agent_tasks" AS task ON task."id" = event."taskId" AND task."sessionId" = event."sessionId" AND task."turnId" = event."turnId" JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."taskId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed') LIMIT 1`, values.slice(0, 6))
  return events.rows.length === 0
}
type CompletedReceipts = Awaited<ReturnType<typeof loadTaskGraphVerificationReceipts>>
async function completedZeroDiscoveryDigest(
  client: Queryable,
  scope: TaskGraphVerificationScope,
  receipts: CompletedReceipts,
  task: Row,
): Promise<string | undefined> {
  if (receipts.replayReceipts.length > 0) return undefined
  const calls = receipts.items.filter(item => item.type === "tool_call")
  const results = receipts.items.filter(item => item.type === "tool_result")
  if (calls.length < 1 || calls.length > 32 || receipts.items.length !== calls.length * 2
    || results.length !== calls.length || receipts.outcomes.size !== calls.length) return undefined
  const turnInput = record(task.turnInput), criteria = scheduledAutomationCriteria(turnInput)
  if (task.turnSource !== "automation" || task.turnExecutionMode !== "canonical_task_graph" || turnInput?.automationRunMode !== "scheduled" || !criteria) return undefined
  const callIds = new Set<string>(), ordinals = new Set<string>(), resultById = new Map<string, Row>()
  for (const item of results) {
    const content = record(item.content), callId = content && strictText(content.toolCallId) ? content.toolCallId : undefined
    if (!callId || resultById.has(callId)) return undefined
    resultById.set(callId, item)
  }
  const callReceipts: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const content = record(call.content), callId = content && strictText(content.toolCallId) ? content.toolCallId : undefined
    const stepId = strictText(call.stepId) ? call.stepId : undefined
    const result = callId ? resultById.get(callId) : undefined, resultContent = record(result?.content)
    const ordinalKey = `${String(call.stepId)}\u0000${String(call.ordinal)}`
    if (!content || !callId || !stepId || callIds.has(callId) || content.toolName !== "jobs.discover" || content.toolVersion !== "1"
      || content.status !== "completed" || content.errorCode !== null || receipts.outcomes.get(callId) !== "completed"
      || !result || !resultContent || resultContent.errorCode !== null || !Object.hasOwn(resultContent, "output")
      || ordinalKey !== `${String(result.stepId)}\u0000${String(result.ordinal)}` || ordinals.has(ordinalKey)) return undefined
    if (!matchesScheduledDiscoveryInput(content.input, criteria)) return undefined
    const output = record(resultContent.output)
    if (!validEmptyDiscoveryOutput(output, content, stepId, scope)) return undefined
    callIds.add(callId)
    ordinals.add(ordinalKey)
    callReceipts.push({
      callId, stepId: call.stepId, ordinal: Number(call.ordinal),
      callItem: [call.id, Number(call.revision)], resultItem: [result.id, Number(result.revision)],
      inputDigest: sha256(canonicalJson(content.input)), outputDigest: sha256(canonicalJson(resultContent.output)),
    })
  }
  if (callIds.size !== calls.length) return undefined
  const eventRows = await client.query(`SELECT event."id", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence" FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3 AND event."itemId" = ANY($4::text[]) AND event."type" IN ('tool_call.started', 'tool_call.completed') ORDER BY event."sequence" ASC LIMIT 97`,
  [scope.sessionId, scope.turnId, scope.userId, calls.map(call => String(call.id))])
  if (eventRows.rows.length !== calls.length * 2) return undefined
  const eventsByItem = new Map<string, Row[]>(), eventIds = new Set<string>()
  for (const value of eventRows.rows) {
    const event = record(value)
    if (!event || !strictText(event.id) || eventIds.has(event.id) || !strictText(event.itemId)) return undefined
    eventIds.add(event.id)
    const group = eventsByItem.get(event.itemId) ?? []
    group.push(event)
    eventsByItem.set(event.itemId, group)
  }
  const eventReceipts: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const content = record(call.content), callId = content?.toolCallId
    const output = resultById.get(String(callId)) && record(resultById.get(String(callId))?.content)?.output
    const events = eventsByItem.get(String(call.id)) ?? []
    const started = events.find(event => event.type === "tool_call.started"), completed = events.find(event => event.type === "tool_call.completed")
    const startPayload = record(started?.payload), completedPayload = record(completed?.payload)
    if (events.length !== 2 || !started || !completed || !startPayload || !completedPayload
      || started.taskId !== scope.taskId || completed.taskId !== scope.taskId
      || started.correlationId !== callId || completed.correlationId !== callId
      || !Number.isSafeInteger(Number(started.sequence)) || !Number.isSafeInteger(Number(completed.sequence))
      || Number(started.sequence) >= Number(completed.sequence)
      || !eventMatchesTool(startPayload, scope.taskId, String(callId), "jobs.discover", "1")
      || !eventMatchesTool(completedPayload, scope.taskId, String(callId), "jobs.discover", "1")
      || completedPayload.status !== "completed" || completedPayload.errorCode !== null
      || canonicalJson(completedPayload.output) !== canonicalJson(output)) return undefined
    eventReceipts.push(...[started, completed].map(event => ({ id: event.id, type: event.type, sequence: Number(event.sequence), payloadDigest: sha256(canonicalJson(event.payload)) })))
  }
  callReceipts.sort((a, b) => Number(a.ordinal) - Number(b.ordinal) || String(a.callId).localeCompare(String(b.callId)))
  eventReceipts.sort((a, b) => Number(a.sequence) - Number(b.sequence) || String(a.id).localeCompare(String(b.id)))
  return sha256(canonicalJson({
    schemaVersion: "agent-harness.v2.task-graph.empty-discovery-receipt.v1",
    scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, taskId: scope.taskId, attemptCount: scope.attemptCount },
    calls: callReceipts, events: eventReceipts,
  }))
}

function validEmptyDiscoveryOutput(output: Row | undefined, call: Row, stepId: string, scope: TaskGraphVerificationScope): boolean {
  if (!output || !exactRecord(output, "evidence,jobs,nextCursor,usage") || !emptyDenseArray(output.jobs) || !emptyDenseArray(output.evidence) || output.nextCursor !== null) return false
  const usage = exactRecord(output.usage, "aiCalls,durationMs,estimatedCostUsd,jobsFailed,jobsProcessed,jobsSucceeded,ledgerKey,providerFailures,providers,requests,sessionId,stepId,toolCallId,toolName,toolVersion,turnId")
  return Boolean(usage && usage.ledgerKey === [scope.userId, scope.sessionId, scope.turnId, stepId, String(call.toolCallId)].join(":")
    && usage.toolName === "jobs.discover" && usage.toolVersion === "1" && usage.toolCallId === call.toolCallId
    && usage.sessionId === scope.sessionId && usage.turnId === scope.turnId && usage.stepId === stepId
    && nonNegativeInteger(usage.requests) && Number(usage.requests) >= 1 && usage.jobsProcessed === 0 && usage.jobsSucceeded === 0
    && usage.jobsFailed === 0 && usage.providerFailures === 0 && usage.aiCalls === 0 && nonNegativeInteger(usage.durationMs)
    && typeof usage.estimatedCostUsd === "number" && Number.isFinite(usage.estimatedCostUsd) && usage.estimatedCostUsd === 0
    && denseStrings(usage.providers, 32, 80) && usage.providers.length > 0 && new Set(usage.providers).size === usage.providers.length)
}
function matchesScheduledDiscoveryInput(value: unknown, criteria: ReturnType<typeof scheduledAutomationCriteria>): boolean {
  const input = exactRecord(value, "targetLocations,targetRoles"), roles = input?.targetRoles, locations = input?.targetLocations
  return Boolean(criteria && denseStrings(roles, 8, 160) && denseStrings(locations, 8, 160)
    && canonicalJson(roles) === canonicalJson(criteria.targetRoles) && canonicalJson(locations) === canonicalJson(criteria.targetLocations))
}
function eventMatchesTool(payload: Row, taskId: string, callId: string, toolName: string, toolVersion: string): boolean {
  return payload.taskId === taskId && payload.toolCallId === callId && payload.toolName === toolName
    && payload.toolVersion === toolVersion
}
async function verifiedEmptyScoutDependencyDigest(
  client: Queryable,
  scope: TaskGraphVerificationScope,
  snapshot: TaskGraphSnapshot,
  analyst: StoredTaskGraphNode,
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection> | undefined,
): Promise<string | undefined> {
  const keys = analyst.verification ? taskGraphVerificationDependencyNodeKeys(analyst.verification) : []
  if (keys.length !== 1 || !dependencies || dependencies.size !== 1 || !dependencies.has(keys[0]!)) return undefined
  const source = snapshot.nodes.find(node => node.key === keys[0])
  if (!source || !analyst.dependsOn.includes(source.key) || source.templateId !== "scout" || source.verificationDisposition !== "typed"
    || source.verification?.role !== "scout" || !source.taskId) return undefined
  const sourceRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."attemptCount", task."status", task."role", task."failureReason", task."result", session."userId" AS "userId" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND turn."rootTaskId" = $4 AND session."userId" = $6 AND turn."userId" = $6`,
  [source.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const task = record(sourceRows.rows[0]), envelope = record(task?.result)
  if (!task || task.id !== source.taskId || task.sessionId !== scope.sessionId || task.turnId !== scope.turnId
    || task.rootTaskId !== scope.rootTaskId || task.parentTaskId !== scope.parentTaskId || task.userId !== scope.userId
    || task.status !== "completed" || task.failureReason !== null || task.role !== "scout" || !validAttempt(task.attemptCount)
    || !envelope || envelope.status !== "completed" || !Object.hasOwn(envelope, "structuredResult")) return undefined
  const proof = await verifyTaskGraphEvidenceForStatus(client, {
    scope: { ...scope, taskId: source.taskId, attemptCount: Number(task.attemptCount) },
    snapshot, node: source, structuredResult: envelope.structuredResult,
  }, "completed")
  const marker = proof.projection?.emptyDiscoveryReceipt
  if (!proof.verified || proof.report.status !== "passed" || proof.projection?.role !== "scout" || !marker
    || canonicalTaskGraphJson(dependencies.get(source.key)) !== canonicalTaskGraphJson(proof.projection)) return undefined
  return marker.digest
}
function validScope(scope: TaskGraphVerificationScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId].every(value => typeof value === "string" && value.trim() === value && value.length > 0)
    && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value); if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("task_graph_verification_result_invalid")
  return encoded
}
export function taskGraphResultDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}
function unavailable(contract: TaskGraphVerificationContract | undefined, reasonCode: TaskGraphVerificationReasonCode): TaskGraphPgVerificationResult {
  const evaluation: TaskGraphVerificationEvaluation = { status: "unverified", reasonCode, criteria: contract?.criteria.map(item => ({ criterionId: item.id, status: "unverified" as const, reasonCode })) ?? [] }
  return { verified: false, report: report(evaluation, null, null), evaluation }
}
function report(evaluation: TaskGraphVerificationEvaluation, evidenceDigest: string | null, resultDigest: string | null): TaskGraphVerificationReport {
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: evaluation.status, reasonCode: evaluation.reasonCode, criteria: evaluation.criteria, evidenceDigest, resultDigest }
}
function strictText(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 }
function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validAttempt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function exactRecord(value: unknown, keys: string): Row | undefined {
  const parsed = record(value); if (!parsed) return undefined
  try { const ownKeys = Reflect.ownKeys(value as object), descriptors = Object.getOwnPropertyDescriptors(value as object); return ownKeys.some(key => typeof key !== "string") || (ownKeys as string[]).sort().join(",") !== keys || ownKeys.some(key => !descriptors[key as string]?.enumerable || !("value" in descriptors[key as string]!)) ? undefined : parsed } catch { return undefined }
}
function emptyDenseArray(value: unknown): boolean {
  try { return Array.isArray(value) && Reflect.ownKeys(value).length === 1 && Object.getOwnPropertyDescriptor(value, "length")?.value === 0 } catch { return false }
}
function denseStrings(value: unknown, maximum: number, maxLength: number): value is string[] {
  try {
    if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1 || value.length > maximum) return false
    for (let i = 0; i < value.length; i++) { const item = Object.getOwnPropertyDescriptor(value, String(i)); if (!item?.enumerable || !("value" in item) || !strictText(item.value) || item.value.length > maxLength) return false }
    return true
  } catch { return false }
}
