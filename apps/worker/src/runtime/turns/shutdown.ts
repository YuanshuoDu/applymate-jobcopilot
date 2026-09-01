import { interruptTurnLease, releaseTurnLease, type LeasePool } from "./lease.js"
import { TurnExecutionRegistry } from "./turn-queue.js"

export interface ShutdownProcess {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this
  off?(signal: "SIGINT" | "SIGTERM", listener: () => void): this
}

export interface TurnShutdownDependencies {
  pool: LeasePool
  active: TurnExecutionRegistry
  closeQueue: () => Promise<void>
  closeScanner?: () => Promise<void>
}

/**
 * Shutdown ordering is deliberate: stop new dispatch, abort active steps,
 * fence them as interrupted, then let BullMQ finish closing its connections.
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
    await this.dependencies.closeScanner?.()
    const active = this.dependencies.active.values()
    await Promise.all(active.map((execution) => execution.abort().catch(() => undefined)))
    await Promise.all(active.map(async (execution) => {
      const released = await releaseTurnLease(this.dependencies.pool, execution.lease, "interrupted").catch(() => false)
      if (!released) await interruptTurnLease(this.dependencies.pool, execution.lease).catch(() => false)
    }))
    await this.dependencies.closeQueue()
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
