import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/lib/i18n'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION } from '@/lib/agent/session/final-task-graph-source-manifest'
import { FinalTaskGraphSources, finalTaskGraphSourceDetailUrl, loadFinalTaskGraphSourceDetail,
  parseFinalTaskGraphSourceDetailResponse, requestMatchesIdentity } from './FinalTaskGraphSources'

const sourceKey = `src_${'A'.repeat(43)}`
const manifest = {
  schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION,
  graphRevision: 4,
  sources: [{ sourceKey, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'missing' }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('FinalTaskGraphSources', () => {
  it('renders only bounded task labels and explains that related tasks are not citations', () => {
    const html = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources
      content={{ taskGraphSources: manifest }} sessionId="private-session-id" finalItemId="private-final-item-id" lang="en"
    /></I18nProvider>)

    expect(html).toContain('data-agent-related-task-sources="true"')
    expect(html).toContain('Related task records')
    expect(html).toContain('not sentence-level citations or independent verification')
    expect(html).toContain('Scout · Completed · Result missing')
    for (const privateValue of [sourceKey, 'private-session-id', 'private-final-item-id', 'graphRevision']) expect(html).not.toContain(privateValue)
  })

  it('omits the panel when the manifest is absent or malformed', () => {
    for (const content of [{ text: 'Answer' }, { taskGraphSources: { ...manifest, taskId: 'private' } }]) {
      const html = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources
        content={content} sessionId="session" finalItemId="item" lang="zh"
      /></I18nProvider>)
      expect(html).not.toContain('data-agent-related-task-sources')
    }
  })

  it('accepts only the exact bounded detail projection', () => {
    const task = {
      goal: 'Find relevant roles', role: 'scout', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' },
    }
    expect(parseFinalTaskGraphSourceDetailResponse({ task })).toEqual(task)
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, taskId: 'PRIVATE_TASK_ID' } })).toBeNull()
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, role: 'internal-control' } })).toBeNull()
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, role: 'writer', roleResultStatus: 'partial' } })).toBeNull()
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, goal: 'x'.repeat(241) } })).toBeNull()
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, verification: { status: 'passed', taskId: 'PRIVATE' } } })).toBeNull()
  })

  it('encodes route identifiers and selector as path segments', () => {
    expect(finalTaskGraphSourceDetailUrl('session/a', 'item b', sourceKey)).toBe(
      `/api/agent/sessions/session%2Fa/final-items/item%20b/task-graph-sources/${sourceKey}`,
    )
  })

  it('drops a cancelled response after JSON parsing and binds a fast reselect to its full identity', async () => {
    const firstBody = deferred<unknown>(), firstBodyStarted = deferred<void>()
    const secondBody = deferred<unknown>(), secondBodyStarted = deferred<void>()
    const response = (body: ReturnType<typeof deferred<unknown>>, started: ReturnType<typeof deferred<void>>) => ({
      ok: true, json: () => { started.resolve(); return body.promise },
    } as unknown as Response)
    const fetcher: typeof fetch = async () => response(firstBody, firstBodyStarted)
    const firstController = new AbortController()
    const firstIdentity = { sessionId: 'session-1', finalItemId: 'item-1', sourceKey }
    const firstRequest = loadFinalTaskGraphSourceDetail(firstIdentity, firstController.signal, fetcher)
    await firstBodyStarted.promise
    firstController.abort()

    const secondIdentity = { sessionId: 'session-2', finalItemId: 'item-2', sourceKey: `src_${'B'.repeat(43)}` }
    const secondFetcher: typeof fetch = async () => response(secondBody, secondBodyStarted)
    const secondRequest = loadFinalTaskGraphSourceDetail(secondIdentity, new AbortController().signal, secondFetcher)
    await secondBodyStarted.promise
    firstBody.resolve({ task: { goal: 'Stale goal', role: 'scout', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' } } })
    expect(await firstRequest).toBeNull()

    secondBody.resolve({ task: { goal: 'Current goal', role: 'scout', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' } } })
    const current = await secondRequest
    expect(current).toMatchObject({ ...secondIdentity, state: 'ready', detail: { goal: 'Current goal' } })
    expect(requestMatchesIdentity(current, secondIdentity)).toBe(true)
    expect(requestMatchesIdentity(current, firstIdentity)).toBe(false)
  })
})
