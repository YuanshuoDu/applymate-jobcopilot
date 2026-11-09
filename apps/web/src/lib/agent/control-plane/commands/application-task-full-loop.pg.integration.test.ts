import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { spawn, type ChildProcess } from "node:child_process"
import { connect as connectSocket } from "node:net"
import { access, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"
import { protocolScope, type ApprovalScopeInput } from "@/lib/agent/approval/types"
import type { ApplicationPackage, PipelineCtx } from "@/lib/agent/types"

vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const REDIS_URL = "redis://127.0.0.1:6379/15"
const runId = randomUUID().replaceAll("-", "")
const candidateName = "A B"
const candidateEmail = `${runId.slice(0, 1)}@${runId.slice(1, 3)}.co`
const ids = {
  user: `full-loop-user-${runId}`,
  foreignUser: `full-loop-foreign-${runId}`,
  session: `full-loop-session-${runId}`,
  gateTurn: `full-loop-gate-turn-${runId}`,
  execution: `full-loop-execution-${runId}`,
  job: `full-loop-job-${runId}`,
  resume: `full-loop-resume-${runId}`,
}
const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  "turn_execution_failed",
  "model_execution_failed",
  "application_fill_state_invalid",
  "application_fill_binding_invalid",
  "application_fill_material_unavailable",
  "application_fill_fixture_model_validation_failed",
  "application_fill_tool_transcript_invalid",
  "application_fill_tool_use_id_invalid",
  "application_fill_plan_receipt_missing_ready_task",
  "application_fill_plan_receipt_invalid",
  "application_fill_wait_limit_exceeded",
  "application_fill_wait_output_missing",
  "application_fill_wait_output_invalid",
  "application_fill_wait_scope_or_status_invalid",
  "application_fill_wait_terminal_interrupted",
  "application_fill_wait_terminal_closed",
  "application_fill_child_terminal_status_invalid",
  "fill_role_invalid",
  "fill_lease_invalid",
  "lease_lost",
  "fill_scope_mismatch",
  "account_inactive",
  "application_task_inactive",
  "fill_checkpoint_invalid",
  "fill_turn_inactive",
  "fill_material_unavailable",
  "fill_rate_limited",
  "fill_preflight_unavailable",
  "fill_prestart_unavailable",
  "fill_start_conflict",
  "unattended_apply_unavailable",
  "unknown_sensitive_field",
  "required_field",
  "fill_cancelled",
  "fill_outcome_uncertain",
  "fill_wait_conflict",
  "fill_wait_persistence_unavailable",
  "fill_cancellation_conflict",
  "fill_cancellation_unavailable",
  "fill_prestart_failure_conflict",
  "fill_prestart_failure_unavailable",
  "fill_completion_conflict",
])

function diagnosticMachineErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" && SAFE_DIAGNOSTIC_ERROR_CODES.has(value) ? value : "present"
}

const SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES = [
  "queue_delivery_or_ack_failed",
  "terminal:invalid_intent_payload",
  "terminal:outbox_identity_mismatch",
  "terminal:outbox_identity_changed",
  "terminal:queue_job_identity_mismatch",
  "terminal:application_task_scope_mismatch",
  "terminal:worker_task_id_mismatch",
  "terminal:application_job_state_mismatch",
  "terminal:attempt_already_claimed_or_terminal",
  "terminal:application_account_inactive",
  "terminal:approval_scope_mismatch",
  "terminal:submission_queued_event_mismatch",
  "terminal:submission_scope_mismatch",
  "terminal:submission_attempt_fenced",
  "terminal:attempt_superseded",
  "terminal:terminal_submit_reconciled",
] as const
const SAFE_SUBMIT_OUTBOX_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES)
type SafeSubmitOutboxErrorCategory = typeof SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES[number]

function diagnosticSubmitOutboxErrorCategory(value: unknown): "none" | "other" | SafeSubmitOutboxErrorCategory {
  if (value === null || value === undefined) return "none"
  return typeof value === "string" && SAFE_SUBMIT_OUTBOX_ERROR_CATEGORY_SET.has(value)
    ? value as SafeSubmitOutboxErrorCategory
    : "other"
}

const SAFE_SUBMISSION_ATTEMPT_ERROR_CODES = [
  "approval_not_found",
  "approval_scope_mismatch",
  "approval_integrity_error",
  "approval_expired",
  "approval_not_approved",
  "approval_already_consumed",
  "approval_nonce_mismatch",
  "approval_revision_mismatch",
  "approval_reservation_conflict",
  "browser_412",
  "browser_manual",
  "browser_failed",
  "idempotency_conflict",
  "idempotency_replay",
  "invalid_state",
  "not_found",
  "submission_attempt_fenced",
  "submission_scope_mismatch",
  "invalid_input",
  "target_not_found",
  "submission_in_flight",
  "stale_artifact",
  "submission_guard_denied",
  "provider_invalid_response",
  "provider_error",
] as const
const SAFE_SUBMISSION_ATTEMPT_ERROR_CODE_SET: ReadonlySet<string> = new Set(SAFE_SUBMISSION_ATTEMPT_ERROR_CODES)
type SafeSubmissionAttemptErrorCode = typeof SAFE_SUBMISSION_ATTEMPT_ERROR_CODES[number]

function diagnosticSubmissionAttemptErrorCode(value: unknown): null | "other" | SafeSubmissionAttemptErrorCode {
  if (value === null || value === undefined) return null
  return typeof value === "string" && SAFE_SUBMISSION_ATTEMPT_ERROR_CODE_SET.has(value)
    ? value as SafeSubmissionAttemptErrorCode
    : "other"
}

function serviceUrl(value: string | undefined, kind: "postgres" | "redis"): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (!value) {
    if (required) throw new Error(`ApplicationTask full-loop integration requires its disposable ${kind} URL`)
    return null
  }
  const url = new URL(value)
  const valid = kind === "postgres"
    ? process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE === "true" && value === DATABASE_URL
      && url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432"
      && url.username === "postgres" && url.password === "postgres" && url.pathname === "/applymate_agent_brain_ci"
      && !url.search && !url.hash
    : process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" && process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE === "true"
      && value === REDIS_URL && process.env.REDIS_URL === value && url.protocol === "redis:"
      && url.hostname === "127.0.0.1" && url.port === "6379" && url.pathname === "/15"
      && !url.username && !url.password && !url.search && !url.hash
  if (!valid) throw new Error(`ApplicationTask full-loop integration rejects non-dedicated ${kind}`)
  return value
}

const databaseUrl = serviceUrl(process.env.AGENT_RUNTIME_PG_TEST_URL, "postgres")
const redisUrl = serviceUrl(process.env.AGENT_TURN_REDIS_TEST_URL, "redis")
const enabled = databaseUrl !== null && redisUrl !== null
const describeWithServices = enabled ? describe : describe.skip

type Child = ChildProcess & { readonly lines: string[]; readonly errors: string[] }
type FixtureStats = {
  submitCount: number
  blocked: string[]
  requests: string[]
  browserTrace: string[]
  browserProgress: Array<{ event: string; elapsedMs: number; length?: number }>
}
type ApplicationFillExecutorTrace = {
  attemptCount: number | null
  executorInvocationOrdinal: number
  elapsedMs: number
  returned: boolean
  threw: boolean
  statusCompleted: boolean
  statusWaiting: boolean
  statusWaitingForUser: boolean
  statusFailed: boolean
  failureReasonLeaseLost: boolean
  leaseSignalAbortedAtStart: boolean
  leaseSignalAbortedAtEnd: boolean
}
type ApplicationFillCompletionStaleGate = "lease_input_invalid" | "session_scope" | "turn_row_unavailable" | "turn_status_queued" | "turn_status_interrupted" | "turn_status_terminal" | "turn_status_other" | "child_lease_fence" | "application_task_scope"
type ApplicationFillStageTrace = { entryValidation: boolean; waitPersistence: boolean; completion: boolean; accepted: boolean; rejected: boolean; waiting: boolean; completed: boolean; stale: boolean; conflict: boolean; failed: boolean; cancelled: boolean; unavailable: boolean; leaseLost: boolean; signalAborted: boolean; staleGate?: ApplicationFillCompletionStaleGate }
type ApplicationTaskRow = {
  id: string; userId: string; jobId: string; sessionId: string | null; fillTurnId: string | null
  status: string; checkpoint: string | null; question: unknown; confirmedAnswers: unknown
  workerTaskId?: string | null; error?: string | null
}
const workerCwd = resolve(process.cwd(), "../worker")
const fixturePath = resolve(workerCwd, "src/queue/application-task-full-loop.fixture.mjs")
const socketPath = join(tmpdir(), `applymate-${runId}.sock`)
const tlsPaths = ["AGENT_TEST_TLS_CERT_PATH", "AGENT_TEST_TLS_KEY_PATH", "AGENT_TEST_TLS_CA_PATH"] as const
const testDb = new PrismaClient({ datasources: { db: { url: databaseUrl ?? DATABASE_URL } } })
const workerRequire = createRequire(new URL("../../../../../../worker/package.json", import.meta.url))
const { Queue } = workerRequire("bullmq") as { Queue: new (name: string, options: { connection: { host: string; port: number; db: number } }) => {
  getJobs(states: readonly string[], start: number, end: number): Promise<Array<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; getState(): Promise<string>; remove(): Promise<void> }>>
  getJob(id: string): Promise<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; getState(): Promise<string>; remove(): Promise<void> } | undefined>
  add(name: string, data: unknown, options: { jobId: string }): Promise<{ id?: string; getState(): Promise<string> }>
  close(): Promise<void>
  disconnect(): Promise<void>
} }
let site: Child | undefined
let worker: Child | undefined
let applyQueue: InstanceType<typeof Queue> | undefined
let turnQueue: InstanceType<typeof Queue> | undefined
let subagentQueue: InstanceType<typeof Queue> | undefined
let createdUsers: string[] = []
let dbConnected = false
let priorApplicationFillTaskGraph: string | undefined

