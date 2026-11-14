import { describe, expect, it, vi } from 'vitest'
import {
  AgentComposerTaskAttemptRegistry,
  ComposerTaskAttemptConflictError,
  type ComposerTaskAttemptTarget,
} from './agent-composer-task-attempts'

function accepted(sessionId = 'session-test') {
  return Response.json({ inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '1', sessionId })
}

function messageId(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('Idempotency-Key')
}

describe('AgentComposerTaskAttemptRegistry', () => {
  it('preserves A identity across B acceptance and gives consumed B text a fresh identity', async () => {
    const calls: Array<{ url: string; key: string | null }> = []
    let aStarts = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, key: messageId(init) })
      if (url.endsWith('/session-a/start-objective') && aStarts++ === 0) throw new Error('Network outcome unknown')
      return accepted()
    })
    let nextId = 0
    const registry = new AgentComposerTaskAttemptRegistry({ fetcher, makeClientMessageId: () => `task-${++nextId}` })
    const targetA: ComposerTaskAttemptTarget = { kind: 'selected-session', sessionId: 'session-a' }
    const targetB: ComposerTaskAttemptTarget = { kind: 'selected-session', sessionId: 'session-b' }

    const attemptA = registry.get(targetA, '  Research roles  ')
    await expect(attemptA.start('Research roles', '', 'session-a')).rejects.toThrow('Network outcome unknown')

    const attemptB = registry.get(targetB, 'Write a cover letter')
    await attemptB.start('Write a cover letter', '', 'session-b')
    expect(registry.consume(targetB, 'Write a cover letter')).toBe(true)

    const nextB = registry.get(targetB, 'Write a cover letter')
    await nextB.start('Write a cover letter', '', 'session-b')
    const retryA = registry.get(targetA, 'Research roles')
    await retryA.start('Research roles', '', 'session-a')

    const aKeys = calls.filter(call => call.url.endsWith('/session-a/start-objective')).map(call => call.key)
    const bKeys = calls.filter(call => call.url.endsWith('/session-b/start-objective')).map(call => call.key)
    expect(aKeys).toHaveLength(2)
    expect(aKeys[1]).toBe(aKeys[0])
    expect(bKeys).toHaveLength(2)
    expect(bKeys[0]).not.toBe(bKeys[1])
    expect(aKeys[0]).not.toBe(bKeys[0])
  })

  it('blocks a different draft on a target with an unresolved attempt until explicitly abandoned', async () => {
    const fetcher = vi.fn(async () => { throw new Error('Network outcome unknown') })
    let nextId = 0
    const registry = new AgentComposerTaskAttemptRegistry({ fetcher, makeClientMessageId: () => `task-${++nextId}` })
    const target: ComposerTaskAttemptTarget = { kind: 'selected-session', sessionId: 'session-a' }
    const first = registry.get(target, 'Draft A')

    await expect(first.start('Draft A', '', 'session-a')).rejects.toThrow('Network outcome unknown')
    expect(() => registry.get(target, 'Draft B')).toThrow(ComposerTaskAttemptConflictError)
    expect(fetcher).toHaveBeenCalledTimes(1)

    expect(registry.abandon(target, 'Draft A')).toBe(true)
    const replacement = registry.get(target, 'Draft B')
    await expect(replacement.start('Draft B', '', 'session-a')).rejects.toThrow('Network outcome unknown')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aliases a created new Session so an uncertain start can be retried after reopening it', async () => {
    const calls: Array<{ url: string; key: string | null }> = []
    let starts = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, key: messageId(init) })
      if (url === '/api/agent/sessions') return Response.json({ session: { id: 'session-created' } })
      if (starts++ === 0) throw new Error('Network outcome unknown')
      return accepted('session-created')
    })
    let nextId = 0
    const registry = new AgentComposerTaskAttemptRegistry({ fetcher, makeClientMessageId: () => `task-${++nextId}` })
    const blankTarget: ComposerTaskAttemptTarget = { kind: 'new-session' }
    const selectedTarget: ComposerTaskAttemptTarget = { kind: 'selected-session', sessionId: 'session-created' }
    const blankAttempt = registry.get(blankTarget, 'Create the shortlist')

    await expect(blankAttempt.start('Create the shortlist', '')).rejects.toThrow('Network outcome unknown')
    const reopenedAttempt = registry.get(selectedTarget, 'Create the shortlist')
    expect(reopenedAttempt).toBe(blankAttempt)
    await reopenedAttempt.start('Create the shortlist', '', 'session-created')

    const startKeys = calls.filter(call => call.url.endsWith('/start-objective')).map(call => call.key)
    expect(calls[0]).toMatchObject({ url: '/api/agent/sessions', key: 'task-1' })
    expect(startKeys).toEqual(['task-1', 'task-1'])
    expect(registry.consume(selectedTarget, 'Create the shortlist')).toBe(true)

    const nextAttempt = registry.get(selectedTarget, 'Create the shortlist')
    await nextAttempt.start('Create the shortlist', '', 'session-created')
    const allStartKeys = calls.filter(call => call.url.endsWith('/start-objective')).map(call => call.key)
    expect(allStartKeys[2]).not.toBe(allStartKeys[0])
  })
})
