import type { AgentTurnStateReadiness } from './agent-session-state'
import type { AgentSessionControlStatus } from './v2/AgentSessionPauseResumeControl'

export type ComposerTaskTarget = { readonly kind: 'new-session' } | { readonly kind: 'selected-session'; readonly sessionId: string }

export type ComposerTaskAvailability = { readonly kind: 'available'; readonly target: ComposerTaskTarget }
  | { readonly kind: 'unavailable'; readonly reason: 'recovering' | 'waiting' | 'busy' | 'active-turn' | 'session-unavailable' | 'turn-state-loading' | 'turn-state-error' | 'session-not-idle' | 'not-blank' }

export interface ComposerTaskAvailabilityInput {
  readonly selectedSessionId: string | null
  readonly composerSessionId: string | null
  readonly hasActiveTurn: boolean
  readonly turnStateReadiness: AgentTurnStateReadiness
  readonly sessionStatus: AgentSessionControlStatus | null | undefined
  readonly isRestoring: boolean
  readonly waitingForAnswer: boolean
  readonly isBusy: boolean
  readonly hasLiveBlocks: boolean
}

export function resolveComposerTaskAvailability(input: ComposerTaskAvailabilityInput): ComposerTaskAvailability {
  if (input.isRestoring) return { kind: 'unavailable', reason: 'recovering' }
  if (input.waitingForAnswer) return { kind: 'unavailable', reason: 'waiting' }
  if (input.isBusy) return { kind: 'unavailable', reason: 'busy' }
  if (input.hasActiveTurn) return { kind: 'unavailable', reason: 'active-turn' }

  if (input.selectedSessionId) {
    if (input.composerSessionId !== input.selectedSessionId) return { kind: 'unavailable', reason: 'session-unavailable' }
    if (input.turnStateReadiness === 'loading') return { kind: 'unavailable', reason: 'turn-state-loading' }
    if (input.turnStateReadiness === 'error') return { kind: 'unavailable', reason: 'turn-state-error' }
    if (input.sessionStatus !== 'running') return { kind: 'unavailable', reason: 'session-not-idle' }
    return { kind: 'available', target: { kind: 'selected-session', sessionId: input.selectedSessionId } }
  }

  if (input.composerSessionId || input.sessionStatus !== null || input.hasLiveBlocks) {
    return { kind: 'unavailable', reason: 'not-blank' }
  }
  return { kind: 'available', target: { kind: 'new-session' } }
}

export function composerTaskUnavailableMessage(reason: Extract<ComposerTaskAvailability, { kind: 'unavailable' }>['reason']): string {
  switch (reason) {
    case 'recovering': return 'Wait for this Session to finish recovering before starting a task.'
    case 'waiting': return 'Resolve the pending question or approval in Chat before starting a task.'
    case 'busy': return 'Wait for the current request to finish before starting a task.'
    case 'active-turn': return 'Task mode is unavailable while a Turn is active.'
    case 'session-unavailable': return 'Wait for the selected Session to finish loading before starting a task.'
    case 'turn-state-loading': return 'Wait for the selected Session Turn state to finish loading before starting a task.'
    case 'turn-state-error': return 'The selected Session Turn state could not be verified. Retry loading the Session before starting a task.'
    case 'session-not-idle': return 'Task mode requires an idle Session.'
    case 'not-blank': return 'Start a task from a blank workspace or a selected idle Session.'
  }
}
