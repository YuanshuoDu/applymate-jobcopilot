import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; enabled: boolean; cache: boolean }>,
  responses: new Map<string, unknown>(),
  lang: 'en',
}))

vi.mock('@/lib/hooks', () => ({
  useApi: (url: string, options: { enabled?: boolean; cache?: boolean } = {}) => {
    ui.calls.push({ url, enabled: options.enabled !== false, cache: options.cache !== false })
    return ui.responses.get(url) ?? { data: null, loading: true, error: null, refetch: () => undefined }
  },
}))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: ui.lang }) }))

import {
  ObjectiveTailorProgress,
  buildObjectiveTailorProgressUrl,
  objectiveTailorProgressRequestForItem,
  objectiveTailorProgressRequestForTurn,
  objectiveTailorTurnForCurrentView,
  shouldRefetchObjectiveTailorProgress,
  type ObjectiveTailorProgressIdentity,
  type ObjectiveTailorProgressRequest,
} from './ObjectiveTailorProgress'
import type { TimelineItem } from './timeline-reducer'

const identity: ObjectiveTailorProgressIdentity = {
  sessionId: 'session one', turnId: 'turn-1', graphItemId: 'graph/one', rootTaskId: 'root-1', revision: 27,
}
const request: ObjectiveTailorProgressRequest = { identity, sourceNodeCount: 7, slotCount: 8 }

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: identity.graphItemId, sessionId: identity.sessionId, turnId: identity.turnId,
    stepId: null, taskId: identity.rootTaskId, type: 'task_graph', status: 'streaming', phase: 'commentary', revision: identity.revision,
    content: { objectiveTailorProgressHint: {
      schemaVersion: 'agent-harness.v2.objective-tailor-progress-hint.v1', sourceNodeCount: 7, slotCount: 8,
    } }, startedAt: null, completedAt: null, createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z',
    source: 'durable', sequence: null, ...overrides,
  }
}

function progress(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2.objective-tailor-progress.v1', identity,
    sources: [
      { ordinal: 1, role: 'scout', status: 'completed' }, { ordinal: 2, role: 'scout', status: 'running' },
      { ordinal: 3, role: 'scout', status: 'pending' }, { ordinal: 4, role: 'analyst', status: 'completed' },
      { ordinal: 5, role: 'analyst', status: 'completed' }, { ordinal: 6, role: 'analyst', status: 'failed' },
      { ordinal: 7, role: 'analyst', status: 'pending' },
    ],
    slots: [
      { ordinal: 1, phase: 'completed' }, { ordinal: 2, phase: 'drafting' }, { ordinal: 3, phase: 'awaiting_review' },
      { ordinal: 4, phase: 'reviewing' }, { ordinal: 5, phase: 'awaiting_revision' }, { ordinal: 6, phase: 'revising' },
      { ordinal: 7, phase: 'awaiting_rereview' }, { ordinal: 8, phase: 'failed' },
    ],
    ...overrides,
  }
}

