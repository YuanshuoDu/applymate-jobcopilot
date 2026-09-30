import type pg from "pg"

import { ExternalActionRegistry } from "./external.js"
import { createPgInterruptPersistence } from "./persistence.js"
import {
  RootAbortControllerRegistry,
} from "./registry.js"
import { createPgTerminalEventPort } from "./terminal.js"
import {
  assertInterruptTarget,
  interruptReason,
  type ExternalActionEvidenceResolver,
  type InterruptPersistencePort,
  type InterruptRequestInput,
  type InterruptStopResult,
  type InterruptTarget,
  type TerminalEventPort,
} from "./types.js"

/** Server-owned bridge for the durable Turn scope's child task tree. */
export type TurnSubtreeInterruptPort = {
  interrupt(input: InterruptTarget): Promise<number>
}

export type TurnCancelServiceOptions = {
  readonly persistence: InterruptPersistencePort
  readonly roots: RootAbortControllerRegistry
  readonly terminal: TerminalEventPort
  /** Optional because the Worker can still recover from the durable marker. */
  readonly subtree?: TurnSubtreeInterruptPort
  readonly external?: ExternalActionRegistry
  readonly evidence?: ExternalActionEvidenceResolver
  readonly now?: () => Date
}

export type DurableTurnCancelServiceOptions = Omit<TurnCancelServiceOptions, "persistence" | "terminal" | "roots"> & {
  readonly roots: RootAbortControllerRegistry
}

/** Binds the orchestration service to the existing AgentTurn/AgentEvent database. */
export function createPgTurnCancelService(
  pool: Pick<pg.Pool, "connect">,
  options: DurableTurnCancelServiceOptions,
): TurnCancelService {
  const now = options.now ?? (() => new Date())
  return new TurnCancelService({
    ...options,
    now,
    persistence: createPgInterruptPersistence(pool, now),
    terminal: createPgTerminalEventPort(pool, now),
  })
}

/** Coordinates durable Stop with the process-local cancellation tree. */
export class TurnCancelService {
  private readonly now: () => Date

  constructor(private readonly options: TurnCancelServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async stop(input: InterruptRequestInput): Promise<InterruptStopResult> {
    assertInterruptTarget(input)
    const reason = interruptReason(input.reason)
    const persisted = await this.options.persistence.persist({ ...input, reason, requestedAt: input.requestedAt ?? this.now() })
    const root = this.options.roots.getOrCreate(input)
    const stopped = root.stop(reason)
    // Persistence remains the source of truth. A failed bridge must not turn
    // an accepted Stop into a failed request; child heartbeats/recovery still
    // converge from the durable interrupt marker.
    await Promise.resolve(this.options.subtree?.interrupt({ userId: input.userId, sessionId: input.sessionId, turnId: input.turnId })).catch(() => undefined)
    const externalActions = this.options.external
      ? await this.options.external.reconcile(input, this.options.evidence, this.now())
      : []
    const terminalEvent = await this.options.terminal.append({
      ...input,
      reason,
      payload: {
        reason,
        disposition: persisted.disposition,
        operationCount: stopped.operationCount,
        externalActions: externalActions.map((action) => ({ actionId: action.actionId, resolution: action.resolution })),
      },
    })
    return {
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      disposition: persisted.disposition === "accepted" && stopped.accepted ? "interrupted" : "duplicate",
      terminalEvent,
      externalActions,
    }
  }
}
