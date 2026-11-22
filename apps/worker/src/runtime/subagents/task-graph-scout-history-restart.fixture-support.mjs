import { Buffer } from "node:buffer"
import { prepareSafeValue } from "../tools/redaction.ts"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.ts"
import { MAX_TOOL_RESULT_READ_BYTES, prepareToolResultJson } from "../tools/tool-result-reference-types.ts"

export const SCOUT_HISTORY_DISCOVERY_INPUT = Object.freeze({
  targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], pageSize: 10,
})
export const SCOUT_HISTORY_BODY = "Fixture discovery history remains available after restart. "
const READS_PER_MODEL_STEP = 8
const PLACEHOLDER_REFERENCE = "tool-result-00000000-0000-4000-8000-000000000000"

function job(id, slot) {
  const evidenceId = `fixture-discovery-source-${slot}`
  return {
    id, title: `Software Engineer ${slot}`, company: `Restart Fixture ${slot}`, location: "Dublin",
    url: `https://jobs.example.invalid/discovery-history/${slot}`,
    description: SCOUT_HISTORY_BODY.repeat(1_300), fullDescription: SCOUT_HISTORY_BODY.repeat(1_300),
    salary: null, logo: null, source: "greenhouse", evidenceRefs: [evidenceId],
  }
}

function utf8End(bytes, start, limit, total) {
  let end = limit
  while (end > start && end < total && (bytes[end] & 0xc0) === 0x80) end -= 1
  return end
}

function readCursors(encoded, sha256) {
  const bytes = Buffer.from(encoded, "utf8"), cursors = []
  let start = 0
  while (start < bytes.length) {
    let accepted = false
    let end = utf8End(bytes, start, Math.min(bytes.length, start + MAX_TOOL_RESULT_READ_BYTES), bytes.length)
    while (end > start) {
      const item = {
        ref: PLACEHOLDER_REFERENCE, sha256, byteCount: bytes.length,
        chunk: bytes.subarray(start, end).toString("utf8"), nextCursor: end < bytes.length ? String(end) : null,
      }
      if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TOOL_RESULT_READ_BYTES) {
        cursors.push(start === 0 ? undefined : String(start))
        start = end
        accepted = true
        break
      }
      end = utf8End(bytes, start, end - 1, bytes.length)
    }
    if (!accepted) throw new Error("fixture_discovery_cursor_generation_failed")
  }
  const batches = []
  for (let index = 0; index < cursors.length; index += READS_PER_MODEL_STEP) {
    batches.push(cursors.slice(index, index + READS_PER_MODEL_STEP))
  }
  return batches
}

/** Deterministic offline client used only by the real Worker process fixture. */
export function createScoutHistoryRestartSupport(input) {
  if (typeof input?.candidateJobId !== "string" || typeof input?.paddingJobId !== "string"
    || input.candidateJobId === input.paddingJobId) throw new TypeError("fixture_discovery_job_ids_invalid")
  const plans = new Map()
  const client = Object.freeze({
    async discover(request, signal) {
      if (signal.aborted || request.role !== "scout" || request.attemptCount !== 1) {
        throw new Error("fixture_discovery_request_scope_invalid")
      }
      const jobs = [job(input.candidateJobId, 0), job(input.paddingJobId, 1)]
      const evidence = jobs.map((item, index) => ({
        evidenceId: `fixture-discovery-source-${index}`, jobId: item.id, kind: "source",
        source: item.source, url: item.url, summary: `Verified deterministic source ${index}`,
      }))
      const output = {
        jobs, evidence, nextCursor: null,
        usage: {
          ledgerKey: `fixture:${request.userId}:${request.sessionId}:${request.turnId}:${request.stepId}:${request.toolCallId}`,
          toolName: "jobs.discover", toolVersion: "1", toolCallId: request.toolCallId,
          sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
          requests: 1, jobsProcessed: jobs.length, jobsSucceeded: jobs.length, jobsFailed: 0,
          providerFailures: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
        },
      }
      const safeLifecycle = prepareSafeValue(redactJobReadOutput("jobs.discover", output)).safe
      const prepared = prepareToolResultJson(safeLifecycle, "jobs.discover")
      const key = `${request.taskId}:${request.attemptCount}`
      if (plans.has(key)) throw new Error("fixture_discovery_call_repeated")
      plans.set(key, {
        sizeBytes: prepared.bytes, sha256: prepared.sha256, cursorBatches: readCursors(prepared.encoded, prepared.sha256),
      })
      return output
    },
  })
  return Object.freeze({
    client,
    planFor(task) { return plans.get(`${task.id}:${task.attemptCount}`) },
  })
}
