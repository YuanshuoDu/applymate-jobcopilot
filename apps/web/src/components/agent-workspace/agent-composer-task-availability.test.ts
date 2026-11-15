import { describe, expect, it } from 'vitest'
import {
  composerTaskUnavailableMessage,
  resolveComposerTaskAvailability,
  type ComposerTaskAvailabilityInput,
} from './agent-composer-task-availability'

const blank: ComposerTaskAvailabilityInput = {
  selectedSessionId: null, composerSessionId: null, hasActiveTurn: false, turnStateReadiness: 'ready', sessionStatus: null,
  isRestoring: false, waitingForAnswer: false, isBusy: false, hasLiveBlocks: false,
}

describe('composer Task availability', () => {
  it('allows a blank workspace and requires a confirmed idle selected Session', () => {
    expect(resolveComposerTaskAvailability(blank)).toEqual({ kind: 'available', target: { kind: 'new-session' } })
    expect(resolveComposerTaskAvailability({
      ...blank, selectedSessionId: 'session-a', composerSessionId: 'session-a', sessionStatus: 'running',
    })).toEqual({ kind: 'available', target: { kind: 'selected-session', sessionId: 'session-a' } })
  })

  it.each(['loading', 'error'] as const)('fails closed when selected Session Turn state is %s', (turnStateReadiness) => {
    const result = resolveComposerTaskAvailability({
      ...blank,
      selectedSessionId: 'session-a',
      composerSessionId: 'session-a',
      sessionStatus: 'running',
      turnStateReadiness,
    })
    expect(result).toMatchObject({ kind: 'unavailable' })
    if (result.kind === 'unavailable') expect(composerTaskUnavailableMessage(result.reason)).toMatch(/Turn state/)
  })

  it('fails closed when the Turn controller belongs to another Session or has an active Turn', () => {
    expect(resolveComposerTaskAvailability({
      ...blank, selectedSessionId: 'session-a', composerSessionId: 'session-b', sessionStatus: 'running',
    })).toMatchObject({ kind: 'unavailable', reason: 'session-unavailable' })
    expect(resolveComposerTaskAvailability({
      ...blank, selectedSessionId: 'session-a', composerSessionId: 'session-a', sessionStatus: 'running', hasActiveTurn: true,
    })).toMatchObject({ kind: 'unavailable', reason: 'active-turn' })
  })
})
