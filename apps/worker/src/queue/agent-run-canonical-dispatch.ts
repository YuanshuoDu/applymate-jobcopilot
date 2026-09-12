import { Queue } from "bullmq"

import { getPool } from "../db/apply-results.js"
import { redisConnection } from "../redis.js"
import { enqueueTurn, TURN_QUEUE_NAME } from "../runtime/turns/turn-queue.js"
import type { LeasePool, TurnJobPayload } from "../runtime/turns/lease.js"
import type { TurnDispatchQueue } from "../runtime/turns/recovery-scanner.js"

export type AgentRunCanonicalRequest = {
  readonly sessionId: string
  readonly turnId: string
}

export interface AgentRunCanonicalProducer {
  enqueue(request: AgentRunCanonicalRequest): Promise<void>
  close(): Promise<void>
}

type ClosableTurnQueue = TurnDispatchQueue & { close?(): Promise<void> }

function ownerId(turnId: string): string {
  // The execution ID is caller supplied and must not influence canonical ownership.
  return `agent-run:${turnId}`
}

function payload(request: AgentRunCanonicalRequest): TurnJobPayload {
  return {
    turnId: request.turnId,
    sessionId: request.sessionId,
    ownerId: ownerId(request.turnId),
  }
}

export function createAgentRunCanonicalProducer(options: {
  pool?: LeasePool
  queue?: ClosableTurnQueue
} = {}): AgentRunCanonicalProducer {
  const pool = options.pool ?? getPool()
  const queue = options.queue ?? new Queue<TurnJobPayload>(TURN_QUEUE_NAME, { connection: redisConnection, skipVersionCheck: true })
  let closed = false

  return {
    async enqueue(request) {
      if (closed) throw new Error("canonical_agent_run_dispatch_closed")
      await enqueueTurn(pool, queue, payload(request))
    },
    async close() {
      if (closed) return
      closed = true
      await queue.close?.()
    },
  }
}
