import { createHash } from "node:crypto"

type Row = Record<string, unknown>
const VERIFIER = "agent-harness.v2.task-graph-verifier.v1"
const RESULT = "agent-harness.v2.subagent.result"
const DIGEST = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CRITERION = /^[a-z][a-z0-9._-]{0,63}$/

/** Parses only the exact completed typed-source result persisted by the Worker. */
export function parseObjectiveApplicationTypedSourceResult(value: unknown, role: "scout" | "analyst", taskId: string): Row | undefined {
  const envelope = record(typeof value === "string" ? parseJson(value) : value)
  const result = envelope && record(envelope.structuredResult)
  if (!envelope || !result || !resultEnvelope(envelope, role, taskId, result)) return undefined
  return result
}

function resultEnvelope(envelope: Row, role: "scout" | "analyst", taskId: string, result: Row): boolean {
  const required = "finalItemId,finalText,status,stepCount,structuredResult,taskGraphVerificationReport,toolCallCount"
  const optional = ["taskGraphRepairReceipt", ...(role === "scout" ? ["discoveryAttempt"] : [])]
  if (!allowed(envelope, required.split(","), optional) || envelope.status !== "completed"
    || envelope.finalItemId !== null && (typeof envelope.finalItemId !== "string" || !ID.test(envelope.finalItemId))
    || typeof envelope.finalText !== "string" || !count(envelope.stepCount) || !count(envelope.toolCallCount)
    || result.schemaVersion !== RESULT || result.role !== role || result.status !== "completed"
    || !passedReport(envelope.taskGraphVerificationReport, result)) return false
  const report = record(envelope.taskGraphVerificationReport)
  return (!Object.hasOwn(envelope, "taskGraphRepairReceipt") || repairReceipt(envelope.taskGraphRepairReceipt, taskId, report!))
    && (!Object.hasOwn(envelope, "discoveryAttempt") || role === "scout" && discoveryAttempt(envelope.discoveryAttempt))
}

