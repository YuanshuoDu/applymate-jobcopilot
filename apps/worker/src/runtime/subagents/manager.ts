import { SessionConcurrencyLimiter, type SlotReservation } from "./limiter.js"
import {
  inheritSubagentPolicy,
  normalizeSubagentPolicy,
  SubagentLimitError,
  SubagentLeaseError,
  type SubagentExecutionResult,
  type SubagentJobPayload,
  type SubagentLease,
  type SubagentPolicy,
  type SubagentStore,
  type SubagentTaskRecord,
  type SubagentTaskSpec,
} from "./types.js"

export interface SubagentClock {
  setInterval(handler: () => void, timeout: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
}

const realClock: SubagentClock = {
  setInterval: (handler, timeout) => setInterval(handler, timeout),
  clearInterval: timer => clearInterval(timer),
}

type ActiveExecution = {
  lease: SubagentLease
  controller: AbortController
  slot: SlotReservation
  timer: ReturnType<typeof setInterval>
  lost: Promise<SubagentLeaseError>
  resolveLost: (error: SubagentLeaseError) => void
  failed: boolean
}

export type SubagentRunOutcome = {
  taskId: string
  status: "completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | "skipped" | "lease_lost"
  reason?: string
}

export class AgentTreeManager {
  private readonly active = new Map<string, ActiveExecution>()
  private readonly limiter: SessionConcurrencyLimiter
  private readonly clock: SubagentClock
  private readonly now: () => Date
  private readonly heartbeatMs: number

  constructor(private readonly store: SubagentStore, options: {
    limiter?: SessionConcurrencyLimiter
    clock?: SubagentClock
    now?: () => Date
    heartbeatMs?: number
  } = {}) {
    this.limiter = options.limiter ?? new SessionConcurrencyLimiter()
    this.clock = options.clock ?? realClock
    this.now = options.now ?? (() => new Date())
    this.heartbeatMs = options.heartbeatMs ?? 20_000
    if (!Number.isInteger(this.heartbeatMs) || this.heartbeatMs < 1) throw new RangeError("Subagent heartbeat must be positive")
  }

  async spawn(spec: SubagentTaskSpec): Promise<SubagentTaskRecord> {
    const parent = spec.parentTaskId ? await this.store.get(spec.parentTaskId, spec.sessionId) : null
    if (spec.parentTaskId && !parent) throw new Error("Parent task is unavailable")
    const policy = inheritSubagentPolicy(parent ? policyFromTask(parent) : null, spec.policy)
    return this.store.create({ ...spec, policy })
  }

  async claim(payload: SubagentJobPayload, now = this.now()): Promise<SubagentLease | null> {
    if (this.active.has(payload.taskId)) return null
    const task = await this.store.get(payload.taskId, payload.sessionId)
    if (!task || task.rootTaskId !== payload.rootTaskId) return null
    const policy = policyFromTask(task)
    const slot = this.limiter.reserve(payload.sessionId, payload.taskId, policy)
    const claimed = await this.store.claim({ ...payload, policy, now }).catch(error => {
      slot.release()
      throw error
    })
    if (!claimed) {
      slot.release()
      const latest = await this.store.get(payload.taskId, payload.sessionId)
      if (latest?.status === "queued") throw new SubagentLimitError("concurrency", "Session subagent concurrency is temporarily full")
      return null
    }
    const controller = new AbortController()
    let resolveLost!: (error: SubagentLeaseError) => void
    const lost = new Promise<SubagentLeaseError>(resolve => { resolveLost = resolve })
    const timer = this.clock.setInterval(() => { void this.heartbeat(payload.taskId) }, this.heartbeatMs)
    const execution: ActiveExecution = {
      lease: { ...claimed, ownerId: payload.ownerId, leaseExpiresAt: claimed.leaseExpiresAt!, signal: controller.signal },
      controller, slot, timer, lost, resolveLost, failed: false,
    }
    this.active.set(payload.taskId, execution)
    return execution.lease
  }