function checkTlsAndIsolation(): void {
  if (!enabled) return
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.APPLICATION_TASK_FULL_LOOP_EGRESS_ISOLATED !== "true"
    || process.env.CLOAK_PROXY_URL !== "http://127.0.0.1:9443") {
    throw new Error("ApplicationTask full-loop CI isolation contract is missing")
  }
  if (process.platform !== "linux") throw new Error("ApplicationTask full-loop browser fixture requires the isolated Linux CI runner")
  for (const name of tlsPaths) if (!process.env[name]) throw new Error(`${name} is required for browser certificate verification`)
}

async function assertEgressBlocked(): Promise<void> {
  if (!enabled) return
  for (const host of ["1.1.1.1", "2606:4700:4700::1111"]) {
    await new Promise<void>((resolveProbe, rejectProbe) => {
      const socket = connectSocket({ host, port: 443, ...(host.includes(":") ? { family: 6 } : { family: 4 }) })
      const finish = (error?: Error) => { socket.destroy(); error ? rejectProbe(error) : resolveProbe() }
      socket.once("connect", () => finish(new Error(`external egress unexpectedly succeeded for ${host}`)))
      socket.once("error", () => finish())
      socket.setTimeout(2_000, () => finish())
    })
  }
}

function spawnFixture(mode: "site" | "worker"): Child {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode], {
    cwd: workerCwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      REDIS_URL: redisUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_TURN_REDIS_TEST_DISPOSABLE: "true", RUN_AGENT_TURN_REDIS_INTEGRATION: "1",
      CLOAK_PROXY_URL: "http://127.0.0.1:9443", APPLICATION_TASK_FULL_LOOP_SOCKET_PATH: socketPath,
      APPLICATION_TASK_FULL_LOOP_STAGE_OBSERVER_TEST: mode === "worker" ? "true" : "false",
      BULLMQ_STALLED_INTERVAL_MS: "30000",
      ...(mode === "worker" ? { APPLICATION_TASK_FULL_LOOP_USER_ID: ids.user } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as Child
  Object.defineProperties(child, { lines: { value: [] }, errors: { value: [] } })
  for (const [stream, target] of [[child.stdout, child.lines], [child.stderr, child.errors]] as const) {
    let pending = ""
    stream?.setEncoding("utf8")
    stream?.on("data", chunk => {
      pending += String(chunk)
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      target.push(...parts.map(line => line.trim()).filter(Boolean))
    })
  }
  return child
}

function exited(child: Child): boolean { return child.exitCode !== null || child.signalCode !== null }

function childSummary(child: Child) {
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stdoutLineCount: child.lines.length,
    stderrLineCount: child.errors.length,
  }
}

function fixtureStatsSummary(stats: FixtureStats) {
  return {
    submitCount: stats.submitCount,
    blockedCount: stats.blocked.length,
    requestCount: stats.requests.length,
    browserTrace: stats.browserTrace,
    browserProgress: stats.browserProgress,
  }
}

function applicationFillExecutorTraces(child: Child | undefined): Array<ApplicationFillExecutorTrace | { traceInvalid: true }> {
  const prefix = "APPLICATION_FILL_EXEC_TRACE "
  const traces: Array<ApplicationFillExecutorTrace | { traceInvalid: true }> = []
  for (const line of child?.lines ?? []) {
    if (!line.startsWith(prefix)) continue
    try {
      const row = jsonRecord(JSON.parse(line.slice(prefix.length)))
      if (!row) {
        traces.push({ traceInvalid: true })
        continue
      }
      const attemptCount = row.attemptCount
      const executorInvocationOrdinal = row.executorInvocationOrdinal
      const elapsedMs = row.elapsedMs
      const booleans = [row.returned, row.threw, row.statusCompleted, row.statusWaiting, row.statusWaitingForUser,
        row.statusFailed, row.failureReasonLeaseLost, row.leaseSignalAbortedAtStart, row.leaseSignalAbortedAtEnd]
      if (!(attemptCount === null || typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) && attemptCount >= 1)
        || typeof executorInvocationOrdinal !== "number" || !Number.isSafeInteger(executorInvocationOrdinal) || executorInvocationOrdinal < 1
        || typeof elapsedMs !== "number" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0
        || booleans.some(value => typeof value !== "boolean")) {
        traces.push({ traceInvalid: true })
        continue
      }
      traces.push({
        attemptCount, executorInvocationOrdinal, elapsedMs,
        returned: row.returned === true,
        threw: row.threw === true,
        statusCompleted: row.statusCompleted === true,
        statusWaiting: row.statusWaiting === true,
        statusWaitingForUser: row.statusWaitingForUser === true,
        statusFailed: row.statusFailed === true,
        failureReasonLeaseLost: row.failureReasonLeaseLost === true,
        leaseSignalAbortedAtStart: row.leaseSignalAbortedAtStart === true,
        leaseSignalAbortedAtEnd: row.leaseSignalAbortedAtEnd === true,
      })
    } catch {
      traces.push({ traceInvalid: true })
    }
  }
  return traces.slice(-12)
}

function applicationFillStageTraces(child: Child | undefined): Array<ApplicationFillStageTrace | { traceInvalid: true }> {
  const prefix = "APPLICATION_FILL_STAGE_TRACE ", keys = ["entryValidation", "waitPersistence", "completion", "accepted", "rejected", "waiting", "completed", "stale", "conflict", "failed", "cancelled", "unavailable", "leaseLost", "signalAborted"]
  const staleGates = ["lease_input_invalid", "session_scope", "turn_row_unavailable", "turn_status_queued", "turn_status_interrupted", "turn_status_terminal", "turn_status_other", "child_lease_fence", "application_task_scope"]
  const traces: Array<ApplicationFillStageTrace | { traceInvalid: true }> = []
  for (const line of child?.lines ?? []) {
    if (!line.startsWith(prefix)) continue
    try {
      const row = jsonRecord(JSON.parse(line.slice(prefix.length)))
      if (!row) {
        traces.push({ traceInvalid: true })
        continue
      }
      const hasStaleGate = Object.prototype.hasOwnProperty.call(row, "staleGate"), expectedKeys = [...keys, ...(hasStaleGate ? ["staleGate"] : [])]
      if (Object.keys(row).sort().join(",") !== expectedKeys.sort().join(",") || keys.some(key => typeof row[key] !== "boolean")
        || (hasStaleGate && (typeof row.staleGate !== "string" || !staleGates.includes(row.staleGate) || row.completion !== true || row.stale !== true))
        || (row.completion === true && row.stale === true && !hasStaleGate)) {
        traces.push({ traceInvalid: true })
        continue
      }
      traces.push({ ...Object.fromEntries(keys.map(key => [key, row[key] === true])), ...(hasStaleGate ? { staleGate: row.staleGate as ApplicationFillCompletionStaleGate } : {}) } as ApplicationFillStageTrace)
    } catch { traces.push({ traceInvalid: true }) }
  }
  return traces.slice(-24)
}

