import type pg from "pg"

import type { AgentTreeManager } from "../runtime/subagents/manager.js"
import type {
  createSubagentQueue,
  startSubagentRecoveryScanner,
  SubagentExecutor,
  SubagentQueueLike,
} from "./subagent-queue.js"
import type {
  createTurnQueue,
  TurnExecutor,
} from "../runtime/turns/turn-queue.js"
import type { startTurnRecoveryScanner, TurnDispatchQueue } from "../runtime/turns/recovery-scanner.js"
import type { RootAbortControllerRegistry } from "../runtime/interrupt/registry.js"
import { TurnShutdownController } from "../runtime/turns/shutdown.js"
import { createPgDurableWaitPort } from "../runtime/subagents/durable-wait-store.js"

type LeasePool = Pick<pg.Pool, "connect">

/** Runtime resources owned by the Worker process for canonical execution. */
export interface CanonicalTurnRuntime {
  readonly execute: TurnExecutor
  readonly manager: AgentTreeManager
  close(): Promise<void>
}

type TurnConsumer = ReturnType<typeof createTurnQueue>
type TurnConsumerFactory = (options: Parameters<typeof createTurnQueue>[0]) => TurnConsumer
type TurnRecovery = ReturnType<typeof startTurnRecoveryScanner>
type TurnRecoveryFactory = (
  pool: LeasePool,
  queue: TurnDispatchQueue,
  ownerId?: string,
  intervalMs?: number,
) => TurnRecovery
type SubagentConsumer = ReturnType<typeof createSubagentQueue>
type SubagentConsumerFactory = (options: Parameters<typeof createSubagentQueue>[0]) => SubagentConsumer
type SubagentRecovery = ReturnType<typeof startSubagentRecoveryScanner>
type SubagentRecoveryFactory = (
  pool: LeasePool,
  queue: SubagentQueueLike,
  manager: AgentTreeManager,
  intervalMs?: number,
) => SubagentRecovery

export interface ProductionBootstrapOptions {
  readonly pool: LeasePool
  readonly runtime: CanonicalTurnRuntime
  readonly ownerId?: string
  readonly turnRecoveryIntervalMs?: number
  readonly interrupts?: RootAbortControllerRegistry
  readonly turnQueueFactory?: TurnConsumerFactory
  readonly turnRecoveryFactory?: TurnRecoveryFactory
  /** Child execution is intentionally opt-in until its production executor is bound. */
  readonly subagents?: {
    readonly execute: SubagentExecutor
    readonly intervalMs?: number
    readonly queueFactory?: SubagentConsumerFactory
    readonly recoveryFactory?: SubagentRecoveryFactory
    readonly queue?: SubagentQueueLike
  }
}

export interface ProductionWorkerBootstrap {
  readonly runtime: CanonicalTurnRuntime
  readonly turns: TurnConsumer
  readonly turnRecovery: TurnRecovery
  readonly subagents?: {
    readonly queue: SubagentConsumer
    readonly recovery: SubagentRecovery
  }
  close(): Promise<void>
}

/** Close every owned resource and report the first failure after cleanup. */
async function closeAll(resources: ReadonlyArray<(() => Promise<void>) | undefined>): Promise<void> {
  let firstError: unknown
  for (const close of resources) {
    if (!close) continue
    try {
      await close()
    } catch (error: unknown) {
      if (firstError === undefined) firstError = error
    }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Assemble the same canonical consumers used by Worker startup. The runtime
 * factory is kept outside this module so tests can inject a deterministic
 * model/tool runtime without importing provider credentials.
 */
export async function createProductionWorkerBootstrap(
  options: ProductionBootstrapOptions,
): Promise<ProductionWorkerBootstrap> {
  let turnFactory = options.turnQueueFactory
  let recoveryFactory = options.turnRecoveryFactory
  let turns: TurnConsumer | null = null
  let turnRecovery: TurnRecovery | null = null
  let subagentConsumer: SubagentConsumer | null = null
  let subagentRecovery: SubagentRecovery | null = null
  try {
    if (!turnFactory) turnFactory = (await import("../runtime/turns/turn-queue.js")).createTurnQueue
    if (!recoveryFactory) recoveryFactory = (await import("../runtime/turns/recovery-scanner.js")).startTurnRecoveryScanner
    // Keep construction inside the cleanup boundary. Queue constructors can
    // allocate a BullMQ worker before throwing (for example on bad Redis
    // configuration), and the canonical runtime still owns its resources.
    turns = turnFactory({
      pool: options.pool,
      execute: options.runtime.execute,
      interrupts: options.interrupts,
      waitHandoff: async input => {
        await createPgDurableWaitPort(options.pool).suspendAndRelease(input)
      },
    })
    turnRecovery = recoveryFactory(options.pool, turns.queue, options.ownerId, options.turnRecoveryIntervalMs)

    if (options.subagents) {
      const subagentModule = options.subagents.queueFactory && options.subagents.recoveryFactory
        ? null
        : await import("./subagent-queue.js")
      const subagentFactory = options.subagents.queueFactory ?? subagentModule!.createSubagentQueue
      const childQueue = subagentFactory({
        manager: options.runtime.manager,
        execute: options.subagents.execute,
        queue: options.subagents.queue,
      })
      subagentConsumer = childQueue
      const childRecoveryFactory = options.subagents.recoveryFactory ?? subagentModule!.startSubagentRecoveryScanner
      subagentRecovery = childRecoveryFactory(
        options.pool,
        childQueue.queue,
        options.runtime.manager,
        options.subagents.intervalMs,
      )
    }

    const createdTurns = turns
    const createdTurnRecovery = turnRecovery
    const turnShutdown = new TurnShutdownController({
      pool: options.pool,
      active: createdTurns.active,
      stopIntake: async () => { await createdTurns.worker.pause?.(true) },
      closeQueue: () => createdTurns.close(),
      closeScanner: () => createdTurnRecovery.close(),
    })
    let closed = false
    return {
      runtime: options.runtime,
      turns: createdTurns,
      turnRecovery,
      ...(subagentConsumer && subagentRecovery ? { subagents: { queue: subagentConsumer, recovery: subagentRecovery } } : {}),
      async close() {
        if (closed) return
        closed = true
        await closeAll([
          subagentConsumer ? async () => { await subagentConsumer!.worker.pause?.(true) } : undefined,
          subagentRecovery ? () => subagentRecovery!.close() : undefined,
          () => turnShutdown.shutdown("worker_close"),
          () => options.runtime.manager.shutdown(),
          subagentConsumer ? () => subagentConsumer!.close() : undefined,
          () => options.runtime.close(),
        ])
      },
    }
  } catch (error: unknown) {
    await closeAll([
      subagentConsumer ? async () => { await subagentConsumer!.worker.pause?.(true) } : undefined,
      subagentRecovery ? () => subagentRecovery!.close() : undefined,
      turns ? () => options.runtime.manager.shutdown() : undefined,
      turnRecovery ? () => turnRecovery!.close() : undefined,
      subagentConsumer ? () => subagentConsumer!.close() : undefined,
      turns ? () => turns!.close() : undefined,
      () => options.runtime.close(),
    ]).catch(() => undefined)
    throw error
  }
}
