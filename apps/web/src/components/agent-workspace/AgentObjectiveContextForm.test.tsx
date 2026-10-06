import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentObjectiveContextForm,
  createObjectiveStartFlowMemory,
  createSessionForObjective,
  invalidateObjectiveStartIdentity,
  submitObjectiveStartFlow,
} from './AgentObjectiveContextForm'
import type { ObjectiveStartDraft } from './AgentObjectiveContextForm'

const draft: ObjectiveStartDraft = { objective: '  Find backend roles in Dublin  ', background: 'Detailed notes\nremain unchanged.' }

describe('AgentObjectiveContextForm', () => {
  it('renders separate objective and supporting-context fields without attachment controls', () => {
    const html = renderToStaticMarkup(<AgentObjectiveContextForm
      onClose={vi.fn()} onSessionRecorded={vi.fn()} acquireAdmission={() => true} releaseAdmission={vi.fn()} onBusyChange={vi.fn()}
    />)
    expect(html).toContain('objective-context-objective')
    expect(html).toContain('objective-context-background')
    expect(html).toContain('Task objective')
    expect(html).toContain('Supporting context')
    expect(html).toContain('does not change an existing run')
    expect(html).not.toContain('resume')
    expect(html).not.toContain('attachment')
  })

  it('creates one Session and reuses its identity and key after an uncertain command result', async () => {
    const memory = createObjectiveStartFlowMemory()
    const createSession = vi.fn(async () => 'session-1')
    const startCommand = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ inputId: 'input-1', turnId: 'turn-1', disposition: 'duplicate', sequence: '8' })
    const newClientMessageId = vi.fn(() => 'message-key-1')
    const dependencies = { createSession, startCommand, onAccepted: vi.fn(), newClientMessageId }

    await expect(submitObjectiveStartFlow(memory, draft, dependencies)).rejects.toThrow('connection lost')
    expect(memory.sessionId).toBe('session-1')
    await expect(submitObjectiveStartFlow(memory, draft, dependencies)).resolves.toMatchObject({ accepted: true })

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(startCommand).toHaveBeenCalledTimes(2)
    expect(startCommand.mock.calls[0]?.[0]).toEqual(startCommand.mock.calls[1]?.[0])
    expect(startCommand.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1', clientMessageId: 'message-key-1', objective: 'Find backend roles in Dublin',
      content: [{ type: 'text', text: draft.background }],
    })
    expect(newClientMessageId).toHaveBeenCalledTimes(1)
    expect(dependencies.onAccepted).toHaveBeenCalledWith('session-1', 'Find backend roles in Dublin')
  })

  it('uses the objective as content only when background is empty and changes key after an edit', async () => {
    const memory = createObjectiveStartFlowMemory()
    const createSession = vi.fn(async () => 'session-1')
    const startCommand = vi.fn().mockRejectedValue(new Error('unknown result'))
    let sequence = 0
    const dependencies = { createSession, startCommand, onAccepted: vi.fn(), newClientMessageId: () => `key-${++sequence}` }
    await expect(submitObjectiveStartFlow(memory, { objective: 'First task', background: '' }, dependencies)).rejects.toThrow()
    await expect(submitObjectiveStartFlow(memory, { objective: 'Second task', background: '  notes  ' }, dependencies)).rejects.toThrow()

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(startCommand.mock.calls.map(call => call[0])).toEqual([
      { sessionId: 'session-1', clientMessageId: 'key-1', objective: 'First task', content: [{ type: 'text', text: 'First task' }] },
      { sessionId: 'session-1', clientMessageId: 'key-2', objective: 'Second task', content: [{ type: 'text', text: '  notes  ' }] },
    ])
  })

  it('rotates the command key after an edit even if the user restores the old text', async () => {
    const memory = createObjectiveStartFlowMemory()
    const startCommand = vi.fn().mockRejectedValueOnce(new Error('unknown result')).mockResolvedValueOnce({})
    let sequence = 0
    const dependencies = {
      createSession: vi.fn(async () => 'session-1'), startCommand, onAccepted: vi.fn(),
      newClientMessageId: () => `key-${++sequence}`,
    }
    await expect(submitObjectiveStartFlow(memory, draft, dependencies)).rejects.toThrow()
    invalidateObjectiveStartIdentity(memory) // An edit followed by restoring the same text still starts a new identity.
    await submitObjectiveStartFlow(memory, draft, dependencies)
    expect(startCommand.mock.calls.map(call => call[0].clientMessageId)).toEqual(['key-1', 'key-2'])
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
  })

  it('holds one admission flight and never repeats an accepted command after callback failure', async () => {
    const memory = createObjectiveStartFlowMemory()
    let finishSession: ((id: string) => void) | undefined
    const createSession = vi.fn(() => new Promise<string>(resolve => { finishSession = resolve }))
    const startCommand = vi.fn(async () => ({ inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '1' }))
    const dependencies = { createSession, startCommand, onAccepted: vi.fn() }
    const first = submitObjectiveStartFlow(memory, draft, dependencies)
    await expect(submitObjectiveStartFlow(memory, draft, dependencies)).resolves.toEqual({ accepted: false, inFlight: true })
    expect(createSession).toHaveBeenCalledTimes(1)
    finishSession?.('session-1')
    await expect(first).resolves.toEqual({ accepted: true, inFlight: false })

    const callbackMemory = createObjectiveStartFlowMemory()
    const onAccepted = vi.fn(() => { throw new Error('refresh failed') })
    const callbackDependencies = {
      createSession: vi.fn(async () => 'session-2'),
      startCommand: vi.fn(async () => ({ inputId: 'input-2', turnId: 'turn-2', disposition: 'started', sequence: '2' })),
      onAccepted,
    }
    await expect(submitObjectiveStartFlow(callbackMemory, draft, callbackDependencies)).resolves.toEqual({
      accepted: true, inFlight: false, callbackFailed: true,
    })
    await expect(submitObjectiveStartFlow(callbackMemory, draft, callbackDependencies)).resolves.toEqual({ accepted: true, inFlight: false })
    expect(callbackDependencies.startCommand).toHaveBeenCalledTimes(1)
    expect(onAccepted).toHaveBeenCalledTimes(1)
  })

  it('does not admit invalid text or claim success when Session creation has no usable identity', async () => {
    const memory = createObjectiveStartFlowMemory()
    const startCommand = vi.fn()
    const createSession = vi.fn(async () => '')
    await expect(submitObjectiveStartFlow(memory, { objective: '你'.repeat(667), background: '' }, {
      createSession, startCommand, onAccepted: vi.fn(),
    })).rejects.toThrow('2,000 UTF-8 bytes')
    await expect(submitObjectiveStartFlow(memory, { ...draft, background: 'x'.repeat(20_001) }, {
      createSession, startCommand, onAccepted: vi.fn(),
    })).rejects.toMatchObject({ status: 422 })
    await expect(submitObjectiveStartFlow(memory, draft, { createSession, startCommand, onAccepted: vi.fn() }))
      .rejects.toThrow('No task was started')
    expect(startCommand).not.toHaveBeenCalled()
    expect(memory.accepted).toBe(false)
  })

  it('creates legacy Session metadata from the trimmed human objective only', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => ({ ok: true, status: 201, json: async () => ({ session: { id: 'session-1' } }) } as unknown as Response))
    await expect(createSessionForObjective('  Find roles  ', fetcher)).resolves.toBe('session-1')
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ goal: 'Find roles' }),
    }))
  })
})
