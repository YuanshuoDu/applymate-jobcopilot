import type pg from "pg"
import { createHash } from "node:crypto"
import { evaluateTaskGraphVerification, taskGraphVerificationRole, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationContract, type TaskGraphVerificationEvaluation, type TaskGraphVerificationEvidenceProjection, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult } from "./child-evidence.js"
import { restoreToolCallState } from "../turns/persisted-tool-call-state.js"
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_ITEMS = 1024
const MAX_OBSERVATIONS = 256
const MAX_OBSERVATION_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_ROLE_RESULT_BYTES = 8 * 1024
const EVIDENCE_TOOLS = new Set(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
export const TASK_GRAPH_VERIFIER_VERSION = "agent-harness.v2.task-graph-verifier.v1" as const
export type TaskGraphVerificationScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; taskId: string; attemptCount: number }>
export type TaskGraphPgVerificationResult = Readonly<{ verified: boolean; report: TaskGraphVerificationReport; evaluation: TaskGraphVerificationEvaluation; projection?: TaskGraphVerificationEvidenceProjection; structuredResult?: unknown }>
export type TaskGraphVerificationReport = Readonly<{ verifierVersion: typeof TASK_GRAPH_VERIFIER_VERSION; status: TaskGraphVerificationEvaluation["status"]; reasonCode: TaskGraphVerificationReasonCode; criteria: TaskGraphVerificationEvaluation["criteria"]; evidenceDigest: string | null; resultDigest: string | null }>
/** Load canonical call/result receipts in one caller-owned transaction and evaluate the immutable node contract. */
export async function verifyTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
}>): Promise<TaskGraphPgVerificationResult> {
  let parsedSnapshot: TaskGraphSnapshot
  try { parsedSnapshot = parseTaskGraphSnapshot(input.snapshot) } catch { return unavailable(undefined, "contract_invalid") }
  const storedNode = parsedSnapshot.nodes.find(node => node.taskId === input.scope.taskId)
  if (!storedNode || canonicalTaskGraphJson(storedNode) !== canonicalTaskGraphJson(input.node)) return unavailable(undefined, "contract_invalid")
  const contract = storedNode.verification
  const role = taskGraphVerificationRole(storedNode.templateId)
  if (storedNode.verificationDisposition !== "typed" || !contract || !role || contract.role !== role) return unavailable(contract, "contract_invalid")
  if (!validScope(input.scope)) return unavailable(contract, "canonical_evidence_invalid")
  const taskRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", turn."rootTaskId" AS "turnRootTaskId",
      task."attemptCount", task."status", task."role", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [input.scope.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
  const task = taskRows.rows[0] as Row | undefined
  if (!task || task.status !== "running" || task.role !== role || task.turnRootTaskId !== input.scope.rootTaskId || Number(task.attemptCount) !== input.scope.attemptCount) {
    return unavailable(contract, "canonical_evidence_invalid")
  }
  const itemsResult = await client.query(`SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId",
      item."type", item."status", item."revision", item."content", step."id" AS "joinedStepId", step."status" AS "stepStatus",
      step."attempt" AS "attempt", step."ordinal" AS "ordinal", task."rootTaskId" AS "rootTaskId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId"
      AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
      AND step."attempt" = $7 AND item."type" IN ('tool_call', 'tool_result')
    ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_ITEMS + 1}`,
  [input.scope.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId, input.scope.attemptCount])
  if (itemsResult.rows.length > MAX_ITEMS) return unavailable(contract, "canonical_evidence_invalid")
  let items: Row[], events: Row[]
  try {
    items = validateItems(itemsResult.rows, input.scope)
    const callItems = items.filter(item => item.type === "tool_call"), callItemIds = callItems.map(item => String(item.id))
    const eventResult = callItemIds.length === 0 ? { rows: [] as Row[] } : await client.query(`SELECT event."id", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence"
      FROM "agent_events" AS event
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2
        AND session."userId" = $3 AND turn."userId" = $3
        AND event."itemId" = ANY($4::text[])
        AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed')
      ORDER BY event."sequence" ASC LIMIT ${MAX_ITEMS * 3 + 1}`,
    [input.scope.sessionId, input.scope.turnId, input.scope.userId, callItemIds])
    if (eventResult.rows.length > MAX_ITEMS * 3) return unavailable(contract, "canonical_evidence_invalid")
    const outcomes = validateEvents(eventResult.rows, items, input.scope)
    events = eventResult.rows
    const restored = restoreToolCallState(items, events)
    if (restored.pending.length > 0 || restored.observations.length > MAX_OBSERVATIONS) return unavailable(contract, "canonical_evidence_invalid")
    const encoded = JSON.stringify(restored.observations)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_TOTAL_BYTES) return unavailable(contract, "canonical_evidence_invalid")
    const evidenceObservations = canonicalReadObservations(items, outcomes)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, evidenceObservations)
    if (index.conflicts.size > 0) return unavailable(contract, "canonical_evidence_ambiguous")
    if (index.entries.size === 0) return unavailable(contract, "canonical_evidence_missing")
    let raw: string | undefined
    try { raw = JSON.stringify(input.structuredResult) } catch { return unavailable(contract, "result_invalid") }
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ROLE_RESULT_BYTES) return unavailable(contract, "result_invalid")
    const bound = parseAndBindStructuredResult(raw, role, index)
    if (!bound || bound.status !== "completed") return unavailable(contract, "result_invalid")
    const projection: TaskGraphVerificationEvidenceProjection = role === "scout"
      ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, candidates: bound.role === "scout" ? bound.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
      : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, findings: bound.role === "analyst" ? bound.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
    const evaluation = evaluateTaskGraphVerification(contract, projection)
    const resultDigest = taskGraphResultDigest(bound)
    const digest = evidenceDigest(items, outcomes, projection.evidenceIds, resultDigest)
    return { verified: evaluation.status === "passed", report: report(evaluation, digest, resultDigest), evaluation, projection, structuredResult: bound }
  } catch (error) {
    const reason = error instanceof Error && /ambiguous|duplicate|conflict|replay_uncertain/.test(error.message)
      ? "canonical_evidence_ambiguous" : "canonical_evidence_invalid"
    return unavailable(contract, reason)
  }
}
function validScope(scope: TaskGraphVerificationScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId].every(value => typeof value === "string" && value.trim() === value && value.length > 0)
    && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
}
function validateItems(values: readonly unknown[], scope: TaskGraphVerificationScope): Row[] {
  const parsed = values.map(record)
  if (parsed.some(item => !item)) throw new Error("task_graph_verification_item_invalid")
  const items = parsed as Row[], calls = new Map<string, Row>(), results = new Map<string, Row>(), ids = new Set<string>()
  for (const item of items) {
    if (!text(item.id) || ids.has(item.id) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.taskId
      || item.rootTaskId !== scope.rootTaskId || item.turnRootTaskId !== scope.rootTaskId || item.joinedStepId !== item.stepId || !text(item.stepId)
      || Number(item.attempt) !== scope.attemptCount || !Number.isSafeInteger(Number(item.ordinal)) || Number(item.ordinal) < 0
      || !Number.isSafeInteger(Number(item.revision)) || Number(item.revision) < 0 || item.status !== "completed"
      || !["queued", "streaming", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(String(item.stepStatus))) throw new Error("task_graph_verification_item_invalid")
    ids.add(item.id)
    const content = record(item.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined, target = item.type === "tool_call" ? calls : item.type === "tool_result" ? results : undefined
    if (!content || !callId) throw new Error("task_graph_verification_item_invalid")
    if (!target || target.has(callId)) throw new Error("task_graph_verification_item_duplicate")
    target.set(callId, { ...item, content })
  }
  if (calls.size === 0 || calls.size !== results.size) throw new Error("task_graph_verification_pair_invalid")
  for (const [callId, call] of calls) {
    const result = results.get(callId), callContent = call.content as Row, resultContent = result?.content as Row | undefined
    if (!result || result.stepId !== call.stepId || Number(result.attempt) !== Number(call.attempt) || Number(result.ordinal) !== Number(call.ordinal)
      || !text(callContent.toolName) || !text(callContent.toolVersion) || !Object.hasOwn(callContent, "input") || !resultContent || !Object.hasOwn(resultContent, "output") || result.status !== "completed"
      || (callContent.status !== "completed" && callContent.status !== "failed")
      || callContent.errorCode !== resultContent.errorCode
      || (callContent.status === "completed" ? callContent.errorCode !== null : !text(callContent.errorCode))) throw new Error("task_graph_verification_pair_invalid")
  }
  return items
}
function validateEvents(values: readonly unknown[], items: readonly Row[], scope: TaskGraphVerificationScope): Map<string, "completed" | "failed"> {
  const calls = new Map(items.filter(item => item.type === "tool_call").map(item => [String((item.content as Row).toolCallId), item] as const)), byItem = new Map([...calls.values()].map(item => [String(item.id), String((item.content as Row).toolCallId)] as const))
  const grouped = new Map<string, Row[]>()
  for (const value of values) {
    const event = record(value), payload = record(event?.payload)
    const byCorrelation = event && calls.has(String(event.correlationId)) ? String(event.correlationId) : undefined, callId = event ? byItem.get(String(event.itemId)) ?? byCorrelation ?? String(payload?.toolCallId) : undefined
    const call = callId ? calls.get(callId) : undefined
    if (!event || !payload || !call || event.taskId !== scope.taskId || event.itemId !== call.id || event.correlationId !== (call.content as Row).toolCallId
      || !["tool_call.started", "tool_call.completed", "tool_call.failed"].includes(String(event.type)) || payload.taskId !== scope.taskId || payload.toolCallId !== (call.content as Row).toolCallId
      || payload.toolName !== (call.content as Row).toolName || !Number.isSafeInteger(Number(event.sequence))) throw new Error("task_graph_verification_event_invalid")
    const list = grouped.get(callId!) ?? []; list.push(event); grouped.set(callId!, list)
  }
  const outcomes = new Map<string, "completed" | "failed">()
  for (const [callId, call] of calls) {
    const list = grouped.get(callId) ?? [], started = list.filter(event => event.type === "tool_call.started"), terminal = list.filter(event => event.type !== "tool_call.started")
    const payload = record(terminal[0]?.payload), content = call.content as Row
    const outcome = content.status
    if (started.length !== 1 || terminal.length !== 1 || !payload || Number(started[0]?.sequence) >= Number(terminal[0]?.sequence) || payload.toolVersion !== undefined && payload.toolVersion !== content.toolVersion
      || payload.errorCode !== content.errorCode
      || (outcome === "completed" ? terminal[0]?.type !== "tool_call.completed" || payload.status !== "completed" || payload.errorCode !== null
        : terminal[0]?.type !== "tool_call.failed" || payload.status !== "failed" || !text(payload.errorCode))) throw new Error("task_graph_verification_event_ambiguous")
    outcomes.set(callId, payload.status as "completed" | "failed")
  }
  return outcomes
}
function canonicalReadObservations(items: readonly Row[], outcomes: ReadonlyMap<string, "completed" | "failed">): Array<{ id: string; content: Row }> {
  const results = new Map(items.filter(item => item.type === "tool_result").map(item => [String((item.content as Row).toolCallId), item] as const)), observations: Array<{ id: string; content: Row }> = []
  let totalBytes = 0
  for (const call of items.filter(item => item.type === "tool_call")) {
    const content = call.content as Row, callId = String(content.toolCallId), toolName = String(content.toolName)
    if (outcomes.get(callId) !== "completed" || !EVIDENCE_TOOLS.has(toolName)) continue
    const output = (results.get(callId)?.content as Row).output, encoded = JSON.stringify(output)
    if (encoded === undefined) throw new Error("task_graph_verification_output_invalid")
    totalBytes += Buffer.byteLength(encoded, "utf8")
    if (encoded === undefined || totalBytes > MAX_TOTAL_BYTES || Buffer.byteLength(encoded, "utf8") > MAX_OBSERVATION_BYTES || truncated(output)) throw new Error("task_graph_verification_output_invalid")
    const source = (value: Row, fallback: string) => value.source === undefined || value.source === null ? fallback : text(value.source) && value.source.length <= 256 ? value.source : undefined
    const row = record(output)
    let projected: unknown
    if (toolName === "jobs.search" && row && denseRecords(row.jobs, "id")) {
      const jobs = (row.jobs as Row[]).map(job => ({ id: job.id, source: source(job, "jobs.read") })); if (jobs.some(job => !job.source)) throw new Error("task_graph_verification_output_invalid"); projected = { jobs }
    } else if (toolName === "jobs.get" && row && record(row.job) && text((row.job as Row).id)) {
      const job = row.job as Row, canonicalSource = source(job, "jobs.read"); if (!canonicalSource) throw new Error("task_graph_verification_output_invalid"); projected = { job: { id: job.id, source: canonicalSource } }
    } else if (toolName === "persona.retrieve" && row && denseRecords(row.facts, "id")) {
      const facts = (row.facts as Row[]).map(fact => ({ id: fact.id, source: source(fact, "persona.retrieve") })); if (facts.some(fact => !fact.source)) throw new Error("task_graph_verification_output_invalid"); projected = { facts }
    } else if (toolName === "resume.get_base" && row && record(row.resume) && text((row.resume as Row).id)) projected = { resume: { id: (row.resume as Row).id } }
    else throw new Error("task_graph_verification_output_invalid")
    observations.push({ id: `tool-result:${callId}`, content: { toolCallId: callId, toolName, input: {}, status: "completed", output: projected, errorCode: null } })
  }
  return observations
}
function evidenceDigest(items: readonly Row[], outcomes: ReadonlyMap<string, "completed" | "failed">, evidenceIds: readonly string[], resultDigest: string): string {
  const byCall = new Map(items.filter(item => item.type === "tool_result").map(item => [String((item.content as Row).toolCallId), item] as const))
  const receipts = items.filter(item => item.type === "tool_call" && EVIDENCE_TOOLS.has(String((item.content as Row).toolName))
    && outcomes.get(String((item.content as Row).toolCallId)) === "completed").map(call => {
      const content = call.content as Row, result = byCall.get(String(content.toolCallId))!, output = JSON.stringify((result.content as Row).output)
      return { attempt: Number(call.attempt), callId: content.toolCallId, toolName: content.toolName, toolVersion: content.toolVersion,
        callItem: [call.id, Number(call.revision)], resultItem: [result.id, Number(result.revision)], outputHash: createHash("sha256").update(output).digest("hex") }
    }).sort((a, b) => a.attempt - b.attempt || String(a.callId).localeCompare(String(b.callId)))
  return createHash("sha256").update(JSON.stringify({ evidenceIds: [...evidenceIds].sort(), receipts, resultDigest })).digest("hex")
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value); if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("task_graph_verification_result_invalid")
  return encoded
}
export function taskGraphResultDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function denseRecords(value: unknown, key: string): boolean {
  if (!Array.isArray(value) || value.length > 50 || Reflect.ownKeys(value).length !== value.length + 1) return false
  const ids = new Set<string>()
  for (const item of value) { const row = record(item), id = row && text(row[key]) ? row[key] : undefined; if (!row || !id || ids.has(id)) return false; ids.add(id) }
  return true
}
function truncated(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 32 || value === "[TRUNCATED]" || typeof value === "string" && value.includes("...[TRUNCATED]")) return true
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  try { if (!Array.isArray(value) && (value as Row).truncated === true && typeof (value as Row).preview === "string" && Number.isSafeInteger((value as Row).byteLength)) return true
    return (Array.isArray(value) ? value : Object.values(value)).some(child => truncated(child, seen, depth + 1))
  } finally { seen.delete(value) }
}
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function unavailable(contract: TaskGraphVerificationContract | undefined, reasonCode: TaskGraphVerificationReasonCode): TaskGraphPgVerificationResult {
  const evaluation: TaskGraphVerificationEvaluation = { status: "unverified", reasonCode, criteria: contract?.criteria.map(item => ({ criterionId: item.id, status: "unverified" as const, reasonCode })) ?? [] }
  return { verified: false, report: report(evaluation, null, null), evaluation }
}
function report(evaluation: TaskGraphVerificationEvaluation, evidenceDigest: string | null, resultDigest: string | null): TaskGraphVerificationReport {
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: evaluation.status, reasonCode: evaluation.reasonCode, criteria: evaluation.criteria, evidenceDigest, resultDigest }
}
