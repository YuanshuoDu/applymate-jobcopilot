import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { parseDurableDiscoveryReference } from "./child-durable-discovery.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"
import type { TaskGraphReplayReceipt } from "./task-graph-pg-event-validation.js"

export type TaskGraphVerificationScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; taskId: string; attemptCount: number }>
type Row = Record<string, unknown>
const EVIDENCE_TOOLS = new Set(["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "persona.retrieve", "resume.get_base"])
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_OBSERVATION_BYTES = 512 * 1024
const MAX_DURABLE_CHUNK_BYTES = 4096
const TOOL_RESULT_REF = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

export function validateTaskGraphVerificationItems(values: readonly unknown[], scope: TaskGraphVerificationScope): Row[] {
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
    const content = record(item.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined
    const target = item.type === "tool_call" ? calls : item.type === "tool_result" ? results : undefined
    if (!content || !callId) throw new Error("task_graph_verification_item_invalid")
    if (!target || target.has(callId)) throw new Error("task_graph_verification_item_duplicate")
    target.set(callId, { ...item, content })
  }
  if (calls.size === 0 || calls.size !== results.size) throw new Error("task_graph_verification_pair_invalid")
  for (const [callId, call] of calls) {
    const result = results.get(callId), callContent = call.content as Row, resultContent = result?.content as Row | undefined
    if (!result || result.stepId !== call.stepId || Number(result.attempt) !== Number(call.attempt) || Number(result.ordinal) !== Number(call.ordinal)
      || !text(callContent.toolName) || !text(callContent.toolVersion) || !Object.hasOwn(callContent, "input") || !resultContent
      || !Object.hasOwn(resultContent, "output") || result.status !== "completed"
      || (callContent.status !== "completed" && callContent.status !== "failed") || callContent.errorCode !== resultContent.errorCode
      || (callContent.status === "completed" ? callContent.errorCode !== null : !text(callContent.errorCode))) throw new Error("task_graph_verification_pair_invalid")
  }
  return items
}

export function canonicalTaskGraphReadObservations(items: readonly Row[], outcomes: ReadonlyMap<string, "completed" | "failed">): Array<{ id: string; content: Row }> {
  const results = new Map(items.filter(item => item.type === "tool_result").map(item => [String((item.content as Row).toolCallId), item] as const))
  const observations: Array<{ id: string; content: Row }> = []
  let totalBytes = 0
  for (const call of items.filter(item => item.type === "tool_call")) {
    const content = call.content as Row, callId = String(content.toolCallId), toolName = String(content.toolName)
    if (outcomes.get(callId) !== "completed" || !EVIDENCE_TOOLS.has(toolName)) continue
    const result = results.get(callId)?.content as Row | undefined
    if (!result || !Object.hasOwn(result, "output")) throw new Error("task_graph_verification_output_invalid")
    const output = result.output, encoded = JSON.stringify(output)
    if (encoded === undefined) throw new Error("task_graph_verification_output_invalid")
    totalBytes += Buffer.byteLength(encoded, "utf8")
    if (totalBytes > MAX_TOTAL_BYTES || Buffer.byteLength(encoded, "utf8") > MAX_OBSERVATION_BYTES || truncated(output)) throw new Error("task_graph_verification_output_invalid")
    const source = (value: Row, fallback: string) => {
      const candidate = value.source
      if (candidate === undefined || candidate === null) return fallback
      if (typeof candidate !== "string") return undefined
      if (candidate.trim().length === 0) return fallback
      return candidate.length <= 256 ? candidate : undefined
    }
    const observedSource = (value: Row): string | null | undefined => {
      const candidate = value.source
      if (candidate === undefined || candidate === null) return null
      if (typeof candidate !== "string" || candidate.length > 256) return undefined
      if (candidate.trim().length === 0) return null
      return candidate
    }
    const location = (value: Row): string | null | undefined => {
      const candidate = value.location
      if (candidate === undefined || candidate === null) return null
      return typeof candidate === "string" && candidate.length <= 500 ? candidate : undefined
    }
    const row = record(output)
    let projected: unknown
    let projectedInput: unknown = {}
    if (toolName === "jobs.search" && row && denseRecords(row.jobs, "id")) {
      const jobs = (row.jobs as Row[]).map(job => ({ id: job.id, source: source(job, "jobs.read"), observedSource: observedSource(job), location: location(job) }))
      if (jobs.some(job => !job.source || job.observedSource === undefined || job.location === undefined)) throw new Error("task_graph_verification_output_invalid")
      projected = { jobs }
    } else if (toolName === "jobs.get" && row && (row.job === null || record(row.job) && text((row.job as Row).id))) {
      if (row.job === null) projected = { job: null }
      else {
        const job = row.job as Row
        const canonicalSource = source(job, "jobs.read"), actualSource = observedSource(job), actualLocation = location(job)
        if (!canonicalSource || actualSource === undefined || actualLocation === undefined) throw new Error("task_graph_verification_output_invalid")
        projected = { job: { id: job.id, source: canonicalSource, observedSource: actualSource, location: actualLocation } }
      }
    } else if (toolName === "jobs.discover") {
      let reference
      try { reference = parseDurableDiscoveryReference(output) }
      catch { throw new Error("task_graph_verification_output_invalid") }
      if (reference) projected = { $ref: reference.ref, sizeBytes: reference.byteCount, sha256: reference.sha256 }
      else {
        const safe = redactJobReadOutput(toolName, output)
        if (safe === "[REDACTED]" || !record(safe)) throw new Error("task_graph_verification_output_invalid")
        projected = safe
      }
    } else if (toolName === "tool_results.read") {
      const safe = canonicalToolResultRead(content.input, output)
      if (!safe) throw new Error("task_graph_verification_output_invalid")
      projectedInput = safe.input
      projected = safe.output
    } else if (toolName === "persona.retrieve" && row && denseRecords(row.facts, "id")) {
      const facts = (row.facts as Row[]).map(fact => ({ id: fact.id, source: source(fact, "persona.retrieve") })); if (facts.some(fact => !fact.source)) throw new Error("task_graph_verification_output_invalid"); projected = { facts }
    } else if (toolName === "resume.get_base" && row && record(row.resume) && text((row.resume as Row).id)) projected = { resume: { id: (row.resume as Row).id } }
    else throw new Error("task_graph_verification_output_invalid")
    observations.push({ id: `tool-result:${callId}`, content: { toolCallId: callId, toolName, input: projectedInput, status: "completed", output: projected, errorCode: null } })
  }
  return observations
}

function canonicalToolResultRead(input: unknown, output: unknown): { input: Row; output: Row } | undefined {
  const request = exactRecord(input, ["referenceId"], ["cursor"]), result = exactRecord(output, ["ref", "sha256", "byteCount", "chunk", "nextCursor"])
  if (!request || !result || typeof request.referenceId !== "string" || !TOOL_RESULT_REF.test(request.referenceId)
    || result.ref !== request.referenceId || typeof result.sha256 !== "string" || !SHA256.test(result.sha256)
    || !Number.isSafeInteger(result.byteCount) || (result.byteCount as number) < 0 || (result.byteCount as number) > 1024 * 1024
    || typeof result.chunk !== "string" || Buffer.byteLength(result.chunk, "utf8") > MAX_DURABLE_CHUNK_BYTES
    || Buffer.from(result.chunk, "utf8").toString("utf8") !== result.chunk
    || result.nextCursor !== null && (typeof result.nextCursor !== "string" || !/^(0|[1-9]\d*)$/.test(result.nextCursor))) return undefined
  if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 32
    || !/^(0|[1-9]\d*)$/.test(request.cursor) || !Number.isSafeInteger(Number(request.cursor)))) return undefined
  if (result.nextCursor !== null && Number(result.nextCursor) > (result.byteCount as number)) return undefined
  const canonicalInput = request.cursor === undefined ? { referenceId: request.referenceId } : { referenceId: request.referenceId, cursor: request.cursor }
  return { input: canonicalInput, output: { ref: result.ref, sha256: result.sha256, byteCount: result.byteCount, chunk: result.chunk, nextCursor: result.nextCursor } }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Row | undefined {
  const parsed = record(value)
  if (!parsed) return undefined
  const allowed = new Set([...required, ...optional]), keys = Reflect.ownKeys(parsed)
  if (keys.length < required.length || keys.length > allowed.size || keys.some(key => typeof key !== "string" || !allowed.has(key))) return undefined
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(parsed, key); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined }
  return required.every(key => Object.hasOwn(parsed, key)) ? parsed : undefined
}

