import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { appendAgentEventWithOutboxInTransaction } from '../../session/fact-store'
import { invalidCommand, sessionControlIdempotencyConflict, sessionNotFound, sessionPaused } from './errors'
import type { ActiveTurn, CommandTransaction } from './transaction'
import type { PauseCommand, ResumeCommand, SessionControlGate, SessionControlOperation, SessionControlResult } from './types'

export interface LockedSession {
  id: string
  controlGate: SessionControlGate
  controlRevision: number
  pausedAt: Date | null
}

export interface ExistingSessionControl {
  id: string
  operation: SessionControlOperation
  fingerprint: string
  previousGate: SessionControlGate
  nextGate: SessionControlGate
  controlRevision: number
  pausedAt: Date | null
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

export function sessionControlEventKey(clientMessageId: string): string {
  return `agent-session-control:${clientMessageId}`
}

export async function lockOpenSession(tx: CommandTransaction, sessionId: string, userId: string): Promise<LockedSession> {
  return lockSession(tx, sessionId, userId)
}

async function lockSession(tx: CommandTransaction, sessionId: string, userId: string): Promise<LockedSession> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id", "controlGate", "controlRevision", "pausedAt" FROM "agent_sessions"
    WHERE "id" = ${sessionId} AND "userId" = ${userId}
      AND "status" NOT IN ('aborted', 'archived')
    FOR UPDATE
  `)
  if (!rows[0]) throw sessionNotFound(sessionId)
  const row = rows[0] as typeof rows[0] & { controlGate?: unknown; controlRevision?: unknown; pausedAt?: unknown }
  if (row.controlGate !== 'open' && row.controlGate !== 'user_paused') throw invalidCommand('Agent session has an invalid control gate')
  const controlRevision = Number(row.controlRevision ?? 0)
  if (!Number.isSafeInteger(controlRevision) || controlRevision < 0) throw invalidCommand('Agent session has an invalid control revision')
  const pausedAt = row.pausedAt === null || row.pausedAt === undefined ? null : row.pausedAt instanceof Date ? row.pausedAt : typeof row.pausedAt === 'string' ? new Date(row.pausedAt) : null
  if (row.pausedAt !== null && row.pausedAt !== undefined && (!pausedAt || Number.isNaN(pausedAt.getTime()))) throw invalidCommand('Agent session has an invalid pause timestamp')
  return { id: row.id, controlGate: row.controlGate, controlRevision, pausedAt }
}

export async function lockAcceptingSession(tx: CommandTransaction, sessionId: string, userId: string): Promise<void> {
  const session = await lockSession(tx, sessionId, userId)
  assertAcceptingSession(session, sessionId)
}

export function assertAcceptingSession(session: LockedSession, sessionId: string): void {
  if (session.controlGate !== 'open') throw sessionPaused(sessionId)
}

export async function lockSessionControl(tx: CommandTransaction, sessionId: string, userId: string): Promise<LockedSession> {
  return lockSession(tx, sessionId, userId)
}

export async function findInProgressTurn(tx: CommandTransaction, sessionId: string, userId: string): Promise<ActiveTurn | null> {
  return tx.agentTurn.findFirst({
    where: { sessionId, userId, status: 'in_progress' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, source: true, status: true, revision: true },
  })
}

export function controlFingerprint(operation: SessionControlOperation, expectedRevision: number | null | undefined): string {
  return `v1:${operation}:${expectedRevision === undefined || expectedRevision === null ? 'none' : expectedRevision}`
}

export async function findExistingSessionControl(
  tx: CommandTransaction,
  sessionId: string,
  clientMessageId: string,
): Promise<ExistingSessionControl | null> {
  const row = await tx.agentSessionControl.findFirst({
    where: { sessionId, clientMessageId },
    select: { id: true, operation: true, fingerprint: true, previousGate: true, nextGate: true, controlRevision: true, pausedAt: true },
  })
  if (!row) return null
  return {
    id: row.id,
    operation: row.operation as SessionControlOperation,
    fingerprint: row.fingerprint,
    previousGate: row.previousGate as SessionControlGate,
    nextGate: row.nextGate as SessionControlGate,
    controlRevision: row.controlRevision,
    pausedAt: row.pausedAt,
  }
}

export async function appendSessionControl(
  tx: CommandTransaction,
  command: PauseCommand | ResumeCommand,
  operation: SessionControlOperation,
  fingerprint: string,
  previousGate: SessionControlGate,
  nextGate: SessionControlGate,
  controlRevision: number,
  pausedAt: Date | null,
): Promise<void> {
  await tx.agentSessionControl.create({
    data: { id: randomUUID(), sessionId: command.sessionId, userId: command.userId, clientMessageId: command.clientMessageId, operation, fingerprint, previousGate, nextGate, controlRevision, pausedAt },
  })
  if (previousGate !== nextGate) {
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: command.sessionId,
      turnId: null,
      itemId: null,
      taskId: null,
      type: operation === 'pause' ? 'session.paused' : 'session.resumed',
      actor: 'system',
      correlationId: command.sessionId,
      causationId: null,
      idempotencyKey: sessionControlEventKey(command.clientMessageId),
      payload: json({ sessionId: command.sessionId, operation, previousGate, nextGate, controlRevision, pausedAt: pausedAt?.toISOString() ?? null }),
      outboxTopic: 'agent.session.event',
    })
  }
}

export function sessionControlResult(
  command: PauseCommand | ResumeCommand,
  operation: SessionControlOperation,
  gate: SessionControlGate,
  controlRevision: number,
  pausedAt: Date | null,
  disposition: SessionControlResult['disposition'],
): SessionControlResult {
  return { sessionId: command.sessionId, operation, controlGate: gate, controlRevision, pausedAt: pausedAt?.toISOString() ?? null, disposition }
}

export function assertSessionControlIdentity(
  existing: ExistingSessionControl,
  operation: SessionControlOperation,
  fingerprint: string,
): void {
  if (existing.operation !== operation || existing.fingerprint !== fingerprint) throw sessionControlIdempotencyConflict()
}