const APPLICATION_FILL_STALE_GATES: readonly ApplicationFillCompletionStaleGate[] = [
  "lease_input_invalid", "session_scope", "turn_row_unavailable", "turn_status_queued", "turn_status_interrupted",
  "turn_status_terminal", "turn_status_other", "child_lease_fence", "application_task_scope",
]

describe("ApplicationTask full-loop stage trace parser", () => {
  it.each(APPLICATION_FILL_STALE_GATES)("accepts the sanitized %s category", staleGate => {
    const trace: ApplicationFillStageTrace = {
      entryValidation: false, waitPersistence: false, completion: true,
      accepted: false, rejected: false, waiting: false, completed: false, stale: true,
      conflict: false, failed: false, cancelled: false, unavailable: false,
      leaseLost: true, signalAborted: false, staleGate,
    }
    const child = { lines: [`APPLICATION_FILL_STAGE_TRACE ${JSON.stringify(trace)}`] } as unknown as Child
    expect(applicationFillStageTraces(child)).toEqual([trace])
  })

  it("rejects an unlisted stale category", () => {
    const trace = {
      entryValidation: false, waitPersistence: false, completion: true,
      accepted: false, rejected: false, waiting: false, completed: false, stale: true,
      conflict: false, failed: false, cancelled: false, unavailable: false,
      leaseLost: true, signalAborted: false, staleGate: "unlisted_category",
    }
    const child = { lines: [`APPLICATION_FILL_STAGE_TRACE ${JSON.stringify(trace)}`] } as unknown as Child
    expect(applicationFillStageTraces(child)).toEqual([{ traceInvalid: true }])
  })
})

describe("ApplicationTask submit outbox diagnostic classifier", () => {
  it("preserves only fixed allowlisted outbox categories", () => {
    for (const category of SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES) {
      expect(diagnosticSubmitOutboxErrorCategory(category)).toBe(category)
    }
  })

  it("uses none for absent errors and other for unlisted values", () => {
    expect(diagnosticSubmitOutboxErrorCategory(null)).toBe("none")
    expect(diagnosticSubmitOutboxErrorCategory(undefined)).toBe("none")
    expect(diagnosticSubmitOutboxErrorCategory("unlisted_outbox_detail")).toBe("other")
    expect(diagnosticSubmitOutboxErrorCategory("terminal:unlisted_detail")).toBe("other")
    expect(diagnosticSubmitOutboxErrorCategory({ message: "raw error detail" })).toBe("other")
  })
})

describe("ApplicationTask submission attempt diagnostic classifier", () => {
  it("preserves only fixed allowlisted attempt error codes", () => {
    for (const errorCode of SAFE_SUBMISSION_ATTEMPT_ERROR_CODES) {
      expect(diagnosticSubmissionAttemptErrorCode(errorCode)).toBe(errorCode)
    }
  })

  it("uses null for absent errors and other for unlisted values", () => {
    expect(diagnosticSubmissionAttemptErrorCode(null)).toBeNull()
    expect(diagnosticSubmissionAttemptErrorCode(undefined)).toBeNull()
    expect(diagnosticSubmissionAttemptErrorCode("unlisted_attempt_detail")).toBe("other")
    expect(diagnosticSubmissionAttemptErrorCode({ message: "raw error detail" })).toBe("other")
  })
})

async function waitLine(child: Child, expected: string, timeoutMs = 30_000): Promise<string> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const line = child.lines.find(value => value === expected || value.startsWith(`${expected} `))
    if (line) return line
    if (exited(child)) throw new Error(`Fixture exited before ${expected}; child=${JSON.stringify(childSummary(child))}`)
    await delay(25)
  }
  throw new Error(`Fixture line ${expected} missing; child=${JSON.stringify(childSummary(child))}`)
}

async function waitExit(child: Child, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once("exit", () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function stopFixture(child: Child | undefined): Promise<void> {
  if (!child || exited(child)) return
  child.stdin?.write("shutdown\n")
  if (!await waitExit(child, 10_000)) {
    child.kill("SIGKILL")
    await waitExit(child, 1_000)
    throw new Error("Fixture did not shut down cleanly")
  }
  if (child.exitCode !== 0) throw new Error(`Fixture exited with nonzero status; child=${JSON.stringify(childSummary(child))}`)
}

async function signedBearer(userId: string): Promise<string> {
  return new SignJWT({ authVersion: 1 }).setProtectedHeader({ alg: "HS256" })
    .setIssuer(EXTENSION_TOKEN_ISSUER).setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(getAuthJwtSecret())
}

function apiRequest(path: string, token: string, method: "GET" | "PATCH" | "POST", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON API response")
  return value as Record<string, unknown>
}

async function answerResumeFailureCategory(response: Response): Promise<string> {
  try {
    const error = (await jsonResponse(response.clone())).error
    if (typeof error !== "string") return "unclassified"
    switch (error) {
      case "A complete job description is required before materials can be generated.": return "job_description_required"
      case "Application fill materials are unavailable for this task": return "command_preflight_materials_unavailable"
      case "Agent session is no longer waiting for user input": return "session_status_compare_and_set"
      case "Application fill attempt was claimed by another request": return "application_task_claim_compare_and_set"
      case "Application task is not ready to resume after persisted user answers": return "resume_task_not_ready"
      case "Application task is not waiting for persisted form answers": return "resume_answers_not_ready"
      case "The bound fill Turn has no durable form-answer wait": return "resume_wait_missing"
      case "Persist form answers for this wait before resuming": return "resume_answer_event_missing"
      case "The bound fill Turn is not durably waiting for user input": return "resume_turn_not_waiting"
      case "The prior fill Turn still owns an active execution lease": return "resume_turn_lease_active"
      case "The application filler must be durably waiting with no live browser lease": return "resume_filler_not_waiting"
      default: return "unclassified"
    }
  } catch {
    return "invalid_error_response"
  }
}

async function waitForTask(predicate: (task: ApplicationTaskRow) => boolean, timeoutMs = 120_000): Promise<ApplicationTaskRow> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const task = await testDb.applicationTask.findUnique({ where: { id: gateTaskId! } }) as ApplicationTaskRow | null
    if (task && predicate(task)) return task
    if (worker && exited(worker)) throw new Error(`Worker exited while waiting for task state; child=${JSON.stringify(childSummary(worker))}`)
    await delay(100)
  }
  const current = await testDb.applicationTask.findUnique({ where: { id: gateTaskId! } })
  let diagnostics: string
  try { diagnostics = JSON.stringify(await taskRuntimeDiagnostics(current as ApplicationTaskRow | null)) }
  catch { diagnostics = "diagnostics_unavailable" }
  throw new Error(`ApplicationTask state timeout: ${diagnostics}`)
}

async function matchingQueueJobs(queue: InstanceType<typeof Queue> | undefined, field: "turnId" | "taskId", id: string) {
  if (!queue) return []
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1)
  return Promise.all(jobs.filter(job => jsonString(job.data, field) === id).map(async job => ({
    id: job.id ?? null, state: await job.getState(), attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted, stalledCounter: job.stalledCounter,
  })))
}

async function waitForStableTurnQueueJobs(turnId: string, stableMs = 750, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  let signature = ""
  let stableSince = Date.now()
  let latest: Awaited<ReturnType<typeof matchingQueueJobs>> = []
  while (Date.now() < until) {
    const [dispatch, jobs] = await Promise.all([
      testDb.agentOutbox.findUnique({
        where: { idempotencyKey: `turn-dispatch:${turnId}` },
        select: { publishedAt: true },
      }),
      matchingQueueJobs(turnQueue, "turnId", turnId),
    ])
    latest = jobs
    const nextSignature = JSON.stringify([...jobs].sort((left, right) => String(left.id).localeCompare(String(right.id))))
    if (nextSignature !== signature) {
      signature = nextSignature
      stableSince = Date.now()
    } else if (dispatch?.publishedAt && jobs.length > 0 && Date.now() - stableSince >= stableMs) {
      return jobs
    }
    await delay(100)
  }
  throw new Error(`Successor Turn queue publication did not stabilize; turnId=${turnId}; jobs=${JSON.stringify(latest)}`)
}