function passedReport(value: unknown, result: Row): boolean {
  const report = record(value), criteria = report && dense(report.criteria, 8), bindings = report && Object.hasOwn(report, "dependencyBindings")
  if (!report || !exact(report, bindings
    ? "criteria,dependencyBindings,evidenceDigest,reasonCode,resultDigest,status,verifierVersion"
    : "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || report.verifierVersion !== VERIFIER || report.status !== "passed" || report.reasonCode !== "criteria_met"
    || typeof report.evidenceDigest !== "string" || !DIGEST.test(report.evidenceDigest)
    || typeof report.resultDigest !== "string" || report.resultDigest !== workerDigest(result) || !criteria || criteria.length < 1) return false
  const ids = new Set<string>()
  if (!criteria.every(item => {
    const criterion = record(item)
    if (!criterion || !exact(criterion, "criterionId,reasonCode,status") || typeof criterion.criterionId !== "string"
      || !CRITERION.test(criterion.criterionId) || ids.has(criterion.criterionId)
      || criterion.status !== "passed" || criterion.reasonCode !== "criteria_met") return false
    ids.add(criterion.criterionId)
    return true
  })) return false
  return !bindings || dependencyBindings(report.dependencyBindings)
}

function dependencyBindings(value: unknown): boolean {
  const rows = dense(value, 8)
  if (!rows || rows.length < 1) return false
  let previous = ""
  return rows.every(item => {
    const row = record(item)
    if (!row || !exact(row, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
      || !safeId(row.nodeKey) || row.nodeKey <= previous || !safeId(row.taskId) || !positive(row.attemptCount)
      || ![row.nodeDigest, row.resultDigest, row.evidenceDigest, row.reportDigest].every(hash => typeof hash === "string" && DIGEST.test(hash))) return false
    previous = row.nodeKey
    return true
  })
}

function repairReceipt(value: unknown, taskId: string, report: Row): boolean {
  const row = record(value), ids = row && dense(row.criterionIds, 8)
  return !!row && exact(row, "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    && row.schemaVersion === "agent-harness.v2.task-graph-repair-receipt.v1" && row.verifierVersion === VERIFIER
    && row.repairTaskId === taskId && [row.graphRootTaskId, row.repairNodeKey, row.targetNodeKey, row.targetTaskId].every(safeId)
    && typeof row.evidenceDigest === "string" && row.evidenceDigest === report.evidenceDigest
    && !!ids && ids.length > 0 && ids.every(id => typeof id === "string" && CRITERION.test(id)) && new Set(ids).size === ids.length
}

function discoveryAttempt(value: unknown): boolean {
  const row = record(value), health = row && record(row.health), footprint = row && record(row.queryFootprint)
  if (!row || !allowed(row, ["attemptCount", "health"], ["queryFootprint"]) || !positive(row.attemptCount)
    || !health || !exact(health, "attemptedCalls,candidateCount,completedCalls,failedCalls,hasMore,materializationFailures,providerFailures,schemaVersion,unresolvedCalls")
    || health.schemaVersion !== "agent-harness.v2.task-graph.discovery-attempt-health.v1"
    || !positive(health.attemptedCalls) || !count(health.completedCalls) || !count(health.failedCalls) || !count(health.unresolvedCalls)
    || health.attemptedCalls !== Number(health.completedCalls) + Number(health.failedCalls) + Number(health.unresolvedCalls)
    || !nullableCount(health.candidateCount) || !nullableCount(health.providerFailures) || !nullableCount(health.materializationFailures)
    || health.hasMore !== null && typeof health.hasMore !== "boolean"
    || Number(health.unresolvedCalls) > 0 && [health.candidateCount, health.providerFailures, health.materializationFailures, health.hasMore].some(item => item !== null)) return false
  return !Object.hasOwn(row, "queryFootprint") || validFootprint(footprint)
}

function validFootprint(row: Row | undefined): boolean {
  if (!row || row.schemaVersion !== "agent-harness.v2.task-graph.discovery-query-footprint.v1") return false
  if (row.availability === "omitted") return exact(row, "availability,omissionReason,schemaVersion")
    && ["call_limit", "byte_limit", "unsafe_criteria", "capture_unavailable", "invalid_criteria"].includes(String(row.omissionReason))
  const calls = exact(row, "availability,calls,schemaVersion") && row.availability === "available" ? dense(row.calls, 8) : undefined
  return !!calls && calls.length > 0 && calls.every(value => {
    const call = record(value), criteria = call && record(call.criteria)
    return !!call && exact(call, "criteria,hasMore,materializationFailures,observedCandidateCount,outcome,providerFailures,requestCount")
      && !!criteria && criteriaKeys(criteria) && ["completed", "failed", "cancelled", "unresolved"].includes(String(call.outcome))
      && [call.requestCount, call.observedCandidateCount, call.providerFailures, call.materializationFailures].every(nullableCount)
      && (call.hasMore === null || typeof call.hasMore === "boolean")
  })
}

function criteriaKeys(row: Row): boolean {
  return allowed(row, ["targetRoles", "targetLocations", "hasCursor"], ["source", "pageSize"])
    && strings(row.targetRoles, 8, 1) && strings(row.targetLocations, 8, 0) && typeof row.hasCursor === "boolean"
    && (!Object.hasOwn(row, "source") || ["greenhouse", "lever", "workday", "smartrecruiters", "personio"].includes(String(row.source)))
    && (!Object.hasOwn(row, "pageSize") || positive(row.pageSize) && Number(row.pageSize) <= 50)
}

function strings(value: unknown, max: number, min: number): boolean {
  const rows = dense(value, max)
  return !!rows && rows.length >= min && rows.every(item => typeof item === "string" && item.length > 0 && item.length <= 160 && item.trim() === item)
}
function workerDigest(value: unknown): string { return createHash("sha256").update(workerCanonicalJson(value)).digest("hex") }
function workerCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workerCanonicalJson).join(",")}]`
  const row = record(typeof value === "string" ? parseJson(value) : value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${workerCanonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("task_graph_verification_result_invalid")
  return encoded
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
function exact(value: Row, keys: string): boolean { return Reflect.ownKeys(value).length === keys.split(",").length && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",") }
function allowed(value: Row, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every(key => typeof key === "string" && (required.includes(key) || optional.includes(key))) && required.every(key => Object.hasOwn(value, key))
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const keys = Reflect.ownKeys(value); return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : undefined } catch { return undefined }
}
function dense(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return undefined
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value : undefined
}
function count(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000 }
function nullableCount(value: unknown): boolean { return value === null || count(value) }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000 }
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
