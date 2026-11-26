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

  it('exposes a focusable target only when the Objective card provides its generated id', () => {
    const matching = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources content={{ taskGraphSources: manifest }}
      sessionId="session" finalItemId="item" lang="en"
      navigationTargetId="related-task-sources-:R1:" /></I18nProvider>)
    expect(matching).toContain('data-agent-related-task-sources="true" id="related-task-sources-:R1:" tabindex="-1"')

    const withoutNavigation = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources content={{ taskGraphSources: manifest }}
      sessionId="session" finalItemId="item" lang="en" /></I18nProvider>)
    expect(withoutNavigation).not.toContain('id="related-task-sources-')
    expect(withoutNavigation).not.toContain('tabindex="-1"')
  })

  it('marks only the validated group rows without opening lazy task detail', () => {
    const scout = `src_${'S'.repeat(43)}`, otherScout = `src_${'T'.repeat(43)}`, analyst = `src_${'U'.repeat(43)}`
    const groupedManifest = { schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: 12, sources: [
      { sourceKey: scout, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
      { sourceKey: otherScout, nodeIndex: 1, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
      { sourceKey: analyst, nodeIndex: 2, role: 'analyst', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'partial' },
    ] }
    const groups = { schemaVersion: 'agent-harness.v2.objective-tailor-source-groups.v1', graphRevision: 12,
      groups: { discoveredJobs: [scout], analyzedJobs: [analyst] } }
    const groupedContent = { taskGraphSources: groupedManifest, objectiveTailorFinalOutcomes: {
      schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v2', graphRevision: 12,
      slots: [{ ordinal: 1, status: 'ready' }], sourceCounts: {
        discoveredJobs: { knownCount: 1, coverage: 'complete' }, analyzedJobs: { knownCount: 1, coverage: 'complete' },
      },
    }, objectiveTailorSourceGroups: groups }
    const html = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources content={groupedContent}
      sessionId="session" finalItemId="item" lang="en" sourceGroupSelection={{ group: 'discoveredJobs',
        sourceKeys: [scout], graphRevision: 12, requestId: 1 }} /></I18nProvider>)
    expect(html).toContain('data-objective-source-group-selection="true"')
    expect(html).toContain('data-objective-source-group="discoveredJobs"')
    expect(html).toContain('data-objective-source-group-member="true"')
    expect(html.match(/data-objective-source-group-member="true"/g)).toHaveLength(1)
    expect(html).not.toContain(scout)
    expect(html).not.toContain(otherScout)
    expect(html).not.toContain(analyst)
    expect(html).not.toContain('data-task-graph-source-detail="true"')

    const stale = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources content={groupedContent}
      sessionId="session" finalItemId="item" lang="en" sourceGroupSelection={{ group: 'discoveredJobs',
        sourceKeys: [scout], graphRevision: 11, requestId: 2 }} /></I18nProvider>)
    expect(stale).not.toContain('data-objective-source-group-selection="true"')
    expect(stale).not.toContain('data-objective-source-group-member="true"')
    expect(stale).not.toContain('tabindex="-1"')

    const changed = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources content={{ ...groupedContent,
      objectiveTailorSourceGroups: { ...groups, groups: { discoveredJobs: [otherScout], analyzedJobs: [analyst] } } }}
      sessionId="session" finalItemId="item" lang="en" sourceGroupSelection={{ group: 'discoveredJobs',
        sourceKeys: [scout], graphRevision: 12, requestId: 3 }} /></I18nProvider>)
    expect(changed).not.toContain('data-objective-source-group-selection="true"')
    expect(changed).not.toContain('data-objective-source-group-member="true"')
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