async function taskRuntimeDiagnostics(task: ApplicationTaskRow | null) {
  const turnId = task?.fillTurnId ?? null
  const taskId = task?.id ?? gateTaskId ?? null
  const [turn, turnDispatch, taskGraph, turnSteps, recentEvents, childDispatches, applicationTaskEvents, submitOutbox, applyJobs, sessionTurns, sessionSubagents, syntheticJob, submissionAttempts] = await Promise.all([
    turnId ? testDb.agentTurn.findUnique({ where: { id: turnId }, select: {
      id: true, source: true, status: true, rootTaskId: true, revision: true, error: true,
      leaseOwnerId: true, leaseExpiresAt: true, startedAt: true, completedAt: true,
    } }) : null,
    turnId ? testDb.agentOutbox.findUnique({ where: { idempotencyKey: `turn-dispatch:${turnId}` }, select: {
      id: true, publishedAt: true, attemptCount: true, lastError: true,
    } }) : null,
    turnId ? testDb.subAgentTask.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { createdAt: "asc" }, select: {
      id: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true, status: true,
      failureReason: true, attemptCount: true, leaseOwner: true, leaseExpiresAt: true, createdAt: true, updatedAt: true,
    } }) : [],
    turnId ? testDb.agentStep.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { ordinal: "asc" }, select: {
      id: true, ordinal: true, status: true, errorCode: true, createdAt: true, completedAt: true,
    } }) : [],
    turnId ? testDb.agentEvent.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { sequence: "desc" }, take: 12, select: {
      sequence: true, type: true, actor: true, taskId: true, itemId: true, correlationId: true, createdAt: true,
    } }) : [],
    testDb.agentOutbox.findMany({ where: { aggregateId: ids.session, topic: "agent.subagent.dispatch" }, orderBy: { createdAt: "asc" }, select: {
      idempotencyKey: true, publishedAt: true, attemptCount: true, lastError: true,
    } }),
    taskId ? testDb.applicationTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: "asc" }, select: {
      id: true, type: true, actor: true, createdAt: true, data: true,
    } }) : [],
    testDb.agentOutbox.findMany({ where: { aggregateId: ids.session, topic: "application.submit.dispatch" }, orderBy: { createdAt: "asc" }, select: {
      idempotencyKey: true, aggregateId: true, payload: true, publishedAt: true, attemptCount: true, lastError: true,
    } }),
    applyQueue ? applyQueue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1) : [],
    testDb.agentTurn.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.job.findUnique({ where: { id: ids.job }, select: { status: true, workflowState: true } }),
    testDb.submissionAttempt.findMany({ where: { userId: ids.user, jobId: ids.job }, orderBy: { createdAt: "asc" }, select: {
      state: true, errorCode: true,
    } }),
  ])
  const [sessionTurnJobs, sessionSubagentJobs] = await Promise.all([
    Promise.all(sessionTurns.map(turnRow => matchingQueueJobs(turnQueue, "turnId", turnRow.id))),
    Promise.all(sessionSubagents.map(taskRow => matchingQueueJobs(subagentQueue, "taskId", taskRow.id))),
  ])
  const ownedApplyJobIds = new Set(submitOutbox.map(row => jsonString(row.payload, "workerTaskId")).filter((id): id is string => Boolean(id)))
  if (task?.workerTaskId) ownedApplyJobIds.add(task.workerTaskId)
  const applyQueueJobs = await Promise.all(applyJobs.filter(job => {
    const applicationTaskId = jsonString(job.data, "applicationTaskId")
    return (Boolean(job.id) && ownedApplyJobIds.has(job.id!)) || (taskId !== null && applicationTaskId === taskId)
  }).map(async job => ({
    id: job.id ?? null, state: await job.getState(), attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted, stalledCounter: job.stalledCounter,
  })))
  const fixtureStats = await requestFixtureStats().then(fixtureStatsSummary).catch(() => ({ errorPresent: true }))
  return {
    task: task ? {
      id: task.id, userId: task.userId, jobId: task.jobId, sessionId: task.sessionId, fillTurnId: turnId,
      status: task.status, checkpoint: task.checkpoint, waitId: jsonRecord(task.question)?.waitId ?? null,
      workerTaskId: task.workerTaskId ?? null, errorPresent: Boolean(task.error),
    } : null,
    syntheticJob: syntheticJob ? { status: syntheticJob.status, workflowState: syntheticJob.workflowState } : null,
    turn: turn ? {
      id: turn.id, source: turn.source, status: turn.status, rootTaskId: turn.rootTaskId, revision: turn.revision,
      errorPresent: Boolean(turn.error), leaseOwnerId: turn.leaseOwnerId, leaseExpiresAt: turn.leaseExpiresAt,
      startedAt: turn.startedAt, completedAt: turn.completedAt,
    } : null,
    turnDispatch: turnDispatch ? {
      id: turnDispatch.id, publishedAt: turnDispatch.publishedAt, attemptCount: turnDispatch.attemptCount,
      lastErrorPresent: Boolean(turnDispatch.lastError),
    } : null,
    turnQueueJobs: sessionTurns.flatMap((turnRow, index) => sessionTurnJobs[index]!.map(job => ({ turnId: turnRow.id, ...job }))),
    taskGraph: taskGraph.map(node => ({
      id: node.id, rootTaskId: node.rootTaskId, parentTaskId: node.parentTaskId, role: node.role, taskType: node.taskType,
      status: node.status, failureReasonCode: diagnosticMachineErrorCode(node.failureReason), attemptCount: node.attemptCount,
      leaseOwner: node.leaseOwner, leaseExpiresAt: node.leaseExpiresAt, createdAt: node.createdAt, updatedAt: node.updatedAt,
    })),
    subagentDispatches: childDispatches.map(({ idempotencyKey, publishedAt, attemptCount, lastError }) => ({
      idempotencyKey, publishedAt, attemptCount, lastErrorPresent: Boolean(lastError),
    })),
    subagentQueueJobs: sessionSubagents.flatMap((taskRow, index) => sessionSubagentJobs[index]!.map(job => ({ taskId: taskRow.id, ...job }))),
    turnSteps: turnSteps.map(step => ({
      id: step.id, ordinal: step.ordinal, status: step.status, errorCode: diagnosticMachineErrorCode(step.errorCode),
      createdAt: step.createdAt, completedAt: step.completedAt,
    })),
    applicationTaskEvents: applicationTaskEvents.map(({ data, ...event }) => {
      const safeData = jsonRecord(data)
      return { ...event, dataKeys: Object.keys(safeData ?? {}).sort(), waitIdPresent: typeof safeData?.waitId === "string" }
    }),
    submitOutbox: submitOutbox.map(({ idempotencyKey, aggregateId, payload, publishedAt, attemptCount, lastError }) => ({
      idempotencyKey, aggregateId, publishedAt, attemptCount,
      workerTaskId: jsonString(payload, "workerTaskId") ?? null,
      payloadKeys: Object.keys(jsonRecord(payload) ?? {}).sort(), lastErrorPresent: Boolean(lastError),
      lastErrorCategory: diagnosticSubmitOutboxErrorCategory(lastError),
    })),
    submissionAttempts: submissionAttempts.map(({ state, errorCode }) => ({
      state, errorCode: diagnosticSubmissionAttemptErrorCode(errorCode),
    })),
    applyQueueJobs,
    sessionTurnIds: sessionTurns.map(turnRow => turnRow.id), sessionSubagentTaskIds: sessionSubagents.map(taskRow => taskRow.id),
    recentEvents: recentEvents.map(event => ({ ...event, sequence: event.sequence.toString() })),
    fixtureStats,
    applicationFillExecutorTraces: applicationFillExecutorTraces(worker),
    applicationFillStageTraces: applicationFillStageTraces(worker),
    workerExited: worker ? exited(worker) : null,
    workerLineCount: worker?.lines.length ?? 0, workerErrorCount: worker?.errors.length ?? 0,
  }
}

let gateTaskId: string | undefined

async function submitQueueJobs() {
  return applyQueue!.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1)
}

