import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ObjectiveContributingJobs, loadObjectiveJobEvidence, objectiveJobEvidenceUrl,
  parseObjectiveJobEvidenceResponse, type ObjectiveContributingJobsRequest } from './ObjectiveContributingJobs'

const discovered = `src_${'A'.repeat(43)}`
const analyzed = `src_${'B'.repeat(43)}`
const request: ObjectiveContributingJobsRequest = {
  sessionId: 'session', finalItemId: 'item', group: 'discoveredJobs', graphRevision: 4,
  sourceKeys: [discovered, analyzed], expectedCount: 2, expectedCoverage: 'complete', lang: 'en',
}

function body(overrides: Record<string, unknown> = {}) {
  return { jobEvidence: {
    schemaVersion: 'agent-harness.v2.objective-job-evidence.v1', graphRevision: 4, group: 'discoveredJobs',
    coverage: 'complete', count: 2, jobs: [
      { ordinal: 1, role: 'Software Engineer', company: 'Acme', location: 'Dublin', postingUrl: 'https://jobs.example.test/acme', sourceKeys: [discovered] },
      { ordinal: 2, role: 'Platform Engineer', company: 'Beta', location: null, postingUrl: null, sourceKeys: [analyzed] },
    ], ...overrides,
  } }
}

function response(value: unknown, ok = true) {
  return { ok, json: async () => value } as unknown as Response
}

describe('ObjectiveContributingJobs', () => {
  it('waits for the explicit saved-jobs action and keeps task keys out of the initial card', () => {
    const html = renderToStaticMarkup(<ObjectiveContributingJobs {...request} />)
    expect(html).toContain('View saved jobs')
    expect(html).not.toContain('Acme')
    expect(html).not.toContain(discovered)
    expect(html).not.toContain('fetch(')
  })

  it('accepts only the exact wrapper, group, revision, count, coverage, and source-key set', () => {
    const parsed = parseObjectiveJobEvidenceResponse(body(), request)
    expect(parsed?.jobs.map(job => job.company)).toEqual(['Acme', 'Beta'])
    for (const bad of [
      { ...body(), jobEvidence: { ...body().jobEvidence, graphRevision: 5 } },
      { ...body(), jobEvidence: { ...body().jobEvidence, group: 'analyzedJobs' } },
      { ...body(), jobEvidence: { ...body().jobEvidence, count: 1 } },
      { ...body(), jobEvidence: { ...body().jobEvidence, jobs: [{ ...body().jobEvidence.jobs[0], sourceKeys: [`src_${'C'.repeat(43)}`] }, body().jobEvidence.jobs[1]] } },
      { ...body(), jobEvidence: { ...body().jobEvidence, jobs: [{ ...body().jobEvidence.jobs[0], postingUrl: 'javascript:alert(1)' }, body().jobEvidence.jobs[1]] } },
      { ...body(), extra: 'private' },
    ]) expect(parseObjectiveJobEvidenceResponse(bad, request)).toBeNull()
  })

  it('uses the encoded route and drops unavailable or aborted responses', async () => {
    expect(objectiveJobEvidenceUrl('session/a', 'item b', 'analyzedJobs', 8)).toBe(
      '/api/agent/sessions/session%2Fa/final-items/item%20b/objective-job-groups/analyzedJobs?graphRevision=8')
    const fetcher: typeof fetch = async () => response(body())
    await expect(loadObjectiveJobEvidence(request, new AbortController().signal, fetcher)).resolves.toMatchObject({ graphRevision: 4 })
    await expect(loadObjectiveJobEvidence(request, new AbortController().signal, async () => response({}, false))).resolves.toBeNull()
    const controller = new AbortController()
    controller.abort()
    await expect(loadObjectiveJobEvidence(request, controller.signal, fetcher)).resolves.toBeNull()
  })

  it('renders bounded saved job fields and a safe current posting link after data is loaded', () => {
    const html = renderToStaticMarkup(<ObjectiveContributingJobs {...request} />)
    expect(html).toContain('aria-controls="objective-job-evidence-')
    expect(html).not.toContain('Open current posting')
  })
})
