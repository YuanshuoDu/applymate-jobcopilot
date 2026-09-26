import { expireTurnLease, releaseTurnLease, type LeasePool } from "./lease.js"
import { TurnExecutionRegistry } from "./turn-queue.js"

export interface ShutdownProcess {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this
  off?(signal: "SIGINT" | "SIGTERM", listener: () => void): this
}

export interface TurnShutdownDependencies {
  pool: LeasePool
  active: TurnExecutionRegistry
  /** Pause intake without waiting for active jobs; they are aborted below. */
  stopIntake?: () => Promise<void>
  closeQueue: () => Promise<void>
  closeScanner?: () => Promise<void>
}

/**
 * Shutdown ordering is deliberate: stop new dispatch, abort active steps,
 * requeue their leases for a later recovery scan, then close BullMQ resources.
 */
export class TurnShutdownController {
  private closing: Promise<void> | null = null

  constructor(private readonly dependencies: TurnShutdownDependencies) {}

  shutdown(signal = "SIGTERM"): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.run(signal)
    return this.closing
  }

  private async run(signal: string): Promise<void> {
    console.log(`[turn-shutdown] received ${signal}`)
    let firstError: unknown
    try { await this.dependencies.stopIntake?.() } catch (error: unknown) { firstError = error }
    try { await this.dependencies.closeScanner?.() } catch (error: unknown) { if (firstError === undefined) firstError = error }
    const active = this.dependencies.active.values()
    await Promise.all(active.map((execution) => execution.abort().catch(() => undefined)))
    await Promise.all(active.map(async (execution) => {
      const released = await releaseTurnLease(this.dependencies.pool, execution.lease, "queued").catch(() => false)
      if (!released) await expireTurnLease(this.dependencies.pool, execution.lease).catch(() => false)
    }))
    try { await this.dependencies.closeQueue() } catch (error: unknown) { if (firstError === undefined) firstError = error }
    if (firstError !== undefined) throw firstError
  }
}

export function registerTurnShutdown(
  processLike: ShutdownProcess,
  controller: TurnShutdownController,
): () => void {
  const handler = () => { void controller.shutdown() }
  processLike.on("SIGINT", handler)
  processLike.on("SIGTERM", handler)
  return () => {
    processLike.off?.("SIGINT", handler)
    processLike.off?.("SIGTERM", handler)
  }
}
