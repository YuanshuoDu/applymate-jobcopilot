import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import { SPONSORSHIP_OBSERVATION_SCHEMA, parseSponsorshipObservation, sponsorshipRoleDigest,
  type SponsorshipObservation, type SponsorshipObservationBinding } from "./sponsorship-observation-contract.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { loadTaskGraphVerificationReceipts, type TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { validateRoleResult } from "./role-results.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import type { CoordinationTaskView } from "../tools/coordination-types.js"

type Row = Record<string, unknown>
type Candidate = Readonly<{ jobId: string; source: string; url: string | null }>
type Receipt = Readonly<{ call: Row; result: Row; callContent: Row; resultContent: Row; outcome: "completed" | "failed" }>
export type SponsorshipObservationTask = Pick<CoordinationTaskView,
  "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId" | "role" | "taskType" | "status" | "attemptCount" | "context" | "result">
export type BoundSponsorshipObservation = Readonly<{ jobId: string; observation: SponsorshipObservation;
  /** Private verified source bytes for a server-owned Reviewer; never copied to public wait output. */
  source?: Readonly<{ job: Row; scoutResultDigest: string; sourceReceiptDigest: string; materialDigest: string }> }>
const MAX_EXCERPT_BYTES = 1024
const MAX_CANDIDATES = 50

