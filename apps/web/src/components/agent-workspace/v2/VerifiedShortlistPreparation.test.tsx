import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { VERIFIED_SHORTLIST_SELECTION_SCHEMA, parseVerifiedShortlistSelectionBinding } from '@jobcopilot/agent-protocol'
import { VerifiedShortlistPreparation, buildVerifiedShortlistPreparationRequest, runShortlistPreparationOnce } from './VerifiedShortlistPreparation'
import type { TaskGraphIdentity } from './task-graph-plan-query'

const identity: TaskGraphIdentity = {
  sessionId: 'session-1', turnId: 'source-turn-1', rootTaskId: 'root-1', graphItemId: 'graph-1', revision: 4,
}
const items = [
  { jobId: 'job-a', score: 9, evidenceIds: ['read:job:job-a'] },
  { jobId: 'job-b', score: 8, evidenceIds: ['read:job:job-b'] },
  { jobId: 'job-c', score: 7, evidenceIds: ['read:job:job-c'] },
]
const value = { identity, result: { schemaVersion: 1, status: 'completed', items, failures: [] } }

function render(input: unknown = value, current: TaskGraphIdentity | null = identity, onPrepare?: (request: unknown) => Promise<unknown>, sessionId = 'session-1') {
  return renderToStaticMarkup(<VerifiedShortlistPreparation sessionId={sessionId} identity={current} value={input} lang="en" onPrepare={onPrepare} />)
}

function cardKey(current: TaskGraphIdentity): string | null {
  const card = VerifiedShortlistPreparation({ sessionId: current.sessionId, identity: current, value: { ...value, identity: current }, lang: 'en' })
  return React.isValidElement(card) && typeof card.key === 'string' ? card.key : null
}

describe('VerifiedShortlistPreparation', () => {
  it('keeps the existing bilingual display read-only without a capability callback', () => {
    const html = render()
    expect(html).toContain('aria-label="Discovery shortlist"')
    expect(html).toContain('Validated matches recovered from this session.')
    expect(html.indexOf('job-a')).toBeLessThan(html.indexOf('job-b'))
    expect(html.indexOf('job-b')).toBeLessThan(html.indexOf('job-c'))
    expect(html).toContain('read:job:job-a')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('data-verified-shortlist-controls')
    expect(html).not.toMatch(/approval|upload|submit_application/i)

    const chinese = renderToStaticMarkup(<VerifiedShortlistPreparation sessionId="session-1" identity={identity} value={value} lang="zh" />)
    expect(chinese).toContain('aria-label="职位候选清单"')
    expect(chinese).toContain('已从此会话恢复已验证的职位。')
  })

  it('exposes optional controls only for a complete shortlist matching the exact current identity', () => {
    const onPrepare = vi.fn(async (_request: unknown) => undefined)
    const current = render(value, identity, onPrepare)
    expect(current).toContain('data-verified-shortlist-controls="true"')
    expect(current.match(/type="checkbox"/g)).toHaveLength(3)
    expect(current).toContain('data-verified-shortlist-prepare="true" disabled=""')

    const staleIdentities = [
      { ...identity, sessionId: 'session-2' }, { ...identity, turnId: 'older-turn' },
      { ...identity, rootTaskId: 'other-root' }, { ...identity, graphItemId: 'other-graph' }, { ...identity, revision: 3 },
    ]
    for (const stale of staleIdentities) expect(render({ ...value, identity: stale }, identity, onPrepare)).toBe('')
    expect(render(value, { ...identity, sessionId: 'session-2' }, onPrepare)).toBe('')
    expect(onPrepare).not.toHaveBeenCalled()
  })

  it('keeps partial and failed results read-only even when a preparation callback exists', () => {
    const onPrepare = vi.fn(async (_request: unknown) => undefined)
    const partial = { identity, result: { schemaVersion: 1, status: 'partial', items: [items[0], items[1]], failures: ['scout_task_incomplete'] } }
    const failed = { identity, result: { schemaVersion: 1, status: 'failed', items: [], failures: ['discovery_runtime_failed'] } }
    expect(render(partial, identity, onPrepare)).toContain('data-discovery-shortlist-status="partial"')
    expect(render(partial, identity, onPrepare)).not.toContain('data-verified-shortlist-controls')
    expect(render(failed, identity, onPrepare)).toContain('data-discovery-shortlist-status="failed"')
    expect(render(failed, identity, onPrepare)).not.toContain('data-verified-shortlist-controls')
  })

  it('preserves the prior read-only projection when the stricter callback source parser rejects an identity', () => {
    const legacyIdentity = { ...identity, sessionId: 'session/legacy' }
    const legacyValue = { ...value, identity: legacyIdentity }
    const onPrepare = vi.fn(async (_request: unknown) => undefined)
    const html = render(legacyValue, legacyIdentity, onPrepare, legacyIdentity.sessionId)

    expect(html).toContain('aria-label="Discovery shortlist"')
    expect(html).toContain('job-a')
    expect(html).not.toContain('data-verified-shortlist-controls')
    expect(html).not.toContain('<button')
  })

  it('maps the current graph identity into the shared protocol and normalizes selected IDs to shortlist order', () => {
    const request = buildVerifiedShortlistPreparationRequest(identity, items, ['job-c', 'job-a'])
    const expectedSource = {
      sessionId: 'session-1', sourceTurnId: 'source-turn-1', rootTaskId: 'root-1', graphItemId: 'graph-1', graphRevision: 4,
    }
    expect(request).toEqual({ source: expectedSource, selectedJobIds: ['job-a', 'job-c'] })
    expect(Object.keys(request ?? {}).sort()).toEqual(['selectedJobIds', 'source'])
    expect(parseVerifiedShortlistSelectionBinding({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, ...request })).not.toBeNull()
    expect(buildVerifiedShortlistPreparationRequest(identity, items, ['job-a'])).toBeNull()
    expect(buildVerifiedShortlistPreparationRequest(identity, items, ['job-a', 'job-a'])).toBeNull()
    expect(buildVerifiedShortlistPreparationRequest(identity, items, ['job-a', 'foreign-job'])).toBeNull()
    expect(buildVerifiedShortlistPreparationRequest({ ...identity, turnId: 'bad/turn' }, items, ['job-a', 'job-c'])).toBeNull()
  })

  it('keys local selection and result state by all source fields so stale async results stay on the old card', () => {
    const originalKey = cardKey(identity)
    expect(originalKey).not.toBeNull()
    const changed = [
      { ...identity, sessionId: 'session-2' }, { ...identity, turnId: 'turn-2' },
      { ...identity, rootTaskId: 'root-2' }, { ...identity, graphItemId: 'graph-2' }, { ...identity, revision: 5 },
    ]
    for (const current of changed) expect(cardKey(current)).not.toBe(originalKey)
    expect(cardKey(identity)).toBe(originalKey)
  })

  it('keeps the submit lock through a pending callback and rejects duplicate starts', async () => {
    let release: (() => void) | undefined
    const onPrepare = vi.fn((_request: unknown) => new Promise<void>(resolve => { release = resolve }))
    const request = buildVerifiedShortlistPreparationRequest(identity, items, ['job-a', 'job-c'])!
    const lock = { current: false }
    const first = runShortlistPreparationOnce(lock, onPrepare, request)

    expect(lock.current).toBe(true)
    expect(await runShortlistPreparationOnce(lock, onPrepare, request)).toBe(false)
    expect(onPrepare).toHaveBeenCalledTimes(1)
    release?.()
    expect(await first).toBe(true)
    expect(lock.current).toBe(false)
  })
})
