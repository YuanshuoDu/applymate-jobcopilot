import { describe, expect, it, vi } from 'vitest'
import type { ActiveTurnDto } from './agent-session-state'
import {
  appendComposerText,
  reconcileComposerMessage,
  sendAgentInterrupt,
  sendAgentTurnMessage,
  type ComposerMessage,
  AgentTurnCommandError,
} from './agent-turn-commands'

const activeTurn: ActiveTurnDto = { id: 'turn_1', status: 'in_progress', revision: 4 }

function response(body: unknown, status = 202) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('agent Turn commands', () => {
  it('appends Composer context into the active typed input', () => {
    expect(appendComposerText('', '  Role context  ')).toBe('Role context')
    expect(appendComposerText('Existing request', 'Role context')).toBe('Existing request\n\nRole context')
    expect(appendComposerText('Existing request', '   ')).toBe('Existing request')
  })

  it('sends an explicit steer command and reconciles its optimistic message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ inputId: 'input_1', turnId: 'turn_1', disposition: 'steered', sequence: '8' }))
    const result = await sendAgentTurnMessage('session_1', 'Change direction', 'steer', activeTurn, 'message_1', fetcher)

    expect(result).toMatchObject({ inputId: 'input_1', turnId: 'turn_1', disposition: 'steered' })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      clientMessageId: 'message_1', delivery: 'steer', expectedTurnId: 'turn_1', expectedRevision: 4,
    })
    const optimistic: ComposerMessage[] = [{ clientMessageId: 'message_1', text: 'Change direction', delivery: 'steer', status: 'sending' }]
    expect(reconcileComposerMessage(optimistic, 'message_1', { status: 'accepted', inputId: 'input_1' })[0]).toMatchObject({ status: 'accepted', inputId: 'input_1' })
  })

  it('keeps follow-up delivery explicit and does not target the active Turn', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ inputId: 'input_2', turnId: 'turn_1', disposition: 'queued_follow_up', sequence: '9' }))
    await sendAgentTurnMessage('session_1', 'After this run', 'follow_up', activeTurn, 'message_2', fetcher)

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      clientMessageId: 'message_2', delivery: 'follow_up', expectedTurnId: null, expectedRevision: null,
    })
  })

  it('surfaces a typed 409 instead of leaving the message in sending', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code: 'active_turn_changed', message: 'Turn changed', details: { actualTurnId: 'turn_2' } } }, 409))

    await expect(sendAgentTurnMessage('session_1', 'Stale steer', 'steer', activeTurn, 'message_3', fetcher))
      .rejects.toMatchObject({ status: 409, code: 'active_turn_changed', details: { actualTurnId: 'turn_2' } })
    expect(new AgentTurnCommandError({ status: 409, code: 'active_turn_changed', message: 'Turn changed', details: {} }).status).toBe(409)
  })

  it('uses the AH2-026 interrupt endpoint and accepts a 202 response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ inputId: 'interrupt_1', turnId: 'turn_1', disposition: 'interrupted', sequence: '10' }))
    await expect(sendAgentInterrupt('session_1', activeTurn, 'interrupt_1', fetcher)).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session_1/turns/turn_1/interrupt', expect.objectContaining({ method: 'POST' }))
  })

  it('supports the consumed and failed terminal client states', () => {
    const accepted: ComposerMessage[] = [{ clientMessageId: 'message_4', text: 'Done', delivery: 'steer', status: 'accepted', inputId: 'input_4' }]
    expect(reconcileComposerMessage(accepted, 'message_4', { status: 'consumed' })[0]?.status).toBe('consumed')
    expect(reconcileComposerMessage(accepted, 'message_4', { status: 'failed', error: '409 Turn changed' })[0]).toMatchObject({ status: 'failed', error: '409 Turn changed' })
  })
})