export function taskGraphEvidenceDigest(items: readonly Row[], outcomes: ReadonlyMap<string, "completed" | "failed">, evidenceIds: readonly string[], resultDigest: string, replayReceipts: readonly TaskGraphReplayReceipt[]): string {
  const byCall = new Map(items.filter(item => item.type === "tool_result").map(item => [String((item.content as Row).toolCallId), item] as const))
  const replayByCall = new Map(replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const))
  const receipts = items.filter(item => item.type === "tool_call" && EVIDENCE_TOOLS.has(String((item.content as Row).toolName))
    && outcomes.get(String((item.content as Row).toolCallId)) === "completed").map(call => {
      const content = call.content as Row, result = byCall.get(String(content.toolCallId))!, output = JSON.stringify((result.content as Row).output)
      return { attempt: Number(call.attempt), callId: content.toolCallId, toolName: content.toolName, toolVersion: content.toolVersion,
        callItem: [call.id, Number(call.revision)], resultItem: [result.id, Number(result.revision)], replaySource: replayByCall.get(String(content.toolCallId)) ?? null, outputHash: createHash("sha256").update(output).digest("hex") }
    }).sort((a, b) => a.attempt - b.attempt || String(a.callId).localeCompare(String(b.callId)))
  return createHash("sha256").update(JSON.stringify({ evidenceIds: [...evidenceIds].sort(), receipts, resultDigest })).digest("hex")
}

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