  async run(payload: SubagentJobPayload, execute: (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult>): Promise<SubagentRunOutcome> {
    let lease: SubagentLease | null
    try { lease = await this.claim(payload) } catch (error: unknown) {
      if (error instanceof SubagentLeaseError) return { taskId: payload.taskId, status: "lease_lost", reason: error.message }
      throw error
    }
    if (!lease) return { taskId: payload.taskId, status: "skipped", reason: "not_available" }
    const active = this.active.get(payload.taskId)!
    try {
      let result: SubagentExecutionResult
      try {
        result = await Promise.race([execute({ lease }), active.lost.then(error => { throw error })])
      } catch (error: unknown) {
        if (error instanceof SubagentLeaseError) return { taskId: payload.taskId, status: "lease_lost", reason: error.message }
        result = { status: "failed", failureReason: error instanceof Error ? error.message : "Subagent execution failed" }
      }
      const status = await this.store.finish({
        taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
        status: result.status, result: result.result, failureReason: result.failureReason, now: this.now(),
      })
      if (!status) return { taskId: payload.taskId, status: "lease_lost", reason: "Subagent lease was fenced" }
      return { taskId: payload.taskId, status }
    } finally {
      this.dispose(payload.taskId)
    }
  }

  async heartbeat(taskId: string, now = this.now()): Promise<boolean> {
    const active = this.active.get(taskId)
    if (!active || active.failed) return false
    const result = await this.store.heartbeat({ taskId, sessionId: active.lease.sessionId, ownerId: active.lease.ownerId, now }).catch(() => "lost" as const)
    if (result === "renewed") return true
    active.failed = true
    const error = new SubagentLeaseError("lost", result === "interrupted" ? "Subagent tree was interrupted" : "Subagent lease renewal was rejected")
    active.controller.abort(error)
    active.resolveLost(error)
    return false
  }

  async close(taskId: string, sessionId: string): Promise<boolean> {
    const closed = await this.store.close({ taskId, sessionId, now: this.now() })
    const active = this.active.get(taskId)
    if (active) {
      const error = new SubagentLeaseError("lost", "Subagent task was closed")
      active.controller.abort(error)
      active.resolveLost(error)
      this.dispose(taskId)
    }
    return closed
  }

  async interrupt(sessionId: string, rootTaskId: string): Promise<number> {
    const count = await this.store.interruptTree({ sessionId, rootTaskId, now: this.now() })
    for (const active of this.active.values()) {
      if (active.lease.sessionId !== sessionId || active.lease.rootTaskId !== rootTaskId) continue
      const error = new SubagentLeaseError("lost", "Subagent tree was interrupted")
      active.controller.abort(error)
      active.resolveLost(error)
      this.dispose(active.lease.id)
    }
    return count
  }

  async recover(limit = 50): Promise<{ rows: SubagentTaskRecord[]; reclaimed: number; terminal: number }> {
    const rows = await this.store.recoverExpired({ now: this.now(), limit })
    for (const row of rows) {
      const active = this.active.get(row.id)
      if (!active) continue
      const error = new SubagentLeaseError("lost", "Subagent lease recovered by scanner")
      active.controller.abort(error)
      active.resolveLost(error)
      this.dispose(row.id)
    }
    return {
      rows,
      reclaimed: rows.filter(row => row.status === "queued").length,
      terminal: rows.filter(row => row.status !== "queued").length,
    }
  }

  activeCount(sessionId: string): number { return this.limiter.activeCount(sessionId) }

  dispose(taskId: string): void {
    const active = this.active.get(taskId)
    if (!active) return
    this.clock.clearInterval(active.timer)
    active.slot.release()
    this.active.delete(taskId)
  }

}

function policyFromTask(task: SubagentTaskRecord): SubagentPolicy {
  const budget = task.budgetSnapshot
  const raw = budget && typeof budget === "object" && !Array.isArray(budget)
    ? (budget as Record<string, unknown>).subagentPolicy : undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return normalizeSubagentPolicy()
  return normalizeSubagentPolicy(raw as Partial<SubagentPolicy>)
}
