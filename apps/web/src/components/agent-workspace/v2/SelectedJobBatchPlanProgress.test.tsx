import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ calls: [] as Array<{ url: string; cache: boolean | undefined }>, responses: new Map<string, unknown>() }))
vi.mock('@/lib/hooks', () => ({ useApi: (url: string, options: { cache?: boolean; enabled?: boolean } = {}) => {
  api.calls.push({ url, cache: options.cache })
  return api.responses.get(url) ?? { data: null, loading: options.enabled !== false, error: null, refetch: () => undefined }
} }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { I18nProvider } from '@/lib/i18n'
import type { SelectedJobBatchWorkbenchModel } from '@/lib/agent/session/selected-job-batch-workbench-read-model'
import { SelectedJobBatchPlanProgress, shouldRefetchSelectedJobBatch } from './SelectedJobBatchPlanProgress'
import type { TaskGraphIdentity } from './task-graph-plan-query'

const identity: TaskGraphIdentity = { sessionId: 'session-1', turnId: 'turn-1', graphItemId: 'graph-1', rootTaskId: 'root-1', revision: 4 }
const url = '/api/agent/sessions/session-1/selected-job-batches/turn-1'

function model(overrides: Partial<SelectedJobBatchWorkbenchModel> = {}): SelectedJobBatchWorkbenchModel {
  return {
    sessionId: 'session-1', turnId: 'turn-1',
    source: { sessionId: 'session-1', sourceTurnId: 'source-1', rootTaskId: 'source-root', graphItemId: 'source-graph', graphRevision: 2 },
    graph: null, status: 'pending', jobs: [
      { slotId: 'slot-1', jobId: 'job-1', company: 'Example One', role: 'Engineer', status: 'pending', writer: { status: 'pending' }, reviewer: { status: 'pending' } },
      { slotId: 'slot-2', jobId: 'job-2', company: 'Example Two', role: 'Analyst', status: 'pending', writer: { status: 'pending' }, reviewer: { status: 'pending' } },
    ], ...overrides,
  }
}

function view(response: unknown, expectedGraph: TaskGraphIdentity | null = null, active = true) {
  api.responses.set(url, { data: response, loading: false, error: null, refetch: () => undefined })
  return renderToStaticMarkup(<I18nProvider><SelectedJobBatchPlanProgress sessionId="session-1" turnId="turn-1"
    expectedGraph={expectedGraph} active={active} lifecycleRevision={7} /></I18nProvider>)
}

describe('SelectedJobBatchPlanProgress', () => {
  beforeEach(() => { api.calls = []; api.responses.clear() })

  it('uses an uncached owner read and permits only pending active batches before their graph exists', () => {
    const html = view(model())
    expect(api.calls).toContainEqual({ url, cache: false })
    expect(html).toContain('Example One · Engineer')
    expect(html).toContain('Selected jobs progress')
  })

  it.each([
    model({ sessionId: 'other-session' }),
    model({ turnId: 'other-turn' }),
    model({ graph: { itemId: 'graph-old', rootTaskId: 'root-1', revision: 3 } }),
  ])('hides a response from a different scope or graph revision', response => {
    const html = view(response, identity)
    expect(html).not.toContain('Example One')
    expect(html).toContain('Selected job progress is unavailable.')
  })

  it('requires a matching graph once the selected Turn has one', () => {
    const html = view(model({ graph: { itemId: 'graph-1', rootTaskId: 'root-1', revision: 4 } }), identity, false)
    expect(html).toContain('Example Two · Analyst')
    expect(html).not.toContain('unavailable')
  })

  it('does not allow a graphless historical response and refreshes only on lifecycle changes', () => {
    const html = view(model(), null, false)
    expect(html).toContain('Selected job progress is unavailable.')
    expect(shouldRefetchSelectedJobBatch(7, 8, true)).toBe(true)
    expect(shouldRefetchSelectedJobBatch(7, 7, true)).toBe(false)
    expect(shouldRefetchSelectedJobBatch(7, 8, false)).toBe(false)
  })
})