describe('ObjectiveTailorProgress', () => {
  beforeEach(() => { ui.calls = []; ui.responses.clear(); ui.lang = 'en' })

  it('reads the exact V2 hint from a timeline item and never falls back from a newer malformed graph', () => {
    const valid = item()
    expect(objectiveTailorProgressRequestForItem(valid, identity.sessionId, identity.turnId)).toEqual(request)
    expect(objectiveTailorProgressRequestForItem(valid, 'session-other', identity.turnId)).toBeNull()
    expect(objectiveTailorProgressRequestForItem(item({ content: {
      schemaVersion: 'agent-harness.v2.task-graph', nodes: Array.from({ length: 40 }, (_, index) => ({ key: `node-${index}` })),
    } }), identity.sessionId, identity.turnId)).toBeNull()

    const newerMalformed = item({ id: 'graph-new', revision: 28, updatedAt: '2026-11-24T10:01:00.000Z', content: {} })
    expect(objectiveTailorProgressRequestForTurn([valid, newerMalformed], identity.sessionId, identity.turnId)).toBeNull()
  })

  it('requires an exact active Turn for the current view and keeps an explicit no-active state clear', () => {
    expect(objectiveTailorTurnForCurrentView(undefined, identity.turnId)).toBe(identity.turnId)
    expect(objectiveTailorTurnForCurrentView({ activeTurnId: identity.turnId, activeTurn: { id: identity.turnId, status: 'in_progress' } }, null))
      .toBe(identity.turnId)
    expect(objectiveTailorTurnForCurrentView({ activeTurnId: null, activeTurn: null }, identity.turnId)).toBeNull()
    expect(objectiveTailorTurnForCurrentView({ activeTurnId: 'turn-other', activeTurn: { id: identity.turnId, status: 'in_progress' } }, null))
      .toBeNull()
  })

  it('builds an owner-scoped URL from the closed graph identity and refreshes only on usable lifecycle changes', () => {
    const url = buildObjectiveTailorProgressUrl(identity)
    const parsed = new URL(url, 'https://applymate.invalid')
    expect(parsed.pathname).toBe('/api/agent/sessions/session%20one/objective-tailor-progress')
    expect(parsed.searchParams.get('graphItemId')).toBe(identity.graphItemId)
    expect(parsed.searchParams.get('turnId')).toBe(identity.turnId)
    expect(parsed.searchParams.get('rootTaskId')).toBe(identity.rootTaskId)
    expect(parsed.searchParams.get('revision')).toBe('27')
    expect(shouldRefetchObjectiveTailorProgress(4, 5, true)).toBe(true)
    expect(shouldRefetchObjectiveTailorProgress(5, 5, true)).toBe(false)
    expect(shouldRefetchObjectiveTailorProgress(4, 5, false)).toBe(false)
    expect(shouldRefetchObjectiveTailorProgress(-1, 5, true)).toBe(false)
  })

  it('renders only bounded source and slot statuses for the exact response identity', () => {
    const url = buildObjectiveTailorProgressUrl(identity)
    ui.responses.set(url, { data: { progress: progress() }, loading: false, error: null, refetch: () => undefined })
    const html = renderToStaticMarkup(<ObjectiveTailorProgress request={request} lifecycleRevision={9} />)

    expect(html).toContain('Scout 1: Completed')
    expect(html).toContain('Analyst 6: Failed')
    expect(html).toContain('Slot 2: Drafting')
    expect(html).toContain('Slot 8: Failed')
    expect(html).toContain('Reviews complete: 1/8')
    expect(html).not.toContain('Ready to apply')
    expect(html).not.toContain(identity.sessionId)
    expect(html).not.toContain(identity.rootTaskId)
    expect(ui.calls).toContainEqual({ url, enabled: true, cache: false })
  })

  it('hides identity drift and hint-count mismatches, including historical response data', () => {
    const url = buildObjectiveTailorProgressUrl(identity)
    const mismatches = [
      progress({ identity: { ...identity, turnId: 'turn-other' } }),
      progress({ identity: { ...identity, revision: identity.revision - 1 } }),
      progress({ sources: progress().sources.slice(0, 6) }),
      progress({ slots: progress().slots.slice(0, 7) }),
    ]
    for (const result of mismatches) {
      ui.responses.set(url, { data: { progress: result }, loading: false, error: null, refetch: () => undefined })
      const html = renderToStaticMarkup(<ObjectiveTailorProgress request={request} lifecycleRevision={9} />)
      expect(html).toContain('data-objective-tailor-progress="unavailable"')
      expect(html).not.toContain('Slot 1:')
    }
    ui.responses.set(url, { data: { progress: progress() }, loading: true, error: 'unavailable', refetch: () => undefined })
    const failed = renderToStaticMarkup(<ObjectiveTailorProgress request={request} lifecycleRevision={9} />)
    expect(failed).toContain('data-objective-tailor-progress="unavailable"')
    expect(failed).toContain('Progress is unavailable.')
  })

  it('uses the compact localized status copy', () => {
    ui.lang = 'zh'
    ui.responses.set(buildObjectiveTailorProgressUrl(identity), { data: { progress: progress() }, loading: false, error: null, refetch: () => undefined })
    const html = renderToStaticMarkup(<ObjectiveTailorProgress request={request} lifecycleRevision={9} />)
    expect(html).toContain('目标定制进度')
    expect(html).toContain('已完成审核: 1/8')
    expect(html).toContain('审核完成</li>')
  })
})
