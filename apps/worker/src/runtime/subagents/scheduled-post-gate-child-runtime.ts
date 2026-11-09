import type pg from "pg"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { parseScheduledAuditReport, parseScheduledAuditTaskEnvelope } from "./scheduled-audit-contract.js"
import { parseScheduledPostGateExecuteTaskEnvelope, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, type ScheduledPostGateExecuteOutput } from "./scheduled-post-gate-contract.js"
import { readScheduledPostGateChildContext, type ScheduledPostGateChildContext } from "./scheduled-post-gate-context.js"
import type { ScheduledAuditReport } from "./scheduled-audit-contract.js"
import type { SubagentExecutionResult, SubagentLease } from "./types.js"

const endpoint = "/api/internal/agent-runtime/scheduled-pipeline"
type RuntimeOptions = Readonly<{ pool: Pick<pg.Pool, "connect">; fetcher?: typeof fetch; now?: () => Date }>
type Request = Readonly<{ action: "scheduled_post_gate_execute" | "scheduled_post_gate_audit"; owner: ScheduledPostGateChildContext["owner"];
  handoff: ScheduledPostGateChildContext["handoff"]; attestation: ScheduledPostGateChildContext["attestation"];
  actor: ScheduledPostGateChildContext["actor"]; packageRefs?: readonly string[] }>
type Outcome = Readonly<{ status: "completed"; execute?: ScheduledPostGateExecuteOutput; report?: ScheduledAuditReport }>
  | Readonly<{ status: "blocked"; errorCode: string }>

export function isScheduledPostGateCandidate(task: Pick<SubagentLease, "role" | "taskType">): boolean {
  return task.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE || task.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
}

export function isScheduledPostGateLease(lease: SubagentLease, now = new Date()): boolean {
  const execute = lease.role === SCHEDULED_POST_GATE_EXECUTE_ROLE && lease.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
    && sameJson(lease.expectedOutputSchema, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA)
  const audit = lease.role === SCHEDULED_POST_GATE_AUDIT_ROLE && lease.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
    && sameJson(lease.expectedOutputSchema, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA)
  return (execute || audit) && Boolean(lease.turnId) && lease.parentTaskId === lease.rootTaskId
    && lease.status === "running" && lease.leaseOwner === lease.ownerId && validId(lease.ownerId)
    && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0 && lease.interruptRequestedAt === null
    && lease.leaseExpiresAt instanceof Date && lease.leaseExpiresAt.getTime() > now.getTime()
    && Array.isArray(lease.allowedActions) && Reflect.ownKeys(lease.allowedActions).length === 1 && lease.allowedActions.length === 0
}

export function createScheduledPostGateChildExecutor(options: RuntimeOptions): SubagentExecutor {
  return async ({ lease, continuation }) => {
    const now = options.now?.() ?? new Date()
    if (continuation) return terminal("scheduled_post_gate_continuation_unsupported")
    if (!isScheduledPostGateLease(lease, now)) return terminal("scheduled_post_gate_task_invalid")
    if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_post_gate_cancelled")
    try {
      const context = await loadContext(options.pool, lease, now)
      if (!context) return terminal("scheduled_post_gate_context_invalid")
      if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_post_gate_cancelled")
      const outcome = await postScheduledPostGateTask(requestFor(context), lease.signal, options.fetcher)
      if (outcome.status === "blocked") return terminal(outcome.errorCode)
      if (context.kind === "execute" && outcome.execute) {
        const envelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
          taskGraphVerificationReport: null, structuredResult: outcome.execute }
        return parseScheduledPostGateExecuteTaskEnvelope(envelope, "completed", context.packageRefs)
          ? { status: "completed", result: envelope } : terminal("scheduled_post_gate_execute_result_invalid")
      }
      if (context.kind === "audit" && outcome.report) {
        const envelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
          taskGraphVerificationReport: null, structuredResult: outcome.report }
        return parseScheduledAuditTaskEnvelope(envelope, "completed")
          ? { status: "completed", result: envelope } : terminal("scheduled_post_gate_audit_result_invalid")
      }
      return terminal("scheduled_post_gate_response_invalid")
    } catch (error: unknown) {
      if (lease.signal.aborted) throw lease.signal.reason ?? error
      const code = error instanceof Error ? error.message : ""
      return retryable(code) ? { status: "failed", failureReason: "scheduled_post_gate_handoff_retryable", retryDisposition: "retryable" }
        : { status: "failed", failureReason: "scheduled_post_gate_runtime_failed", retryDisposition: "terminal" }
    }
  }
}