function record(value: unknown): Row | undefined {
  if (typeof value === "string") { try { return record(JSON.parse(value) as unknown) } catch { return undefined } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function sha(value: unknown): string { return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}` }
function stableJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map(visit)
    const row = record(input); if (!row) throw new TypeError("sponsorship_receipt_not_json")
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, visit(row[key])]))
  }
  return JSON.stringify(visit(value))
}
function utf8Prefix(value: string, maxBytes: number): string {
  let result = "", size = 0
  for (const character of value) { const next = Buffer.byteLength(character, "utf8"); if (size + next > maxBytes) break; result += character; size += next }
  return result
}
export function isSponsorshipObservationTask(task: SponsorshipObservationTask): boolean {
  const context = record(task.context)
  return task.role === "scout" && task.taskType === "job_discovery" && task.status === "completed"
    && typeof task.turnId === "string" && text(task.rootTaskId) && text(task.parentTaskId)
    && Number.isSafeInteger(task.attemptCount) && task.attemptCount > 0 && !!context
    && !["selectedJobPreparation", "coverLetterBase", "writerReviewFeedback"].some(key => Object.hasOwn(context, key))
}
function scopeFromTask(task: SponsorshipObservationTask): TaskGraphVerificationScope {
  return { userId: task.userId, sessionId: task.sessionId, turnId: task.turnId!, rootTaskId: task.rootTaskId!,
    parentTaskId: task.parentTaskId!, taskId: task.id, attemptCount: task.attemptCount }
}
function candidatesFrom(value: unknown): Candidate[] | null {
  const envelope = record(value), structured = envelope && record(envelope.structuredResult)
  if (!structured) return null
  try {
    const result = validateRoleResult(structured, "scout")
    if (result.candidates.length > MAX_CANDIDATES) return null
    const candidates = result.candidates.map(candidate => ({ jobId: candidate.jobId, source: candidate.source, url: candidate.url }))
    return candidates.every(candidate => isCanonicalJobId(candidate.jobId))
      && new Set(candidates.map(candidate => candidate.jobId)).size === candidates.length ? candidates : null
  } catch { return null }
}
export function sponsorshipCandidateJobIds(task: SponsorshipObservationTask): readonly string[] | null {
  if (!isSponsorshipObservationTask(task)) return null
  return candidatesFrom(task.result)?.map(candidate => candidate.jobId) ?? null
}
function receiptPairs(receipts: TaskGraphVerificationReceipts, candidates: readonly Candidate[]): Map<string, Receipt[]> {
  const candidateIds = new Set(candidates.map(item => item.jobId)), results = new Map<string, Row>()
  for (const item of receipts.items) {
    if (item.type !== "tool_result") continue
    const content = record(item.content)
    if (content && text(content.toolCallId)) results.set(content.toolCallId, item)
  }
  const byJob = new Map<string, Receipt[]>()
  for (const item of receipts.items) {
    if (item.type !== "tool_call") continue
    const callContent = record(item.content), callId = callContent?.toolCallId
    if (!callContent || !text(callId) || callContent.toolName !== "jobs.get") continue
    const input = exactRecord(callContent.input, ["jobId"]), jobId = input?.jobId
    if (typeof jobId !== "string" || !candidateIds.has(jobId)) continue
    const result = results.get(callId), resultContent = result && record(result.content), outcome = receipts.outcomes.get(callId)
    const list = byJob.get(jobId) ?? []
    if (!result || !resultContent || (outcome !== "completed" && outcome !== "failed")) {
      list.push({ call: item, result: result ?? {}, callContent, resultContent: resultContent ?? {}, outcome: "failed" })
    } else list.push({ call: item, result, callContent, resultContent, outcome })
    byJob.set(jobId, list)
  }
  return byJob
}
function exactRecord(value: unknown, keys: readonly string[]): Row | undefined {
  const row = record(value)
  if (!row) return undefined
  const ownKeys = Reflect.ownKeys(row)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
  return keys.every(key => Object.hasOwn(row, key)) ? row : undefined
}
function receiptDigest(receipts: readonly Receipt[]): string {
  return sha([...receipts].map(receipt => ({
    callItem: [receipt.call.id, receipt.call.revision], resultItem: [receipt.result.id, receipt.result.revision],
    stepId: receipt.call.stepId, attempt: receipt.call.attempt, ordinal: receipt.call.ordinal,
    toolCallId: receipt.callContent.toolCallId, toolVersion: receipt.callContent.toolVersion,
    outcome: receipt.outcome, callStatus: receipt.callContent.status, errorCode: receipt.resultContent.errorCode,
    outputDigest: sha(receipt.resultContent.output ?? null),
  })))
}
function binding(scope: TaskGraphVerificationScope, jobId: string, roleDigest: string,
  sourceReceiptDigest: string | null, materialDigest: string | null): SponsorshipObservationBinding {
  return { bindingDigest: sha({ scope, jobId, roleDigest, sourceReceiptDigest, materialDigest, targetCountryCode: null }),
    sourceReceiptDigest, materialDigest, roleDigest, targetCountryCode: null }
}
function makeObservation(scope: TaskGraphVerificationScope, jobId: string, role: string, status: SponsorshipObservation["status"],
  reason?: string, proof?: { readonly digest: string; readonly materialDigest: string; readonly job: Row }, sourceReceiptDigest: string | null = null): SponsorshipObservation | null {
  const roleDigest = sponsorshipRoleDigest(role), current = binding(scope, jobId, roleDigest,
    status === "inconclusive" ? proof?.digest ?? null : status === "unavailable" ? sourceReceiptDigest : null,
    status === "inconclusive" ? proof?.materialDigest ?? null : null)
  const raw = status === "inconclusive" && proof ? {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status, reason: "interpretation_unverified", binding: current,
    sourceContext: sourceContext(proof.job),
  } : status === "not_checked" ? {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status, reason: "not_performed", binding: current,
  } : { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "unavailable", reason: reason ?? "invalid_receipt", binding: current }
  const context = status === "inconclusive" && proof ? sourceContext(proof.job) : undefined
  return parseSponsorshipObservation(raw, { binding: current, ...(context ? { sourceContext: context, sourceFields: { description: typeof proof!.job.description === "string" ? proof!.job.description : null } } : {}) })
}
function sourceContext(job: Row) {
  const description = typeof job.description === "string" ? job.description : ""
  const url = typeof job.url === "string" ? job.url : ""
  const source = typeof job.source === "string" ? job.source : ""
  const company = typeof job.company === "string" ? job.company : ""
  const role = typeof job.role === "string" ? job.role : ""
  const location = typeof job.location === "string" ? job.location : null
  let sourceUrl = ""
  try { const parsed = new URL(url); if (parsed.protocol === "http:" || parsed.protocol === "https:") sourceUrl = parsed.origin } catch { /* invalid source URL fails contract parsing */ }
  return { source, sourceUrl, company, role, location,
    descriptionExcerpt: utf8Prefix(description, MAX_EXCERPT_BYTES), descriptionExcerptStartByte: 0 }
}
function unavailable(scope: TaskGraphVerificationScope, candidate: Candidate, reason: Extract<SponsorshipObservation, { status: "unavailable" }> ["reason"],
  digest: string | null = null): SponsorshipObservation | null {
  return makeObservation(scope, candidate.jobId, "", "unavailable", reason, undefined, digest)
}
function observeCandidate(scope: TaskGraphVerificationScope, candidate: Candidate, calls: readonly Receipt[], anyJobsGet: boolean,
  invalidJobsGet: boolean, currentJob: Row | null | undefined, readFailed: boolean): SponsorshipObservation | null {
  if (calls.length > 1) return unavailable(scope, candidate, "duplicate_receipt", receiptDigest(calls))
  if (calls.length === 0) return invalidJobsGet ? unavailable(scope, candidate, "invalid_receipt")
    : anyJobsGet ? unavailable(scope, candidate, "wrong_job") : makeObservation(scope, candidate.jobId, "", "not_checked")
  const proofDigest = receiptDigest(calls), receipt = calls[0]!, callInput = record(receipt.callContent.input)
  if (!exactRecord(receipt.callContent, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    || !exactRecord(receipt.resultContent, ["toolCallId", "output", "errorCode"])
    || receipt.outcome !== "completed" || receipt.callContent.status !== "completed" || receipt.callContent.toolVersion !== "1"
    || receipt.resultContent.errorCode !== null || !callInput || callInput.jobId !== candidate.jobId) return unavailable(scope, candidate, "read_failed", proofDigest)
  const output = exactRecord(receipt.resultContent.output, ["job"]), job = output && record(output.job)
  if (!job) return unavailable(scope, candidate, output?.job === null ? "source_missing" : "invalid_receipt", proofDigest)
  if (job.id !== candidate.jobId) return unavailable(scope, candidate, "wrong_job", proofDigest)
  if (readFailed) return unavailable(scope, candidate, "read_failed", proofDigest)
  if (!currentJob) return unavailable(scope, candidate, "source_missing", proofDigest)
  const recordedDigest = scheduledDraftJobMaterialDigest(job), currentDigest = scheduledDraftJobMaterialDigest(currentJob)
  if (!recordedDigest || !currentDigest) return unavailable(scope, candidate, "invalid_receipt", proofDigest)
  if (recordedDigest !== currentDigest) return unavailable(scope, candidate, "source_drift", proofDigest)
  if (typeof job.source !== "string" || !job.source.trim() || candidate.source !== job.source || candidate.url !== job.url
    || typeof job.url !== "string" || !text(job.company) || !text(job.role)) return unavailable(scope, candidate, "source_missing", proofDigest)
  const materialBinding = binding(scope, candidate.jobId, sponsorshipRoleDigest(job.role), proofDigest, recordedDigest)
  return parseSponsorshipObservation({ schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive",
    reason: "interpretation_unverified", binding: materialBinding, sourceContext: sourceContext(job) }, {
    binding: materialBinding, sourceContext: sourceContext(job), sourceFields: { description: typeof job.description === "string" ? job.description : null },
  })
}

/** Caller owns the transaction, user context, and any broader Root lease fence. */
export async function readSponsorshipTaskObservationsWithClient(
  client: Pick<pg.PoolClient, "query">, task: SponsorshipObservationTask,
  options: Readonly<{ jobIds?: readonly string[] }> = {},
): Promise<readonly BoundSponsorshipObservation[] | undefined> {
  if (!isSponsorshipObservationTask(task)) return undefined
  const candidates = candidatesFrom(task.result)
  if (!candidates || candidates.length === 0) return undefined
  const scope = scopeFromTask(task)
  const result = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."role", task."taskType", task."status", task."attemptCount", task."result", task."context"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $5
      AND session."userId" = $6 AND turn."userId" = $6 AND turn."rootTaskId" = $4
      AND task."role" = 'scout' AND task."taskType" = 'job_discovery' AND task."status" = 'completed' AND task."attemptCount" = $7`,
  [task.id, task.sessionId, task.turnId, task.rootTaskId, task.parentTaskId, task.userId, task.attemptCount])
  const row = record(result.rows[0]), durableCandidates = row && candidatesFrom({ structuredResult: record(row.result)?.structuredResult })
  if (!row || result.rows.length !== 1 || !durableCandidates || stableJson(durableCandidates) !== stableJson(candidates)) throw new Error("sponsorship_task_scope_invalid")
  const selectedCandidates = options.jobIds === undefined ? candidates : (() => {
    if (!Array.isArray(options.jobIds) || options.jobIds.length < 1 || new Set(options.jobIds).size !== options.jobIds.length
      || options.jobIds.some(jobId => !isCanonicalJobId(jobId) || !candidates.some(candidate => candidate.jobId === jobId))) return null
    const selected = new Set(options.jobIds)
    return candidates.filter(candidate => selected.has(candidate.jobId))
  })()
  if (!selectedCandidates || selectedCandidates.length === 0) return undefined
  const count = await client.query(`SELECT COUNT(*) FILTER (WHERE item."type" = 'tool_call') AS "callCount", COUNT(*) FILTER (WHERE item."type" = 'tool_result') AS "resultCount"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."type" IN ('tool_call','tool_result') AND step."attempt" = $4
      AND task."rootTaskId" = $5 AND task."parentTaskId" = $6 AND session."userId" = $7 AND turn."userId" = $7 AND turn."rootTaskId" = $5`,
  [scope.taskId, scope.sessionId, scope.turnId, scope.attemptCount, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const counts = record(count.rows[0]), callCount = Number(counts?.callCount ?? 0), resultCount = Number(counts?.resultCount ?? 0)
  const receipts = callCount > 0 || resultCount > 0 ? await loadTaskGraphVerificationReceipts(client, scope) : undefined
  const allCalls = receipts?.items.filter(item => item.type === "tool_call" && record(item.content)?.toolName === "jobs.get") ?? []
  const invalidJobsGet = allCalls.some(item => {
    const call = record(item.content)
    return !call || !exactRecord(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
      || !exactRecord(call.input, ["jobId"]) || !isCanonicalJobId(record(call.input)?.jobId)
  })
  const pairs = receipts ? receiptPairs(receipts, candidates) : new Map<string, Receipt[]>(), observations: BoundSponsorshipObservation[] = []
  const dataSource = createPostgresReadToolDataSource(client)
  for (const candidate of selectedCandidates) {
    const calls = pairs.get(candidate.jobId) ?? []
    let currentJob: Row | null | undefined, readFailed = false
    if (calls.length === 1 && calls[0]!.outcome === "completed" && record(calls[0]!.resultContent.output)?.job !== null) {
      try { currentJob = await dataSource.getJob(task.userId, candidate.jobId) as Row | null }
      catch { readFailed = true }
    }
    const observation = observeCandidate(scope, candidate, calls, allCalls.length > 0, invalidJobsGet, currentJob, readFailed)
      ?? unavailable(scope, candidate, "invalid_receipt")
    if (observation) {
      const verifiedSource = observation.status === "inconclusive" && currentJob && calls.length === 1
        ? { job: currentJob, scoutResultDigest: sha(row.result), sourceReceiptDigest: receiptDigest(calls),
          materialDigest: scheduledDraftJobMaterialDigest(currentJob) }
        : undefined
      observations.push({ jobId: candidate.jobId, observation,
        ...(verifiedSource?.materialDigest ? { source: verifiedSource as NonNullable<BoundSponsorshipObservation["source"]> } : {}) })
    }
  }
  return observations
}

export function failedSponsorshipTaskObservations(task: SponsorshipObservationTask): readonly BoundSponsorshipObservation[] | undefined {
  if (!isSponsorshipObservationTask(task)) return undefined
  const candidates = candidatesFrom(task.result)
  if (!candidates || candidates.length === 0) return undefined
  const scope = scopeFromTask(task)
  return candidates.flatMap(candidate => {
    const observation = unavailable(scope, candidate, "read_failed")
    return observation ? [{ jobId: candidate.jobId, observation }] : []
  })
}
