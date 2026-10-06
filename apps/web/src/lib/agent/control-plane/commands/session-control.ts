import type { PrismaClient } from "@prisma/client"
import {
  AgentSessionControlCommandSchema, schemaVersion, SessionControlEventPayloadSchema,
  validate, type AgentSessionControlAction, type AgentSessionControlCommand, type SessionControlEventPayload,
} from "@jobcopilot/agent-protocol"

import { appendAgentEventWithOutboxInTransaction } from "../../session/fact-store"
import { AgentCommandError, isUniqueViolation, sessionControlIdempotencyConflict, sessionControlStateConflict, sessionNotFound } from "./errors"
import { findActiveTurn, lockOpenSession, type CommandTransaction } from "./transaction"

const EVENT_BY_ACTION = { pause: "session.pause_requested", resume: "session.resume_requested" } as const
const IDEMPOTENCY_PREFIX = "agent-session-control:"
const PAUSABLE_SESSION_STATES = ["running"] as const

export type AgentSessionControlInput = Omit<AgentSessionControlCommand, "schemaVersion"> & { readonly userId: string }
export type AgentSessionControlResult = Readonly<{
  sessionId: string; turnId: string; action: AgentSessionControlAction; status: "pausing" | "resuming"
  disposition: "requested" | "duplicate"; sequence: string
}>

type ExistingControlEvent = { readonly type: string; readonly sequence: bigint | number | string; readonly payload: unknown }

function validateInput(input: AgentSessionControlInput): void {
  const publicCommand: AgentSessionControlCommand = {
    schemaVersion, clientMessageId: input.clientMessageId, sessionId: input.sessionId, action: input.action,
    expectedTurnId: input.expectedTurnId, expectedRevision: input.expectedRevision,
  }
  if (!validate(AgentSessionControlCommandSchema, publicCommand)) {
    throw new AgentCommandError("invalid_command", "Session control command is invalid", 422)
  }
}

function statusFor(action: AgentSessionControlAction): "pausing" | "resuming" {
  return action === "pause" ? "pausing" : "resuming"
}

function eventResult(command: AgentSessionControlInput, event: ExistingControlEvent, disposition: "requested" | "duplicate"): AgentSessionControlResult {
  return { sessionId: command.sessionId, turnId: command.expectedTurnId, action: command.action, status: statusFor(command.action),
    disposition, sequence: String(event.sequence) }
}

async function existingResult(tx: CommandTransaction, command: AgentSessionControlInput, idempotencyKey: string): Promise<AgentSessionControlResult | null> {
  const existing = await tx.agentEvent.findFirst({
    where: { sessionId: command.sessionId, idempotencyKey }, select: { type: true, sequence: true, payload: true },
  }) as ExistingControlEvent | null
  if (!existing) return null
  if (existing.type !== EVENT_BY_ACTION[command.action] || !validate(SessionControlEventPayloadSchema, existing.payload)) {
    throw sessionControlIdempotencyConflict()
  }
  const payload = existing.payload as SessionControlEventPayload
  if (payload.turnId !== command.expectedTurnId || payload.expectedRevision !== command.expectedRevision) {
    throw sessionControlIdempotencyConflict()
  }
  return eventResult(command, existing, "duplicate")
}

function assertCurrentTurn(command: AgentSessionControlInput, active: Awaited<ReturnType<typeof findActiveTurn>>): asserts active {
  if (!active || active.id !== command.expectedTurnId || active.revision !== command.expectedRevision) {
    throw new AgentCommandError("active_turn_changed", "The active Turn or revision changed before session control was accepted", 409, {
      expectedTurnId: command.expectedTurnId, actualTurnId: active?.id ?? null,
      expectedRevision: command.expectedRevision, actualRevision: active?.revision ?? null,
    })
  }
}

function assertActionAllowed(action: AgentSessionControlAction, status: string): void {
  if (action === "pause" && !PAUSABLE_SESSION_STATES.includes(status as typeof PAUSABLE_SESSION_STATES[number])) {
    throw sessionControlStateConflict(action, status)
  }
  if (action === "resume" && status !== "paused") throw sessionControlStateConflict(action, status)
}

async function controlInTransaction(tx: CommandTransaction, command: AgentSessionControlInput, now: Date): Promise<AgentSessionControlResult> {
  await lockOpenSession(tx, command.sessionId, command.userId)
  const idempotencyKey = `${IDEMPOTENCY_PREFIX}${command.clientMessageId}`
  const duplicate = await existingResult(tx, command, idempotencyKey)
  if (duplicate) return duplicate

  const session = await tx.agentSession.findFirst({ where: { id: command.sessionId, userId: command.userId }, select: { status: true } })
  if (!session) throw sessionNotFound(command.sessionId)
  const active = await findActiveTurn(tx, command.sessionId, command.userId)
  assertCurrentTurn(command, active)
  assertActionAllowed(command.action, session.status)

  const nextStatus = statusFor(command.action)
  const changed = await tx.agentSession.updateMany({
    where: { id: command.sessionId, userId: command.userId, status: session.status }, data: { status: nextStatus },
  })
  if (changed.count !== 1) throw sessionControlStateConflict(command.action, session.status)

  const payload: SessionControlEventPayload = {
    turnId: active.id, expectedRevision: command.expectedRevision, requestedAt: now.toISOString(),
  }
  const { event } = await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: command.sessionId, turnId: active.id, itemId: null, taskId: null,
    type: EVENT_BY_ACTION[command.action], actor: "user", correlationId: active.id, causationId: null,
    idempotencyKey, payload, outboxTopic: "agent.session.event",
  })
  return eventResult(command, event, "requested")
}

export class AgentSessionControlService {
  constructor(private readonly db: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  async control(command: AgentSessionControlInput): Promise<AgentSessionControlResult> {
    validateInput(command)
    try {
      return await this.db.$transaction(tx => controlInTransaction(tx, command, this.now()))
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return this.db.$transaction(tx => controlInTransaction(tx, command, this.now()))
    }
  }
}
