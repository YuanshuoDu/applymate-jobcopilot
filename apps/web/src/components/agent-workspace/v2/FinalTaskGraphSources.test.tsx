import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/lib/i18n'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION, TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2,
  TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, parseFinalTaskGraphSourceManifest } from '@/lib/agent/session/final-task-graph-source-manifest'
import { FinalTaskGraphSources, finalTaskGraphSourceDetailUrl, loadFinalTaskGraphSourceDetail,
  artifactViewerKey, coverLetterVersionLabel, parseFinalTaskGraphSourceDetailResponse,
  requestMatchesIdentity, viewableSourceArtifactRef } from './FinalTaskGraphSources'

const sourceKey = `src_${'A'.repeat(43)}`
const manifest = {
  schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION,
  graphRevision: 4,
  sources: [{ sourceKey, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'missing' }],
}
const artifactRef = {
  artifactId: 'private-artifact-id', version: 3, contentHash: 'sha256:' + 'a'.repeat(64), sourceDigest: 'sha256:' + 'b'.repeat(64),
}
const artifactVersionProof = 'avp_' + 'c'.repeat(64)
const coveredSource = {
  sourceKey, nodeIndex: 0, role: 'writer', taskStatus: 'completed', resultState: 'valid',
  roleResultStatus: 'completed', artifactVersionProof,
}
const unprovenWriter = {
  sourceKey: `src_${'B'.repeat(43)}`, nodeIndex: 1, role: 'writer', taskStatus: 'completed', resultState: 'valid',
  roleResultStatus: 'completed',
}
const coveredReviewer = {
  sourceKey: `src_${'C'.repeat(43)}`, nodeIndex: 2, role: 'reviewer', taskStatus: 'completed', resultState: 'valid',
  roleResultStatus: 'completed', artifactVersionProof,
}
const v3Manifest = {
  schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, graphRevision: 4, historicalNodeIndices: [],
  sources: [coveredSource, unprovenWriter, coveredReviewer],
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

  it('accepts a closed owner-verified artifact ref and rejects malformed or widened refs', () => {
    const task = {
      goal: 'Write a cover letter', role: 'writer', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' }, artifactRef,
    }
    expect(parseFinalTaskGraphSourceDetailResponse({ task })).toMatchObject({ artifactRef, role: 'writer' })
    for (const invalid of [
      { ...artifactRef, version: 0 },
      { ...artifactRef, contentHash: 'sha256:' + 'A'.repeat(64) },
      { ...artifactRef, extra: 'private' },
      null,
    ]) {
      expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, artifactRef: invalid } })).toBeNull()
    }
    const noOwnerArtifact = { ...task }
    delete (noOwnerArtifact as { artifactRef?: typeof artifactRef }).artifactRef
    expect(parseFinalTaskGraphSourceDetailResponse({ task: noOwnerArtifact })).not.toHaveProperty('artifactRef')
    expect(parseFinalTaskGraphSourceDetailResponse({ task: { ...task, role: 'scout' } })).toBeNull()
    expect(parseFinalTaskGraphSourceDetailResponse({ task: {
      goal: task.goal, role: 'writer', taskStatus: 'failed', resultState: 'invalid', verification: task.verification, artifactRef,
    } })).toBeNull()
  })

  it('exposes only an exact verified artifact ref for a proof-backed V3 Writer or Reviewer source', () => {
    const parsedV3 = parseFinalTaskGraphSourceManifest(v3Manifest)
    expect(parsedV3).not.toBeNull()
    const verifiedDetail = parseFinalTaskGraphSourceDetailResponse({ task: {
      goal: 'Write a cover letter', role: 'writer', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' }, artifactRef,
    } })
    expect(viewableSourceArtifactRef(parsedV3, parsedV3?.sources[0], verifiedDetail)).toEqual(artifactRef)
    expect(viewableSourceArtifactRef(parsedV3, parsedV3?.sources[1], verifiedDetail)).toBeNull()
    expect(viewableSourceArtifactRef(parsedV3, { ...coveredSource, role: 'scout' }, verifiedDetail)).toBeNull()
    const reviewerDetail = parseFinalTaskGraphSourceDetailResponse({ task: {
      goal: 'Review the cover letter', role: 'reviewer', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' }, artifactRef,
    } })
    expect(viewableSourceArtifactRef(parsedV3, parsedV3?.sources[2], reviewerDetail)).toEqual(artifactRef)
    expect(viewableSourceArtifactRef(parsedV3, parsedV3?.sources[0], reviewerDetail)).toBeNull()
    expect(viewableSourceArtifactRef(parsedV3, parsedV3?.sources[0], parseFinalTaskGraphSourceDetailResponse({ task: {
      goal: 'Write a cover letter', role: 'writer', taskStatus: 'completed', resultState: 'valid',
      roleResultStatus: 'completed', verification: { status: 'unavailable' },
    } }))).toBeNull()

    const v1 = parseFinalTaskGraphSourceManifest(manifest)
    const v2 = parseFinalTaskGraphSourceManifest({ ...manifest, schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2, historicalNodeIndices: [1] })
    expect(viewableSourceArtifactRef(v1, coveredSource, verifiedDetail)).toBeNull()
    expect(viewableSourceArtifactRef(v2, coveredSource, verifiedDetail)).toBeNull()
    expect(coverLetterVersionLabel(3, 'en')).toBe('View cover letter version 3')
    expect(coverLetterVersionLabel(3, 'zh')).toBe('查看求职信第 3 版')
  })

  it('keeps the viewer unmounted until a proof-backed source has explicit selection', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const html = renderToStaticMarkup(<I18nProvider><FinalTaskGraphSources
        content={{ taskGraphSources: v3Manifest }} sessionId="session-1" finalItemId="item-1" lang="en"
      /></I18nProvider>)
      expect(html).toContain('data-agent-related-task-sources="true"')
      expect(html).not.toContain('data-cover-letter-version-access')
      expect(html).not.toContain('data-selected-job-draft')
      expect(html).not.toContain(artifactVersionProof)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keys the disclosure to the exact session, final item, source, and artifact identity', () => {
    const identity = { sessionId: 'session-1', finalItemId: 'item-1', sourceKey, artifactRef }
    const originalKey = artifactViewerKey(identity)
    expect(artifactViewerKey(identity)).toBe(originalKey)
    for (const next of [
      { ...identity, sessionId: 'session-2' },
      { ...identity, finalItemId: 'item-2' },
      { ...identity, sourceKey: `src_${'B'.repeat(43)}` },
      { ...identity, artifactRef: { ...artifactRef, version: 4 } },
      { ...identity, artifactRef: { ...artifactRef, contentHash: 'sha256:' + 'd'.repeat(64) } },
    ]) expect(artifactViewerKey(next)).not.toBe(originalKey)
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
