import {
  expireTurnLease,
  renewTurnLease,
  TURN_HEARTBEAT_INTERVAL_MS,
  type LeasePool,
  type TurnLease,
} from "./lease.js"
import { TurnLeaseError } from "./lease.js"

export interface HeartbeatClock {
  setInterval(handler: () => void, timeout: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
}

export interface TurnHeartbeatOptions {
  pool?: LeasePool
  intervalMs?: number
  now?: () => Date
  renew?: (lease: TurnLease, now: Date) => Promise<TurnLease | null>
  expire?: (lease: TurnLease, now: Date) => Promise<boolean>
  clock?: HeartbeatClock
  onLost?: (error: TurnLeaseError) => void | Promise<void>
}

const realClock: HeartbeatClock = {
  setInterval: (handler, timeout) => setInterval(handler, timeout),
  clearInterval: (timer) => clearInterval(timer),
}

/**
 * Renews a fencing lease independently of the model loop. A missed renewal
 * aborts the consumer and expires the DB lease so a later scan can reclaim it.
 */
export class TurnHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private stopped = false
  private failure: TurnLeaseError | null = null
  private readonly failurePromise: Promise<TurnLeaseError>
  private resolveFailure!: (error: TurnLeaseError) => void
  private readonly controller = new AbortController()
  private readonly now: () => Date
  private readonly renew: (lease: TurnLease, now: Date) => Promise<TurnLease | null>
  private readonly expire: (lease: TurnLease, now: Date) => Promise<boolean>
  private readonly clock: HeartbeatClock
  private readonly onLost: (error: TurnLeaseError) => void | Promise<void>

  constructor(private lease: TurnLease, options: TurnHeartbeatOptions = {}) {
    if (options.intervalMs !== undefined && (!Number.isInteger(options.intervalMs) || options.intervalMs < 1)) {
      throw new RangeError("Heartbeat interval must be a positive integer")
    }
    if (!options.renew && !options.pool) throw new TypeError("Heartbeat requires a lease pool or renew function")
    this.now = options.now ?? (() => new Date())
    this.renew = options.renew ?? ((current, now) => renewTurnLease(options.pool!, current, now))
    this.expire = options.expire ?? ((current, now) => expireTurnLease(options.pool!, current, now))
    this.clock = options.clock ?? realClock
    this.onLost = options.onLost ?? (() => undefined)
    this.failurePromise = new Promise<TurnLeaseError>((resolve) => { this.resolveFailure = resolve })
    this.intervalMs = options.intervalMs ?? TURN_HEARTBEAT_INTERVAL_MS
  }

  private readonly intervalMs: number

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = this.clock.setInterval(() => { void this.beat() }, this.intervalMs)
  }

  async beat(): Promise<boolean> {
    if (this.stopped || this.failure || this.inFlight) return !this.failure
    this.inFlight = true
    const now = this.now()
    try {
      const renewed = await this.renew(this.lease, now)
      if (!renewed) {
        await this.lose(new TurnLeaseError("lease_lost", "Turn lease renewal was rejected"), now)
        return false
      }
      this.lease = renewed
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Turn lease renewal failed"
      await this.lose(new TurnLeaseError("lease_lost", message), now)
      return false
    } finally {
      this.inFlight = false
    }
  }

  private async lose(error: TurnLeaseError, now: Date): Promise<void> {
    if (this.failure || this.stopped) return
    this.failure = error
    this.controller.abort(error)
    await this.expire(this.lease, now).catch(() => undefined)
    this.resolveFailure(error)
    await this.onLost(error)
  }

  get signal(): AbortSignal { return this.controller.signal }
  get currentLease(): TurnLease { return this.lease }
  get lost(): Promise<TurnLeaseError> { return this.failurePromise }
  get lostError(): TurnLeaseError | null { return this.failure }

  async abort(reason = "Turn heartbeat aborted", expire = false): Promise<void> {
    if (this.failure || this.stopped) return
    const error = new TurnLeaseError("lease_lost", reason)
    this.failure = error
    this.controller.abort(error)
    if (expire) await this.expire(this.lease, this.now()).catch(() => undefined)
    this.resolveFailure(error)
    await this.onLost(error)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.clock.clearInterval(this.timer)
    this.timer = null
  }
}