async function waitForWorkerRedelivery(child: Child, jobId: string, timeoutMs = 120_000): Promise<string> {
  const prefix = `APPLY_JOB_ACTIVE ${jobId} `
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const redelivery = child.lines.find(line => {
      if (!line.startsWith(prefix)) return false
      const attemptsStarted = Number(/(?:^| )attemptsStarted=(\d+)/.exec(line)?.[1])
      return Number.isFinite(attemptsStarted) && attemptsStarted >= 2
    })
    if (redelivery) return redelivery
    if (exited(child)) throw new Error(`Worker exited before BullMQ redelivered ${jobId}; child=${JSON.stringify(childSummary(child))}`)
    await delay(50)
  }
  const matchingEvents = child.lines.filter(line => line.startsWith(prefix))
  const observedAttempts = matchingEvents.map(line => Number(/(?:^| )attemptsStarted=(\d+)/.exec(line)?.[1]))
    .filter(Number.isFinite)
  const maxAttemptsStarted = observedAttempts.length ? Math.max(...observedAttempts) : null
  throw new Error(`BullMQ did not redeliver ${jobId}; matchingEventCount=${matchingEvents.length}; maxAttemptsStarted=${maxAttemptsStarted}`)
}

function jsonString(value: unknown, key: string): string | undefined {
  const field = jsonRecord(value)?.[key]
  return typeof field === "string" ? field : undefined
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

const ALL_QUEUE_STATES = ["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"] as const
const CLEANUP_DEADLINE_EXCEEDED = "Scoped BullMQ cleanup deadline exceeded"
const queueDisconnects = new WeakMap<object, Promise<void>>()

function beforeDeadline<T>(operation: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) return Promise.reject(new Error(CLEANUP_DEADLINE_EXCEEDED))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(CLEANUP_DEADLINE_EXCEEDED)), remainingMs)
  })
  let pending: Promise<T>
  try {
    pending = operation()
  } catch (error) {
    if (timer) clearTimeout(timer)
    return Promise.reject(error)
  }
  return Promise.race([pending, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function disconnectQueue(queue: InstanceType<typeof Queue>): Promise<void> {
  const existing = queueDisconnects.get(queue)
  if (existing) return existing
  const disconnecting = Promise.resolve().then(() => queue.disconnect()).catch(() => undefined)
  queueDisconnects.set(queue, disconnecting)
  return disconnecting
}

async function queueOperationBeforeDeadline<T>(
  queue: InstanceType<typeof Queue>,
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  try {
    return await beforeDeadline(operation, deadlineAt)
  } catch (error) {
    if (error instanceof Error && error.message === CLEANUP_DEADLINE_EXCEEDED) void disconnectQueue(queue)
    throw error
  }
}

async function closeQueueWithinDeadline(
  queue: InstanceType<typeof Queue> | undefined,
  deadlineAt: number,
): Promise<void> {
  if (!queue) return
  try {
    await queueOperationBeforeDeadline(queue, () => queue.close(), deadlineAt)
  } catch (error) {
    await Promise.race([disconnectQueue(queue), delay(1_000)])
    throw error
  }
}

async function ownedQueueStateSnapshot(): Promise<Array<{ queue: string; id: string; state: string }>> {
  const [turns, subagentTasks, applyJobs, turnJobs, subagentJobs] = await Promise.all([
    testDb.agentTurn.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    applyQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
    turnQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
    subagentQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
  ])
  const turnIds = new Set(turns.map(row => row.id))
  const subagentTaskIds = new Set(subagentTasks.map(row => row.id))
  const owned = [
    { queue: "apply", jobs: applyJobs.filter(job => jsonString(job.data, "applicationTaskId") === gateTaskId) },
    { queue: "turn", jobs: turnJobs.filter(job => {
      const turnId = jsonString(job.data, "turnId")
      return turnId !== undefined && turnIds.has(turnId)
    }) },
    { queue: "subagent", jobs: subagentJobs.filter(job => {
      const taskId = jsonString(job.data, "taskId")
      return taskId !== undefined && subagentTaskIds.has(taskId)
    }) },
  ]
  const snapshots = await Promise.all(owned.flatMap(({ queue, jobs }) => jobs
    .filter((job): job is typeof job & { id: string } => Boolean(job.id))
    .map(async job => ({ queue, id: job.id, state: await job.getState() }))))
  return snapshots.sort((left, right) => left.queue.localeCompare(right.queue) || left.id.localeCompare(right.id))
}

async function waitForStableOwnedQueueState(stableMs = 750, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  let signature: string | undefined
  let stableSince = Date.now()
  let latest: Awaited<ReturnType<typeof ownedQueueStateSnapshot>> = []
  while (Date.now() < until) {
    latest = await ownedQueueStateSnapshot()
    const nextSignature = JSON.stringify(latest)
    if (nextSignature !== signature) {
      signature = nextSignature
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= stableMs) {
      return latest
    }
    await delay(100)
  }
  throw new Error(`Owned BullMQ state did not stabilize; jobCount=${latest.length}`)
}

async function removeScopedQueueJobs(
  queue: InstanceType<typeof Queue> | undefined,
  isOwned: (job: { id?: string; data: unknown }) => boolean,
  deadlineAt: number,
): Promise<void> {
  if (!queue) return
  let pendingJobs = (await queueOperationBeforeDeadline(queue, () => queue.getJobs(ALL_QUEUE_STATES, 0, -1), deadlineAt))
    .filter(job => Boolean(job.id) && isOwned(job))
  while (pendingJobs.length > 0) {
    const results = await Promise.allSettled(pendingJobs.map(job => queueOperationBeforeDeadline(queue, () => job.remove(), deadlineAt)))
    pendingJobs = pendingJobs.filter((_, index) => results[index]?.status === "rejected")
    if (pendingJobs.length === 0) return
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) break
    await delay(Math.min(500, remainingMs))
  }
  if (pendingJobs.length > 0) throw new Error(CLEANUP_DEADLINE_EXCEEDED)
}

async function cleanRunArtifacts(): Promise<void> {
  if (!dbConnected) {
    await unlink(socketPath).catch(() => undefined)
    return
  }
  const [submitOutbox, task, sessionTurns, sessionSubagents] = await Promise.all([
    testDb.agentOutbox.findMany({ where: { aggregateId: ids.session, topic: "application.submit.dispatch" }, select: { payload: true } }),
    gateTaskId ? testDb.applicationTask.findUnique({ where: { id: gateTaskId }, select: { workerTaskId: true } }) : Promise.resolve(null),
    testDb.agentTurn.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
  ])
  const ownedSubmitJobIds = new Set(submitOutbox.map(row => jsonString(row.payload, "workerTaskId")).filter((id): id is string => Boolean(id)))
  if (task?.workerTaskId) ownedSubmitJobIds.add(task.workerTaskId)
  const ownedTurnIds = new Set(sessionTurns.map(turnRow => turnRow.id))
  const ownedSubagentTaskIds = new Set(sessionSubagents.map(taskRow => taskRow.id))
  const queueCleanupDeadline = Date.now() + 20_000
  const queueCleanup = await Promise.allSettled([
    removeScopedQueueJobs(applyQueue, job => {
      const applicationTaskId = jsonString(job.data, "applicationTaskId")
      return Boolean(job.id && ownedSubmitJobIds.has(job.id)) || (gateTaskId !== undefined && applicationTaskId === gateTaskId)
    }, queueCleanupDeadline),
    removeScopedQueueJobs(turnQueue, job => {
      const turnId = jsonString(job.data, "turnId")
      return turnId !== undefined && ownedTurnIds.has(turnId)
    }, queueCleanupDeadline),
    removeScopedQueueJobs(subagentQueue, job => {
      const taskId = jsonString(job.data, "taskId")
      return taskId !== undefined && ownedSubagentTaskIds.has(taskId)
    }, queueCleanupDeadline),
  ])
  const failedQueueCleanup = queueCleanup.some(result => result.status === "rejected")
  await testDb.agentOutbox.deleteMany({ where: { aggregateId: ids.session } })
  if (createdUsers.length) await testDb.user.deleteMany({ where: { id: { in: createdUsers } } })
  await unlink(socketPath).catch(() => undefined)
  if (failedQueueCleanup) throw new Error("Scoped BullMQ cleanup left owned jobs behind")
}

async function assertNoSubmitBeforeApproval(): Promise<void> {
  expect(await submitQueueJobs()).toHaveLength(0)
  const outbox = await testDb.agentOutbox.count({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })
  expect(outbox).toBe(0)
  expect(await requestFixtureStats()).toMatchObject({ submitCount: 0, blocked: [] })
}

describeWithServices("ApplicationTask production full-loop PostgreSQL integration", () => {
  beforeAll(async () => {
    // This fixture creates a TaskGraph-bound fill; exercise the matching production PATCH route.
    priorApplicationFillTaskGraph = process.env.ENABLE_APPLICATION_FILL_TASKGRAPH
    process.env.ENABLE_APPLICATION_FILL_TASKGRAPH = "1"
    checkTlsAndIsolation()
    if (!enabled) return
    await Promise.all(tlsPaths.map(name => access(process.env[name]!)))
    await assertEgressBlocked()
    applyQueue = new Queue("apply-tasks", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    turnQueue = new Queue("agent-turns", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    subagentQueue = new Queue("agent-subagents", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    await testDb.$connect()
    dbConnected = true
    site = spawnFixture("site")
    await waitLine(site, "FIXTURE_READY")
    worker = spawnFixture("worker")
    await waitLine(worker, "WORKER_READY", 90_000)
  }, 120_000)

  afterAll(async () => {
    let cleanupError: unknown
    try { await stopFixture(worker) } catch (error) { cleanupError = error }
    try { await stopFixture(site) } catch (error) { cleanupError ??= error }
    try { await cleanRunArtifacts() } catch (error) { cleanupError ??= error }
    const queueCloseDeadline = Date.now() + 4_000
    try { await closeQueueWithinDeadline(applyQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await closeQueueWithinDeadline(turnQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await closeQueueWithinDeadline(subagentQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await testDb.$disconnect(); dbConnected = false } catch (error) { cleanupError ??= error }
    if (priorApplicationFillTaskGraph === undefined) delete process.env.ENABLE_APPLICATION_FILL_TASKGRAPH
    else process.env.ENABLE_APPLICATION_FILL_TASKGRAPH = priorApplicationFillTaskGraph
    if (cleanupError) throw cleanupError
  }, 60_000)

  it("runs Gate → authenticated form answer → scoped submit approval → durable BullMQ/Worker with uncertain-submit no-replay", async () => {
    onTestFailed(async () => {
      let snapshot: unknown
      try {
        if (dbConnected) {
          const current = gateTaskId
            ? await testDb.applicationTask.findUnique({ where: { id: gateTaskId } }) as ApplicationTaskRow | null
            : null
          snapshot = await taskRuntimeDiagnostics(current)
        } else {
          snapshot = {
            dbConnected,
            fixtureStats: await requestFixtureStats().then(fixtureStatsSummary).catch(() => ({ errorPresent: true })),
            applicationFillExecutorTraces: applicationFillExecutorTraces(worker),
            applicationFillStageTraces: applicationFillStageTraces(worker),
            workerExited: worker ? exited(worker) : null,
            worker: worker ? childSummary(worker) : null,
            site: site ? childSummary(site) : null,
          }
        }
      } catch {
        snapshot = { diagnosticErrorPresent: true }
      }
      process.stderr.write(`APPLICATION_TASK_FULL_LOOP_FAILURE ${JSON.stringify(snapshot)}\n`)
    })
    checkTlsAndIsolation()
    const [{ db }, { runGate }, { AgentCommandService }, { formAnswerKeyForSelector }] = await Promise.all([
      import("@/lib/db"), import("@/lib/agent/stages/gate"),
      import("@/lib/agent/control-plane/commands/agent-command-service"),
      import("../../../../../../worker/src/form-answer-key"),
    ])
    expect(db).toBeDefined()
    const primaryUser = await testDb.user.create({ data: {
      id: ids.user, email: candidateEmail, name: candidateName, plan: "pro",
      phone: "+353000000000", location: "Dublin", personaFields: [
        { key: "firstName", value: "A" }, { key: "lastName", value: "B" },
      ],
    } })
    createdUsers = [primaryUser.id]
    const foreignUser = await testDb.user.create({ data: { id: ids.foreignUser, email: `${ids.foreignUser}@example.test`, name: "Other Candidate", plan: "pro" } })
    createdUsers.push(foreignUser.id)
    const job = await testDb.job.create({ data: {
      id: ids.job, userId: ids.user, company: "ApplyMate Synthetic Fixture Employer", role: "Software Engineer", location: "Dublin",
      url: "https://boards.greenhouse.io/example/jobs/1", description: "Synthetic role description for isolated form-fill testing.", keywords: "TypeScript", score: 92,
      workflowState: "ready_to_apply", status: "saved",
    } })
    const resume = await testDb.resume.create({ data: {
      id: ids.resume, userId: ids.user, name: "Synthetic Resume", isDefault: true,
      content: { basics: { name: candidateName, email: primaryUser.email }, experience: [], education: [], skills: [] },
    } })
    await testDb.agentSession.create({ data: { id: ids.session, userId: ids.user, goal: "Create and safely complete a synthetic job application", status: "running", source: "application_full_loop" } })
    await testDb.agentTurn.create({ data: {
      id: ids.gateTurn, userId: ids.user, sessionId: ids.session, source: "user", status: "waiting_for_approval",
      input: { goal: "Review synthetic application materials" }, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
    } })
    await testDb.agentExecution.create({ data: {
      id: ids.execution, userId: ids.user, sessionId: ids.session, status: "running", checkpoint: "gate", attemptCount: 1,
    } })

    const gateContext: PipelineCtx = {
      userId: ids.user, sessionId: ids.session, turnId: ids.gateTurn, executionAttempt: { id: ids.execution, attemptCount: 1 },
      agentCfg: {
        id: `full-loop-config-${runId}`, userId: ids.user, isRunning: true, dailyLimit: 3, minMatchScore: 70,
        autoApply: false, requireApproval: true, targetLocations: ["Dublin"], targetRoles: ["Software Engineer"],
        excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional",
        useTailoredCV: false, model: "fixture",
      },
      roleConfigs: {} as PipelineCtx["roleConfigs"], resumeText: "Synthetic candidate resume",
      resumeContent: resume.content as unknown as PipelineCtx["resumeContent"], defaultResume: { id: resume.id, name: resume.name, templateId: null,
        templateOptions: null, directionId: null, basicsDetached: false }, aiConfig: { provider: "minimax", model: "fixture" }, autonomous: true,
      signal: new AbortController().signal, emit: () => undefined,
    }
    const gatePackage: ApplicationPackage = {
      job, score: 92, matchedKeywords: ["TypeScript"], missingKeywords: [],
      recommendation: "Strong synthetic match; continue to a user-reviewed fill.",
    }
    const gateResult = await runGate([gatePackage], gateContext)
    expect(gateResult).toBeTruthy()
    const gateTask = await testDb.applicationTask.findUnique({ where: { userId_jobId: { userId: ids.user, jobId: ids.job } } })
    expect(gateTask).toMatchObject({ userId: ids.user, jobId: ids.job, sessionId: ids.session, status: "waiting_for_user", checkpoint: "materials_ready" })
    gateTaskId = gateTask!.id
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId, type: "materials_ready" } })).toBe(1)
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: ids.session, type: "review_application", status: "pending" } })).toBe(1)

    // runGate owns ApplicationTask creation. The synthetic Gate Turn is then explicitly closed before the
    // production command starts the TaskGraph fill; this does not exercise the initial Gate approval route.
    await testDb.agentTurn.update({ where: { id: ids.gateTurn }, data: { status: "completed", completedAt: new Date() } })
    await testDb.agentExecution.update({ where: { id: ids.execution }, data: { status: "completed", completedAt: new Date() } })
    const fillCommand = await new AgentCommandService(db).startApplicationFillForReview({
      sessionId: ids.session, userId: ids.user, applicationTaskId: gateTaskId,
      clientMessageId: `full-loop-fill-${runId}`,
    })
    expect(fillCommand.disposition).toBe("started")
    const firstFillTurnId = fillCommand.turnId
    expect(firstFillTurnId).toBeTruthy()

    const waitingTask = await waitForTask(task => task.status === "waiting_for_user" && task.checkpoint === "form_answer_required")
    expect(waitingTask.id).toBe(gateTaskId)
    expect(waitingTask.fillTurnId).toBe(firstFillTurnId)
    expect((await requestFixtureStats()).requests.filter(request => request === "GET /example/jobs/1").length).toBeGreaterThanOrEqual(2)
    const question = waitingTask.question as { waitId?: unknown; missing?: Array<{ key: string | null; label: string }>; sensitive?: Array<{ key: string | null; label: string }> }
    expect(typeof question.waitId).toBe("string")
    expect(question.waitId).not.toBe("")
    const field = [...(question.missing ?? []), ...(question.sensitive ?? [])].find(value => value.label.includes("authorized to work"))
    expect(field?.key).toBe(formAnswerKeyForSelector("work_authorization", "work_authorization"))
    const formAnswerEvents = await testDb.applicationTaskEvent.findMany({
      where: { taskId: gateTaskId, type: "form_answer_required" },
      select: { id: true, taskId: true, type: true, actor: true, data: true },
    })
    expect(formAnswerEvents).toHaveLength(1)
    expect(formAnswerEvents[0]).toMatchObject({ taskId: gateTaskId, type: "form_answer_required", actor: "worker" })
    const formAnswerEventData = jsonRecord(formAnswerEvents[0]!.data)
    if (formAnswerEventData && Object.prototype.hasOwnProperty.call(formAnswerEventData, "waitId")) {
      expect(formAnswerEventData.waitId).toBe(question.waitId)
    }
    expect(await testDb.agentTurn.findUnique({ where: { id: firstFillTurnId }, select: { status: true } })).toMatchObject({ status: "waiting_for_user" })
    await assertNoSubmitBeforeApproval()

    const ownerToken = await signedBearer(ids.user)
    const foreignToken = await signedBearer(ids.foreignUser)
    const { PATCH: answerApplicationTask } = await import("@/app/api/agent/application-tasks/route")
    const answerPath = "/api/agent/application-tasks"
    const baselineEvents = await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId } })
    const baselineTurns = await testDb.agentTurn.count({ where: { sessionId: ids.session } })
    const queuesBeforeRejectedAnswers = await waitForStableOwnedQueueState()
    const turnDispatchWhere = { aggregateId: ids.session, topic: "agent.turn.dispatch" }
    const turnDispatchSnapshot = () => testDb.agentOutbox.findMany({
      where: turnDispatchWhere,
      orderBy: { createdAt: "asc" },
      select: {
        id: true, aggregateId: true, topic: true, idempotencyKey: true, payload: true,
        publishedAt: true, attemptCount: true, lastError: true, createdAt: true,
      },
    })
    const baselineTurnDispatches = await turnDispatchSnapshot()
    expect(baselineTurnDispatches).toHaveLength(1)
    expect(baselineTurnDispatches[0]).toMatchObject({
      aggregateId: ids.session,
      topic: "agent.turn.dispatch",
      idempotencyKey: `turn-dispatch:${firstFillTurnId}`,
      payload: { turnId: firstFillTurnId, sessionId: ids.session },
      publishedAt: expect.any(Date),
      attemptCount: expect.any(Number),
      lastError: null,
    })
    const taskBeforeRejectedAnswers = await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })
    expect(taskBeforeRejectedAnswers).not.toBeNull()
    const stale = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", {
      id: gateTaskId, action: "answer_and_resume", waitId: `${String(question.waitId)}-stale`, answers: { [field!.key!]: "Yes" },
    }))
    expect(stale.status).toBe(409)
    expect(await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })).toEqual(taskBeforeRejectedAnswers)
    expect(await ownedQueueStateSnapshot()).toEqual(queuesBeforeRejectedAnswers)
    expect(await turnDispatchSnapshot()).toEqual(baselineTurnDispatches)
    const foreign = await answerApplicationTask(apiRequest(answerPath, foreignToken, "PATCH", {
      id: gateTaskId, action: "answer_and_resume", waitId: question.waitId, answers: { [field!.key!]: "Yes" },
    }))
    expect([404, 409]).toContain(foreign.status)
    expect(await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })).toEqual(taskBeforeRejectedAnswers)
    expect(await ownedQueueStateSnapshot()).toEqual(queuesBeforeRejectedAnswers)
    expect(await turnDispatchSnapshot()).toEqual(baselineTurnDispatches)
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId } })).toBe(baselineEvents)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session } })).toBe(baselineTurns)
    expect(await submitQueueJobs()).toHaveLength(0)

    const answerBody = { id: gateTaskId, action: "answer_and_resume", waitId: question.waitId, answers: { [field!.key!]: "Yes" } }
    const answered = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", answerBody))
    const answerFailureCategory = answered.status === 200 ? "none" : await answerResumeFailureCategory(answered)
    expect(answered.status, `answer_resume_error_category=${answerFailureCategory}`).toBe(200)
    const answeredJson = await jsonResponse(answered)
    expect(answeredJson).toMatchObject({ resumed: true })
    const confirmedTask = await waitForTask(task => task.status === "filling" && task.checkpoint === "taskgraph_fill_queued" && task.fillTurnId !== firstFillTurnId)
    const successorTurnId = confirmedTask.fillTurnId!
    expect(confirmedTask.confirmedAnswers).toMatchObject({ [field!.key!]: "Yes" })
    expect(JSON.stringify(await testDb.applicationTaskEvent.findMany({ where: { taskId: gateTaskId, type: "user_answers_confirmed" }, select: { data: true } }))).not.toContain("Yes")
    const duplicate = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", answerBody))
    expect(duplicate.status).toBe(200)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session, id: successorTurnId } })).toBe(1)
    expect(await testDb.agentOutbox.count({ where: { aggregateId: ids.session, topic: "agent.turn.dispatch", idempotencyKey: `turn-dispatch:${successorTurnId}` } })).toBe(1)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session } })).toBe(baselineTurns + 1)
    const successorTurnJobs = await waitForStableTurnQueueJobs(successorTurnId)
    expect(successorTurnJobs).toHaveLength(1)
    expect(successorTurnJobs[0]?.id).toBeTruthy()
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId, type: "user_answers_confirmed" } })).toBe(1)

    const completedTask = await waitForTask(task => task.status === "waiting_for_authorization" && task.checkpoint === "form_filled", 180_000)
    expect(completedTask.id).toBe(gateTaskId)
    expect(completedTask.fillTurnId).toBe(successorTurnId)
    expect((await requestFixtureStats()).browserTrace).toContain("input:first_name")
    expect((await requestFixtureStats()).browserTrace).toContain("input:work_authorization")
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      taskId: gateTaskId, type: "submit_application", status: "pending" } })).toBe(1)
    await assertNoSubmitBeforeApproval()

    const originalTurnJobId = successorTurnJobs[0]?.id
    if (!originalTurnJobId) throw new Error("Successor Turn dispatch is missing its BullMQ job ID")
    const originalTurnCompletion = await waitLine(
      worker!, `TURN_JOB_COMPLETED ${originalTurnJobId} turnId=${successorTurnId}`, 30_000,
    )
    expect(originalTurnCompletion).toContain("status=")
    const originalTurnJob = await turnQueue!.getJob(originalTurnJobId)
    expect(originalTurnJob).toBeDefined()
    expect(await originalTurnJob!.getState()).toBe("completed")

    const turnDispatch = await testDb.agentOutbox.findUniqueOrThrow({
      where: { idempotencyKey: `turn-dispatch:${successorTurnId}` }, select: { payload: true },
    })
    const turnDispatchPayload = jsonRecord(turnDispatch.payload)
    expect(Object.keys(turnDispatchPayload ?? {}).sort()).toEqual(["ownerId", "sessionId", "turnId"])
    if (jsonString(turnDispatchPayload, "turnId") !== successorTurnId
      || jsonString(turnDispatchPayload, "sessionId") !== ids.session
      || !jsonString(turnDispatchPayload, "ownerId")) {
      throw new Error("Successor Turn dispatch payload is incomplete or mismatched")
    }
    const turnBeforeDuplicate = await testDb.agentTurn.findUniqueOrThrow({
      where: { id: successorTurnId },
      select: { status: true, revision: true, leaseOwnerId: true, leaseExpiresAt: true, completedAt: true },
    })
    const taskBeforeDuplicate = await testDb.applicationTask.findUniqueOrThrow({
      where: { id: gateTaskId }, select: { status: true, checkpoint: true, fillTurnId: true },
    })
    const duplicateTurnJobId = `test-duplicate-${successorTurnId}`
    await turnQueue!.add("turn", turnDispatch.payload, { jobId: duplicateTurnJobId })
    const duplicateTurnCompletion = await waitLine(
      worker!, `TURN_JOB_COMPLETED ${duplicateTurnJobId} turnId=${successorTurnId}`, 30_000,
    )
    expect(duplicateTurnCompletion).toContain("status=skipped")
    const duplicateTurnJob = await turnQueue!.getJob(duplicateTurnJobId)
    expect(duplicateTurnJob).toBeDefined()
    expect(await duplicateTurnJob!.getState()).toBe("completed")
    expect(await testDb.agentTurn.findUniqueOrThrow({
      where: { id: successorTurnId },
      select: { status: true, revision: true, leaseOwnerId: true, leaseExpiresAt: true, completedAt: true },
    })).toEqual(turnBeforeDuplicate)
    expect(await testDb.applicationTask.findUniqueOrThrow({
      where: { id: gateTaskId }, select: { status: true, checkpoint: true, fillTurnId: true },
    })).toEqual(taskBeforeDuplicate)
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      taskId: gateTaskId, type: "submit_application", status: "pending" } })).toBe(1)
    await assertNoSubmitBeforeApproval()

    const submitApproval = await testDb.agentApproval.findFirstOrThrow({ where: {
      userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      taskId: gateTaskId, type: "submit_application", status: "pending",
    } })
    expect(submitApproval).toMatchObject({ userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      jobId: ids.job, type: "submit_application", status: "pending" })
    expect(submitApproval.taskId).toBe(gateTaskId)
    expect(submitApproval.payload).toMatchObject({ applicationTaskId: gateTaskId, jobId: ids.job, resumeId: ids.resume })
    const { GET: getApproval } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
    const nonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${ids.session}/approvals/${submitApproval.id}`, ownerToken, "GET"), {
      params: Promise.resolve({ id: ids.session, approvalId: submitApproval.id }),
    })
    expect(nonceResponse.status).toBe(200)
    const nonceBody = await jsonResponse(nonceResponse)
    const receiptNonce = typeof nonceBody.receiptNonce === "string" ? nonceBody.receiptNonce
      : typeof nonceBody.nonce === "string" ? nonceBody.nonce : ""
    expect(receiptNonce.length).toBeGreaterThan(20)
    const { POST: approvalAction } = await import("@/app/api/agent/sessions/[id]/actions/route")
    const actionPath = `/api/agent/sessions/${ids.session}/actions`
    const missingReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved",
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(missingReceipt.status).toBe(428)
    await assertNoSubmitBeforeApproval()
    const invalidReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce: "invalid-fixture-receipt",
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(invalidReceipt.status).toBe(409)
    await assertNoSubmitBeforeApproval()
    const reviewApproval = await testDb.agentApproval.findFirstOrThrow({ where: {
      userId: ids.user, sessionId: ids.session, type: "review_application", status: "pending",
    } })
    const reviewNonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${ids.session}/approvals/${reviewApproval.id}`, ownerToken, "GET"), {
      params: Promise.resolve({ id: ids.session, approvalId: reviewApproval.id }),
    })
    expect(reviewNonceResponse.status).toBe(200)
    const reviewNonceBody = await jsonResponse(reviewNonceResponse)
    const mismatchedReceiptNonce = typeof reviewNonceBody.receiptNonce === "string" ? reviewNonceBody.receiptNonce : ""
    expect(mismatchedReceiptNonce.length).toBeGreaterThan(20)
    const mismatchedReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce: mismatchedReceiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(mismatchedReceipt.status).toBe(409)
    await assertNoSubmitBeforeApproval()
    const expiredApprovalId = `expired-submit-${runId}`
    const expiredAt = new Date(Date.now() - 60_000), expiredReceiptNonce = `expired-submit-receipt-${runId}`
    const expiredNonceHash = await hashApprovalNonce(expiredReceiptNonce)
    const expiredScope: ApprovalScopeInput = { userId: ids.user, sessionId: ids.session, turnId: successorTurnId, jobId: ids.job,
      toolCallId: submitApproval.toolCallId!, action: "submit_application", resourceHash: submitApproval.resourceHash!,
      materialHash: submitApproval.materialHash!, answersHash: submitApproval.answersHash!, revision: submitApproval.revision, expiresAt: expiredAt }
    const expiredScopeHash = await hashApprovalScope(protocolScope(expiredScope, expiredNonceHash))
    await testDb.agentApproval.create({ data: {
      id: expiredApprovalId, sessionId: submitApproval.sessionId, taskId: submitApproval.taskId,
      userId: submitApproval.userId, turnId: submitApproval.turnId, toolCallId: submitApproval.toolCallId,
      jobId: submitApproval.jobId, type: submitApproval.type, status: "pending", title: submitApproval.title,
      body: submitApproval.body, payload: submitApproval.payload as Prisma.InputJsonValue,
      resourceHash: expiredScope.resourceHash, materialHash: expiredScope.materialHash,
      answersHash: expiredScope.answersHash, scopeHash: expiredScopeHash,
      nonceHash: expiredNonceHash, revision: expiredScope.revision, expiresAt: expiredAt,
    } })
    const expiredReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: expiredApprovalId, decision: "approved", receiptNonce: expiredReceiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(expiredReceipt.status).toBe(409)
    await expect(jsonResponse(expiredReceipt)).resolves.toMatchObject({ error: expect.stringContaining("expiry") })
    expect(await testDb.agentApproval.count({ where: { id: submitApproval.id, status: "pending" } })).toBe(1)
    expect(await testDb.agentApproval.count({ where: { id: expiredApprovalId, status: "pending" } })).toBe(1)
    await assertNoSubmitBeforeApproval()
    expect(await testDb.agentOutbox.count({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })).toBe(0)

    const approved = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(approved.status).toBe(200)
    await waitLine(site!, "SUBMIT_REQUEST 1", 120_000)
    const outbox = await testDb.agentOutbox.findMany({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })
    expect(outbox).toHaveLength(1)
    const intent = outbox[0]!.payload as Record<string, unknown>
    expect(intent).toMatchObject({ applicationTaskId: gateTaskId, userId: ids.user, jobId: ids.job,
      sessionId: ids.session, fillTurnId: successorTurnId, receiptId: submitApproval.id })
    const queueJobs = await submitQueueJobs()
    expect(queueJobs).toHaveLength(1)
    const submitJob = queueJobs[0]!
    expect(submitJob.id).toBe(intent.workerTaskId)
    expect(submitJob.data).toMatchObject({ applicationTaskId: gateTaskId, userId: ids.user,
      jobId: ids.job, sessionId: ids.session, fillTurnId: successorTurnId, receiptId: submitApproval.id, operation: "submit" })

    await waitLine(worker!, `APPLY_JOB_ACTIVE ${String(intent.workerTaskId)}`)
    const submitStarted = await waitForTask(task => task.checkpoint === "submission_request_started" || task.checkpoint === "submission_uncertain")
    expect(submitStarted.status).toBe(submitStarted.checkpoint === "submission_request_started" ? "filling" : "waiting_for_user")
    worker!.kill("SIGKILL")
    expect(await waitExit(worker!, 5_000)).toBe(true)
    worker = spawnFixture("worker")
    await waitLine(worker, "WORKER_READY", 90_000)
    const redeliveryEvent = await waitForWorkerRedelivery(worker, String(intent.workerTaskId))
    const fixtureStats = await requestFixtureStats()
    expect(fixtureStats.submitCount).toBe(1)
    expect(fixtureStats.blocked).toEqual([])
    const restartedTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: gateTaskId } })
    expect(["submission_request_started", "submission_uncertain"]).toContain(restartedTask.checkpoint)
    const durableOutbox = await testDb.agentOutbox.findMany({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })
    expect(durableOutbox).toHaveLength(1)
    expect(durableOutbox[0]).toMatchObject({ publishedAt: expect.any(Date) })
    const recoveredJob = await applyQueue!.getJob(String(intent.workerTaskId))
    expect(recoveredJob).toBeDefined()
    expect(await recoveredJob!.getState()).toMatch(/^(failed|completed|waiting|active|delayed)$/)
    expect(recoveredJob!.attemptsStarted).toBeGreaterThanOrEqual(2)
    expect(recoveredJob!.stalledCounter).toBeGreaterThanOrEqual(1)
    expect(redeliveryEvent).toContain(`attemptsStarted=${recoveredJob!.attemptsStarted}`)
    expect(redeliveryEvent).toContain(`stalledCounter=${recoveredJob!.stalledCounter}`)
    expect((await requestFixtureStats()).submitCount).toBe(1)
  }, 300_000)
})

async function requestFixtureStats(): Promise<FixtureStats> {
  if (!site?.stdin) throw new Error("Fixture site is unavailable")
  const previous = site.lines.filter(line => line.startsWith("FIXTURE_STATE ")).length
  site.stdin.write("stats\n")
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    const lines = site.lines.filter(line => line.startsWith("FIXTURE_STATE "))
    if (lines.length > previous) return JSON.parse(lines[lines.length - 1]!.slice("FIXTURE_STATE ".length)) as FixtureStats
    await delay(20)
  }
  throw new Error("Fixture site did not return its request count")
}
