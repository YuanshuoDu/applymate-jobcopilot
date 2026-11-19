'use client'

import React, { useReducer, useRef, type FormEvent } from 'react'
import { OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, ObjectiveLocationSteerRequestSchema, validate, type ObjectiveLocationSteerRequest } from '@jobcopilot/agent-protocol'
import { normalizeAgentLocationAllowlist } from '@jobcopilot/shared/agent-location-normalization'
import { useI18n } from '@/lib/i18n'
import type { ActiveTurnDto, AgentTurnStateReadiness } from './agent-session-state'

type LocationTarget = Readonly<{ turnId: string; revision: number }>
type LocationErrorKind = 'validation' | 'unknown' | 'conflict' | 'known'
type LocationError = Readonly<{ kind: LocationErrorKind; message: string }>
export type FrozenLocationSteerRequest = Readonly<ObjectiveLocationSteerRequest>
export type LocationScopeState = Readonly<{
  open: boolean; target: LocationTarget | null; draft: string; reviewedLocations: readonly string[] | null
  request: FrozenLocationSteerRequest | null; pending: boolean; error: LocationError | null
}>
type LocationScopeAction =
  | { type: 'open'; target: LocationTarget } | { type: 'edit'; draft: string }
  | { type: 'review'; locations: readonly string[] } | { type: 'send'; request: FrozenLocationSteerRequest }
  | { type: 'pending' } | { type: 'failed'; error: LocationError } | { type: 'rebase'; target: LocationTarget }
  | { type: 'accepted' } | { type: 'close' }

export const initialLocationScopeState: LocationScopeState = {
  open: false, target: null, draft: '', reviewedLocations: null, request: null, pending: false, error: null,
}

export function locationScopeReducer(state: LocationScopeState, action: LocationScopeAction): LocationScopeState {
  if (action.type === 'open') return { ...initialLocationScopeState, open: true, target: action.target }
  if (action.type === 'edit') return { ...state, draft: action.draft, reviewedLocations: null, request: null, error: null }
  if (action.type === 'review') return { ...state, reviewedLocations: action.locations, request: null, error: null }
  if (action.type === 'send') return { ...state, request: action.request, pending: true, error: null }
  if (action.type === 'pending') return { ...state, pending: true, error: null }
  if (action.type === 'failed') return {
    ...state, pending: false, error: action.error,
    request: action.error.kind === 'unknown' ? state.request : null,
    reviewedLocations: action.error.kind === 'unknown' ? state.reviewedLocations : null,
  }
  if (action.type === 'rebase') return { ...state, target: action.target, reviewedLocations: null, request: null, pending: false, error: null }
  if (action.type === 'accepted') return initialLocationScopeState
  return initialLocationScopeState
}

export function canSteerLocationScope(
  sessionStatus: string | null | undefined, readiness: AgentTurnStateReadiness | undefined, activeTurn: ActiveTurnDto | null,
): boolean {
  return sessionStatus === 'running' && readiness === 'ready' && activeTurn !== null && activeTurn.canSteerLocation === true
    && (activeTurn.status === 'in_progress' || activeTurn.status === 'waiting_for_dependency')
}

export function locationScopeTargetChanged(
  target: LocationTarget | null, sessionStatus: string | null | undefined,
  readiness: AgentTurnStateReadiness | undefined, activeTurn: ActiveTurnDto | null,
): boolean {
  if (target === null) return false
  if (activeTurn === null || !canSteerLocationScope(sessionStatus, readiness, activeTurn)) return true
  return activeTurn.id !== target.turnId || activeTurn.revision !== target.revision
}

export function canRetryLocationScope(
  state: LocationScopeState, sessionStatus: string | null | undefined,
  readiness: AgentTurnStateReadiness | undefined, activeTurn: ActiveTurnDto | null,
): boolean {
  if (state.error?.kind !== 'unknown' || state.request === null || state.pending || activeTurn === null) return false
  return canSteerLocationScope(sessionStatus, readiness, activeTurn) && activeTurn.id === state.request.expectedTurnId
}

export function parseLocationScopeDraft(value: string): readonly string[] | null {
  if (new TextEncoder().encode(value).byteLength > 2_000) return null
  const entries = value.split(/\r?\n/).filter(entry => entry.trim() !== '')
  return normalizeAgentLocationAllowlist(entries)
}

export function createFrozenLocationSteerRequest(
  target: LocationTarget, locations: readonly string[], clientMessageId: string,
): FrozenLocationSteerRequest {
  const frozenLocations = Object.freeze([...locations]) as unknown as string[]
  return Object.freeze({ schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, clientMessageId,
    expectedTurnId: target.turnId, expectedRevision: target.revision, locations: frozenLocations })
}

export class LocationScopeCommandError extends Error {
  constructor(readonly status: number, readonly uncertain = false) { super(`Location change was rejected (${status})`); this.name = 'LocationScopeCommandError' }
}

