import { SessionConcurrencyLimiter, type SlotReservation } from "./limiter.js"
import {
  inheritSubagentPolicy,
  normalizeSubagentPolicy,
  SubagentLimitError,
  SubagentLeaseError,
  type SubagentExecutionResult,
  type AtomicSubagentSpawnResult,
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
  interrupted: boolean
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
  supportsAtomicSpawn(): boolean { return typeof this.store.createWithSpawn === "function" }

  async spawnAtomic(spec: SubagentTaskSpec, spawnIdempotencyKey: string): Promise<AtomicSubagentSpawnResult & { atomic: boolean }> {
    const parent = spec.parentTaskId ? await this.store.get(spec.parentTaskId, spec.sessionId) : null
    if (spec.parentTaskId && !parent) throw new Error("Parent task is unavailable")
    const policy = inheritSubagentPolicy(parent ? policyFromTask(parent) : null, spec.policy)
    const createWithSpawn = this.store.createWithSpawn
    if (!createWithSpawn) return { task: await this.store.create({ ...spec, policy }), duplicate: false, atomic: false }
    return { ...(await createWithSpawn.call(this.store, { ...spec, policy, spawnIdempotencyKey })), atomic: true }
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
      controller, slot, timer, lost, resolveLost, failed: false, interrupted: false,
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
        if (error instanceof SubagentLeaseError) {
          if (!active.interrupted) return { taskId: payload.taskId, status: "lease_lost", reason: error.message }
          return await this.finishInterrupted(payload, lease, error)
        }
        result = { status: "failed", failureReason: error instanceof Error ? error.message : "Subagent execution failed" }
      }
      const status = await this.store.finish({
        taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
        attemptCount: lease.attemptCount,
        status: result.status, result: result.result, failureReason: result.failureReason, now: this.now(),
        ...(result.status === "completed" ? { mailboxMessageIds: result.mailboxMessageIds } : {}),
      })
      if (!status) return { taskId: payload.taskId, status: "lease_lost", reason: "Subagent lease was fenced" }
      return { taskId: payload.taskId, status }
    } finally {
      this.dispose(payload.taskId, active)
    }
  }

  async heartbeat(taskId: string, now = this.now()): Promise<boolean> {
    const active = this.active.get(taskId)
    if (!active || active.failed) return false
    const result = await this.store.heartbeat({ taskId, sessionId: active.lease.sessionId, ownerId: active.lease.ownerId, attemptCount: active.lease.attemptCount, now }).catch(() => "lost" as const)
    if (result === "renewed") return true
    this.signalLoss(active, result === "interrupted", new SubagentLeaseError("lost", result === "interrupted" ? "Subagent tree was interrupted" : "Subagent lease renewal was rejected"))
    return false
  }

  async close(taskId: string, sessionId: string): Promise<boolean> {
    const closed = await this.store.close({ taskId, sessionId, now: this.now() })
    const active = this.active.get(taskId)
    if (active) {
      this.signalLoss(active, false, new SubagentLeaseError("lost", "Subagent task was closed"))
      this.dispose(taskId, active)
    }
    return closed
  }

  async interrupt(sessionId: string, rootTaskId: string): Promise<number> {
    const count = await this.store.interruptTree({ sessionId, rootTaskId, now: this.now() })
    for (const active of this.active.values()) {
      if (active.lease.sessionId !== sessionId || active.lease.rootTaskId !== rootTaskId) continue
      this.signalLoss(active, true, new SubagentLeaseError("lost", "Subagent tree was interrupted"))
    }
    return count
  }

  async interruptSubtree(sessionId: string, rootTaskId: string, targetPath: string): Promise<number> {
    const normalizedTargetPath = normalizeTaskPath(targetPath)
    if (!normalizedTargetPath) throw new SubagentLeaseError("not_available", "Scoped subagent interruption target is invalid")
    const interruptSubtree = this.store.interruptSubtree
    if (!interruptSubtree) {
      if (normalizedTargetPath === `/${rootTaskId}`) return this.interrupt(sessionId, rootTaskId)
      throw new SubagentLeaseError("not_available", "Scoped subagent interruption is unavailable")
    }
    const count = await interruptSubtree.call(this.store, { sessionId, rootTaskId, targetPath: normalizedTargetPath, now: this.now() })
    for (const active of this.active.values()) {
      if (active.lease.sessionId !== sessionId || active.lease.rootTaskId !== rootTaskId || !isTaskPathWithin(active.lease.path, normalizedTargetPath)) continue
      this.signalLoss(active, true, new SubagentLeaseError("lost", "Subagent subtree was interrupted"))
    }
    return count
  }

  /** Stop active children and release their leases before Worker resources close. */
  async shutdown(): Promise<void> {
    const active = [...this.active.values()]
    let firstError: unknown
    await Promise.all(active.map(async execution => {
      this.signalLoss(execution, false, new SubagentLeaseError("lost", "Worker shutdown"))
      await this.store.release?.({
        taskId: execution.lease.id, sessionId: execution.lease.sessionId, ownerId: execution.lease.ownerId,
        attemptCount: execution.lease.attemptCount, now: this.now(),
      }).catch(error => { if (firstError === undefined) firstError = error })
      this.dispose(execution.lease.id, execution)
    }))
    if (firstError !== undefined) throw firstError
  }

  async recover(limit = 50): Promise<{ rows: SubagentTaskRecord[]; reclaimed: number; terminal: number }> {
    const rows = await this.store.recoverExpired({ now: this.now(), limit })
    for (const row of rows) {
      const active = this.active.get(row.id)
      if (!active) continue
      this.signalLoss(active, false, new SubagentLeaseError("lost", "Subagent lease recovered by scanner"))
      this.dispose(row.id, active)
    }
    return {
      rows,
      reclaimed: rows.filter(row => row.status === "queued").length,
      terminal: rows.filter(row => row.status !== "queued").length,
    }
  }

  activeCount(sessionId: string): number { return this.limiter.activeCount(sessionId) }

  dispose(taskId: string, expected?: ActiveExecution): void {
    const active = this.active.get(taskId)
    if (!active || (expected && active !== expected)) return
    this.clock.clearInterval(active.timer)
    active.slot.release()
    this.active.delete(taskId)
  }

  private signalLoss(active: ActiveExecution, interrupted: boolean, error: SubagentLeaseError): void {
    if (active.failed) return
    active.interrupted = interrupted
    active.failed = true
    active.controller.abort(error)
    active.resolveLost(error)
  }

  private async finishInterrupted(payload: SubagentJobPayload, lease: SubagentLease, error: SubagentLeaseError): Promise<SubagentRunOutcome> {
    const status = await this.store.finish({
      taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
      attemptCount: lease.attemptCount, status: "failed", failureReason: error.message, now: this.now(),
    })
    if (status !== "interrupted") return { taskId: payload.taskId, status: "lease_lost", reason: status ? "Subagent interruption was fenced" : "Subagent lease was fenced" }
    return { taskId: payload.taskId, status: "interrupted", reason: error.message }
  }
}
function policyFromTask(task: SubagentTaskRecord): SubagentPolicy {
  const budget = task.budgetSnapshot
  const raw = budget && typeof budget === "object" && !Array.isArray(budget)
    ? (budget as Record<string, unknown>).subagentPolicy : undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return normalizeSubagentPolicy()
  return normalizeSubagentPolicy(raw as Partial<SubagentPolicy>)
}
function normalizeTaskPath(path: string): string | null {
  return /^\/[^/%_\\]+(?:\/[^/%_\\]+)*$/.test(path) ? path : null
}

function isTaskPathWithin(path: string, targetPath: string): boolean {
  return path === targetPath || path.startsWith(`${targetPath}/`)
}