async function loadContext(pool: Pick<pg.Pool, "connect">, lease: SubagentLease, now: Date): Promise<ScheduledPostGateChildContext | null> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const context = await readScheduledPostGateChildContext(client, lease, now)
    await client.query("COMMIT")
    return context
  } catch (error: unknown) {
    try { await client.query("ROLLBACK") } catch { /* keep the original read failure */ }
    throw error
  } finally { client.release() }
}

function requestFor(context: ScheduledPostGateChildContext): Request {
  const shared = { owner: context.owner, handoff: context.handoff, attestation: context.attestation, actor: context.actor }
  return context.kind === "execute" ? { action: "scheduled_post_gate_execute", ...shared, packageRefs: context.packageRefs }
    : { action: "scheduled_post_gate_audit", ...shared }
}

async function postScheduledPostGateTask(input: Request, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<Outcome> {
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim()
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!base || !secret || typeof fetcher !== "function") throw new Error("scheduled_post_gate_handoff_unavailable")
  const url = new URL(`${base.replace(/\/$/, "")}${endpoint}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("scheduled_post_gate_handoff_unavailable")
  const response = await fetcher(url.toString(), { method: "POST", headers: { "content-type": "application/json",
    "x-agent-worker-secret": secret }, body: JSON.stringify(input), cache: "no-store", redirect: "error", signal })
  const payload = record(await response.json())
  if (response.status === 200 && input.action === "scheduled_post_gate_execute"
    && exactKeys(payload, ["status", "structuredResult"]) && payload.status === "completed") {
    const result = exactRecord(payload.structuredResult, ["queued", "failed"])
    const refs = input.packageRefs ?? [], queued = result && stringSubset(result.queued, refs), failed = result && stringSubset(result.failed, refs)
    if (queued && failed && !queued.some(ref => failed.includes(ref))) {
      return { status: "completed", execute: { queued, failed } }
    }
  }
  if (response.status === 200 && input.action === "scheduled_post_gate_audit"
    && exactKeys(payload, ["status", "report"]) && payload.status === "completed") {
    const report = parseScheduledAuditReport(payload.report)
    if (report) return { status: "completed", report }
  }
  if (response.status >= 400 && response.status < 500 && exactKeys(payload, ["status", "errorCode"])
    && payload.status === "blocked" && validId(payload.errorCode)) return { status: "blocked", errorCode: payload.errorCode }
  throw new Error(response.status === 202 ? "scheduled_post_gate_handoff_in_progress"
    : response.status === 200 ? "scheduled_post_gate_response_invalid" : "scheduled_post_gate_handoff_retryable")
}

function stringSubset(value: unknown, allowed: readonly string[]): string[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1
    || !Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
    || value.some(item => !validId(item) || !allowed.includes(item)) || new Set(value).size !== value.length) return null
  return [...value] as string[]
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key))
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  return row && exactKeys(row, keys) ? row : null
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Record<string, unknown> : {} }
  catch { return {} }
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function retryable(code: string): boolean { return ["scheduled_post_gate_handoff_unavailable", "scheduled_post_gate_handoff_in_progress",
  "scheduled_post_gate_handoff_retryable"].includes(code) }
function terminal(code: string): SubagentExecutionResult { return { status: "failed", failureReason: code, retryDisposition: "terminal" } }