export async function sendFrozenLocationSteerRequest(
  sessionId: string, request: FrozenLocationSteerRequest, fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!validate(ObjectiveLocationSteerRequestSchema, request)) throw new LocationScopeCommandError(422)
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(sessionId)}/steer-location`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
    body: JSON.stringify(request),
  })
  if (response.ok && response.status === 202) return
  throw new LocationScopeCommandError(response.status, response.ok || response.status === 202)
}

export function locationScopeFailureKind(reason: unknown): LocationErrorKind {
  const status = reason instanceof LocationScopeCommandError ? reason.status : null
  if (status === 409) return 'conflict'
  return status === null || status >= 500 || (reason instanceof LocationScopeCommandError && reason.uncertain) ? 'unknown' : 'known'
}

export function canConfirmLocationScope(state: LocationScopeState, stale: boolean): boolean {
  return state.open && state.target !== null && state.reviewedLocations !== null && state.reviewedLocations.length > 0
    && state.request === null && !state.pending && !state.error && !stale
}

export function acquireLocationScopeRequest(
  lock: { current: boolean }, state: LocationScopeState, stale: boolean, eligible: boolean,
): boolean {
  if (lock.current || !eligible || !canConfirmLocationScope(state, stale)) return false
  lock.current = true
  return true
}

export function canRebaseLocationScope(
  lock: { current: boolean }, target: LocationTarget | null, eligible: boolean,
): target is LocationTarget {
  return !lock.current && target !== null && eligible
}

const COPY = {
  en: { open: 'Change search locations', heading: 'Change allowed search locations', hint: 'Enter one location per line. Commas within a location are kept as written.',
    field: 'Allowed locations', review: 'Review locations', confirm: 'Confirm location change', retry: 'Retry the same request', close: 'Close',
    preview: 'Locations to send', stale: 'The run or revision changed. Retry the same confirmed request if its response was lost, or use the current run and review again.',
    rebase: 'Use the current run and review again', confirmedPending: 'Confirmed locations waiting for the plan to adopt them',
    adopted: 'Confirmed locations adopted by the plan', applied: 'Current plan search locations',
    validation: 'Enter 1 to 8 valid locations, one per line.', conflict: 'The server reports that this request is out of date.',
    unknown: 'The response was lost or unavailable. Retry sends the same confirmed request.', known: 'The location change was rejected. Review the locations and try again.', unavailable: 'The current run cannot accept a location change.' },
  zh: { open: '更改搜索地点', heading: '更改允许搜索的地点', hint: '每行填写一个地点；地点名中的逗号会按原样保留。',
    field: '允许搜索的地点', review: '检查地点', confirm: '确认更改地点', retry: '使用同一请求重试', close: '关闭',
    preview: '将发送的地点', stale: '当前运行或版本已变化。若响应丢失，可重试同一确认请求；也可切换到当前运行并重新检查。',
    rebase: '切换到当前运行并重新检查', confirmedPending: '已确认地点，等待计划采用。',
    adopted: '计划已采用已确认地点', applied: '当前计划搜索地点',
    validation: '请按每行一个地点填写 1 到 8 个有效地点。', conflict: '服务器提示请求所依据的运行版本已过期。',
    unknown: '响应丢失或暂不可用；重试会发送同一份已确认请求。', known: '地点更改未被接受，请检查地点后重试。', unavailable: '当前运行暂时不能更改搜索地点。' },
} as const

export function AgentLocationScopeControl(props: {
  sessionId: string; activeTurn: ActiveTurnDto | null; sessionStatus?: string | null
  turnStateReadiness?: AgentTurnStateReadiness; onAccepted?: () => unknown
}) {
  const { lang } = useI18n(), copy = lang === 'zh' ? COPY.zh : COPY.en
  const [state, dispatch] = useReducer(locationScopeReducer, initialLocationScopeState)
  const pending = useRef(false)
  const eligible = canSteerLocationScope(props.sessionStatus, props.turnStateReadiness, props.activeTurn)
  const stale = locationScopeTargetChanged(state.target, props.sessionStatus, props.turnStateReadiness, props.activeTurn)
  const retryAllowed = canRetryLocationScope(state, props.sessionStatus, props.turnStateReadiness, props.activeTurn)
  const locationScope = props.activeTurn?.locationScope
  const newTarget = (): LocationTarget | null => props.activeTurn && eligible
    ? { turnId: props.activeTurn.id, revision: props.activeTurn.revision } : null
  const open = () => { const target = newTarget(); if (target) dispatch({ type: 'open', target }) }
  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current || stale || !eligible) return
    const locations = parseLocationScopeDraft(state.draft)
    if (!locations) { dispatch({ type: 'failed', error: { kind: 'validation', message: copy.validation } }); return }
    dispatch({ type: 'review', locations })
  }
  const send = (request: FrozenLocationSteerRequest, retry = false, alreadyLocked = false) => {
    if (!alreadyLocked && pending.current) return
    pending.current = true
    if (retry) dispatch({ type: 'pending' }); else dispatch({ type: 'send', request })
    void sendFrozenLocationSteerRequest(props.sessionId, request).then(() => {
      dispatch({ type: 'accepted' }); void Promise.resolve().then(() => props.onAccepted?.()).catch(() => undefined)
    }).catch((reason: unknown) => {
      const kind = locationScopeFailureKind(reason)
      if (kind === 'conflict') void Promise.resolve().then(() => props.onAccepted?.()).catch(() => undefined)
      dispatch({ type: 'failed', error: { kind, message: kind === 'conflict' ? copy.conflict : kind === 'unknown' ? copy.unknown : copy.known } })
    }).finally(() => { pending.current = false })
  }
  const confirm = () => {
    if (!state.target || !state.reviewedLocations || !acquireLocationScopeRequest(pending, state, stale, eligible)) return
    send(createFrozenLocationSteerRequest(state.target, state.reviewedLocations, newClientMessageId()), false, true)
  }
  const retry = () => {
    if (pending.current || !retryAllowed || !state.request) return
    send(state.request, true)
  }
  const rebase = () => { const target = newTarget(); if (canRebaseLocationScope(pending, target, eligible)) dispatch({ type: 'rebase', target }) }
  if (!state.open && !eligible && !locationScope) return null

  return <div data-testid="agent-location-scope-control" style={{ flexBasis: '100%', display: 'grid', gap: 7, marginTop: 7 }}>
    {locationScope && <section aria-live="polite" data-testid="active-location-scope-status" style={{ display: 'grid', gap: 3 }}>
      <p role="status" data-testid="confirmed-location-scope" style={{ margin: 0 }}>
        {locationScope.confirmed.status === 'adopted' ? copy.adopted : copy.confirmedPending}: {locationScope.confirmed.locations.join(', ')}
      </p>
      {locationScope.appliedLocations && <p data-testid="applied-location-scope" style={{ margin: 0 }}>
        {copy.applied}: {locationScope.appliedLocations.join(', ')}
      </p>}
    </section>}
    {!state.open && eligible && <button type="button" data-testid="open-location-scope" onClick={open} style={buttonStyle}>{copy.open}</button>}
    {state.open && <section aria-label={copy.heading} style={{ display: 'grid', gap: 7 }}>
      <strong>{copy.heading}</strong>
      <p style={{ margin: 0 }}>{copy.hint}</p>
      <form onSubmit={review} style={{ display: 'grid', gap: 7 }}>
        <label htmlFor="agent-location-scope-draft">{copy.field}</label>
        <textarea id="agent-location-scope-draft" data-testid="location-scope-draft" rows={4} value={state.draft}
          disabled={state.pending} onChange={event => dispatch({ type: 'edit', draft: event.target.value })} style={textareaStyle} />
        {!state.reviewedLocations && <button type="submit" disabled={!eligible || stale || state.pending || !state.draft.trim()} style={buttonStyle}>{copy.review}</button>}
      </form>
      {state.reviewedLocations && <div aria-label={copy.preview} data-testid="location-scope-preview"><strong>{copy.preview}</strong><ul style={{ margin: '4px 0', paddingInlineStart: 20 }}>{state.reviewedLocations.map(location => <li key={location}>{location}</li>)}</ul></div>}
      {stale && <p role="status" style={{ margin: 0 }}>{copy.stale}</p>}
      {!eligible && <p role="status" style={{ margin: 0 }}>{copy.unavailable}</p>}
      {state.error && <p role="alert" style={{ margin: 0 }}>{state.error.message}</p>}
      {retryAllowed && <button type="button" disabled={state.pending} onClick={retry} style={buttonStyle}>{copy.retry}</button>}
      {canConfirmLocationScope(state, stale) && eligible && <button type="button" data-testid="confirm-location-scope" onClick={confirm} style={confirmStyle}>{copy.confirm}</button>}
      {(stale || state.error?.kind === 'conflict') && eligible && <button type="button" disabled={state.pending} onClick={rebase} style={buttonStyle}>{copy.rebase}</button>}
      <button type="button" disabled={state.pending} onClick={() => dispatch({ type: 'close' })} style={buttonStyle}>{copy.close}</button>
    </section>}
  </div>
}

const buttonStyle: React.CSSProperties = { minHeight: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit' }
const confirmStyle: React.CSSProperties = { ...buttonStyle, border: 0, background: 'var(--primary)', color: 'white', fontWeight: 700 }
const textareaStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 7, padding: 8, color: 'var(--text)', background: 'var(--background)', font: 'inherit' }

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `location-${crypto.randomUUID()}`
  return `location-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
