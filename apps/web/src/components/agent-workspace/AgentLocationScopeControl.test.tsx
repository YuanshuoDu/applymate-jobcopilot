import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import type { ActiveTurnDto } from './agent-session-state'
import {
  acquireLocationScopeRequest, AgentLocationScopeControl, canConfirmLocationScope, canRetryLocationScope, canSteerLocationScope,
  canRebaseLocationScope, createFrozenLocationSteerRequest, initialLocationScopeState, locationScopeFailureKind,
  locationScopeReducer, locationScopeTargetChanged, parseLocationScopeDraft, sendFrozenLocationSteerRequest,
} from './AgentLocationScopeControl'

const activeTurn: ActiveTurnDto = { id: 'turn_1', status: 'in_progress', revision: 4, canSteerLocation: true }
const target = { turnId: activeTurn.id, revision: activeTurn.revision }

describe('AgentLocationScopeControl', () => {
  it('requires the ready projection, running Session, literal capability, and an eligible Turn status', () => {
    expect(canSteerLocationScope('running', 'ready', activeTurn)).toBe(true)
    expect(canSteerLocationScope('paused', 'ready', activeTurn)).toBe(false)
    expect(canSteerLocationScope('running', 'loading', activeTurn)).toBe(false)
    expect(canSteerLocationScope('running', 'ready', { ...activeTurn, canSteerLocation: undefined })).toBe(false)
    for (const status of ['queued', 'waiting_for_approval', 'waiting_for_user'] as const) {
      expect(canSteerLocationScope('running', 'ready', { ...activeTurn, status })).toBe(false)
    }
    expect(canSteerLocationScope('running', 'ready', { ...activeTurn, status: 'waiting_for_dependency' })).toBe(true)
  })

  it('renders the entry only for the authorized active projection', () => {
    const props = { sessionId: 'session_1', activeTurn, sessionStatus: 'running', turnStateReadiness: 'ready' as const }
    const ordinaryTurn: ActiveTurnDto = { id: 'turn_1', status: 'in_progress', revision: 4 }
    expect(renderToStaticMarkup(<AgentLocationScopeControl {...props} />)).toContain('open-location-scope')
    expect(renderToStaticMarkup(<AgentLocationScopeControl {...props} activeTurn={ordinaryTurn} />)).toBe('')
    expect(renderToStaticMarkup(<AgentLocationScopeControl {...props} activeTurn={{ ...activeTurn, status: 'waiting_for_approval' }} />)).toBe('')
  })

  it('shows confirmed and applied scopes separately, and follows the current Turn only', () => {
    const props = { sessionId: 'session_1', activeTurn, sessionStatus: 'running', turnStateReadiness: 'ready' as const }
    const pending = renderToStaticMarkup(<AgentLocationScopeControl {...props} activeTurn={{ ...activeTurn,
      locationScope: { confirmed: { locations: ['dublin'], status: 'pending' }, appliedLocations: ['berlin'] },
    }} />)
    expect(pending).toContain('Confirmed locations waiting for the plan to adopt them: dublin')
    expect(pending).toContain('Current plan search locations: berlin')
    const adopted = renderToStaticMarkup(<AgentLocationScopeControl {...props} activeTurn={{ ...activeTurn,
      locationScope: { confirmed: { locations: ['dublin'], status: 'adopted' }, appliedLocations: ['dublin'] },
    }} />)
    expect(adopted).toContain('Confirmed locations adopted by the plan: dublin')
    const nextTurn = renderToStaticMarkup(<AgentLocationScopeControl {...props} activeTurn={{ ...activeTurn, id: 'turn_2' }} />)
    expect(nextTurn).not.toContain('berlin')
    expect(nextTurn).not.toContain('dublin')
  })

  it('splits by line and preserves commas inside each location', () => {
    expect(parseLocationScopeDraft('Washington, D.C.\n Dublin \nDUBLIN\n')).toEqual(['dublin', 'washington, d.c.'])
    expect(parseLocationScopeDraft('  \n')).toBeNull()
  })

  it('creates an immutable E2 request bound to the selected Turn and revision', () => {
    const request = createFrozenLocationSteerRequest(target, ['dublin', 'washington, d.c.'], 'location-request-1')
    expect(request).toEqual({ schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, clientMessageId: 'location-request-1',
      expectedTurnId: 'turn_1', expectedRevision: 4, locations: ['dublin', 'washington, d.c.'] })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.locations)).toBe(true)
  })

  it('acquires the pending guard before a second confirmation can mint a request ID', () => {
    const opened = locationScopeReducer(initialLocationScopeState, { type: 'open', target })
    const reviewed = locationScopeReducer(opened, { type: 'review', locations: ['dublin'] })
    const lock = { current: false }
    expect(acquireLocationScopeRequest(lock, reviewed, false, true)).toBe(true)
    expect(acquireLocationScopeRequest(lock, reviewed, false, true)).toBe(false)
    expect(lock.current).toBe(true)
    expect(acquireLocationScopeRequest({ current: false }, reviewed, false, false)).toBe(false)
  })

  it('blocks rebasing while a request is in flight', () => {
    expect(canRebaseLocationScope({ current: false }, target, true)).toBe(true)
    expect(canRebaseLocationScope({ current: true }, target, true)).toBe(false)
  })

  it('resends the same frozen body and idempotency key after an uncertain response', async () => {
    const request = createFrozenLocationSteerRequest(target, ['dublin'], 'location-stable-key')
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 } as Response))
    await sendFrozenLocationSteerRequest('session_1', request, fetcher)
    await sendFrozenLocationSteerRequest('session_1', request, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(([url, init]) => [url, (init?.headers as Record<string, string>)['Idempotency-Key'], init?.body]))
      .toEqual(Array(2).fill(['/api/agent/sessions/session_1/steer-location', 'location-stable-key', JSON.stringify(request)]))
  })

  it('treats an unexpected successful response as uncertain', async () => {
    const request = createFrozenLocationSteerRequest(target, ['dublin'], 'location-redirect-key')
    const followedLogin = async () => ({ ok: true, status: 200 } as Response)
    await expect(sendFrozenLocationSteerRequest('session_1', request, followedLogin))
      .rejects.toMatchObject({ status: 200, uncertain: true })
    await expect(sendFrozenLocationSteerRequest('session_1', request, followedLogin).catch(error => locationScopeFailureKind(error)))
      .resolves.toBe('unknown')
  })

  it('permits the frozen retry on the same eligible Turn after a revision advance, but not a Turn switch', () => {
    const request = createFrozenLocationSteerRequest(target, ['dublin'], 'location-stable-key')
    const opened = locationScopeReducer(initialLocationScopeState, { type: 'open', target })
    const reviewed = locationScopeReducer(opened, { type: 'review', locations: ['dublin'] })
    expect(canConfirmLocationScope(reviewed, false)).toBe(true)
    const sent = locationScopeReducer(reviewed, { type: 'send', request })
    const uncertain = locationScopeReducer(sent, { type: 'failed', error: { kind: 'unknown', message: 'lost' } })
    const advancedSameTurn = { ...activeTurn, revision: 5 }
    expect(locationScopeTargetChanged(target, 'running', 'ready', advancedSameTurn)).toBe(true)
    expect(canRetryLocationScope(uncertain, 'running', 'ready', advancedSameTurn)).toBe(true)
    expect(uncertain.request).toBe(request)
    expect(canConfirmLocationScope(uncertain, true)).toBe(false)
    expect(canRetryLocationScope(uncertain, 'running', 'ready', { ...activeTurn, id: 'turn_2' })).toBe(false)
  })

  it('requires a new review after a known conflict and rebases without changing the location draft', () => {
    const request = createFrozenLocationSteerRequest(target, ['dublin'], 'location-old-key')
    const sent = locationScopeReducer(locationScopeReducer(initialLocationScopeState, { type: 'open', target }), { type: 'review', locations: ['dublin'] })
    const conflict = locationScopeReducer(locationScopeReducer(sent, { type: 'send', request }), {
      type: 'failed', error: { kind: 'conflict', message: 'stale' },
    })
    const edited = locationScopeReducer(conflict, { type: 'edit', draft: 'Dublin\nCork' })
    const rebased = locationScopeReducer(edited, { type: 'rebase', target: { turnId: 'turn_2', revision: 8 } })
    expect(conflict).toMatchObject({ request: null, reviewedLocations: null, draft: '' })
    expect(rebased).toMatchObject({ target: { turnId: 'turn_2', revision: 8 }, draft: 'Dublin\nCork', reviewedLocations: null, request: null })
    expect(canConfirmLocationScope(rebased, false)).toBe(false)
  })
})
