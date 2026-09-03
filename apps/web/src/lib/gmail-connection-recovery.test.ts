import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const appendEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent/session/fact-store', () => ({ appendAgentEventWithOutboxInTransaction: appendEvent }))

import { canRecoverStaleGmailConnection, resumeGmailOAuthWait } from './gmail-connection-recovery'

describe('canRecoverStaleGmailConnection', () => {
  it('recovers a legacy Gmail connection once the matching Google login belongs to the current user', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'demo-user',
      currentUserId: 'real-user',
      googleLoginUserId: 'real-user',
    })).toBe(true)
  })

  it('does not allow another account to take a Gmail connection', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'other-user',
      currentUserId: 'current-user',
      googleLoginUserId: 'other-user',
    })).toBe(false)
  })

  it('allows an explicit transfer after the user authorizes the Gmail OAuth flow', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'old-user',
      currentUserId: 'new-user',
      googleLoginUserId: 'different-google-login',
      transferRequested: true,
    })).toBe(true)
  })

  it('marks the tenant-scoped wait answered and enqueues the origin Turn wakeup', async () => {
    const waitId = 'a'.repeat(32)
    appendEvent.mockResolvedValue({ duplicate: false })
    const tx = {
      agentItem: {
        findFirst: vi.fn().mockResolvedValue({ id: `gmail-oauth:${waitId}`, sessionId: 'session-a', turnId: 'turn-a', status: 'started', content: { oauth: true, waitId, toolCallId: 'call-a' } }),
        update: vi.fn().mockResolvedValue({}),
      },
      agentTurn: { findFirst: vi.fn().mockResolvedValue({ id: 'turn-a', revision: 7, status: 'waiting_for_user' }) },
      agentOutbox: { create: vi.fn().mockResolvedValue({}) },
    }
    const db = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<boolean>) => callback(tx)) } as unknown as PrismaClient
    await expect(resumeGmailOAuthWait(db, { userId: 'user-a', waitId })).resolves.toBe(true)
    expect(tx.agentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `gmail-oauth:${waitId}`, session: { userId: 'user-a' } } }))
    expect(tx.agentItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: expect.objectContaining({ answerAvailable: true, reconnected: true }) }) }))
    expect(tx.agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ topic: 'agent.turn.wakeup', aggregateId: 'session-a', idempotencyKey: `gmail-oauth:${waitId}:wakeup` }) }))
    expect(JSON.stringify(tx.agentOutbox.create.mock.calls)).not.toContain('access-token')
  })
})
