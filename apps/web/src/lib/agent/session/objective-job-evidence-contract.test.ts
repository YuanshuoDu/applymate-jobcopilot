import { describe, expect, it } from 'vitest'
import { OBJECTIVE_JOB_EVIDENCE_SCHEMA, parseObjectiveJobEvidence } from './objective-job-evidence-contract'

const sourceKey = `src_${'a'.repeat(43)}`
const base = {
  schemaVersion: OBJECTIVE_JOB_EVIDENCE_SCHEMA, graphRevision: 4, group: 'discoveredJobs', coverage: 'partial', count: 1,
  jobs: [{ ordinal: 1, role: 'Engineer', company: 'Acme', location: 'Dublin', postingUrl: 'https://jobs.example/1', sourceKeys: [sourceKey] }],
}

describe('Objective Job evidence contract', () => {
  it('accepts the closed complete and partial projections', () => {
    expect(parseObjectiveJobEvidence(base)).toEqual(base)
    expect(parseObjectiveJobEvidence({ ...base, coverage: 'complete', group: 'analyzedJobs', jobs: [{ ...base.jobs[0], role: 'Engineer' }] })).toMatchObject({ group: 'analyzedJobs', coverage: 'complete' })
  })

  it('rejects zero and empty projections so the GET remains unavailable', () => {
    expect(parseObjectiveJobEvidence({ ...base, count: 0, coverage: 'complete', jobs: [] })).toBeUndefined()
    expect(parseObjectiveJobEvidence({ ...base, count: 0, jobs: [] })).toBeUndefined()
  })

  it.each([
    { ...base, count: 2 },
    { ...base, jobs: [{ ...base.jobs[0], ordinal: 2 }] },
    { ...base, jobs: [{ ...base.jobs[0], sourceKeys: [sourceKey, sourceKey] }] },
    { ...base, jobs: [{ ...base.jobs[0], postingUrl: 'http://jobs.example/1' }] },
    { ...base, jobs: [{ ...base.jobs[0], postingUrl: 'https:jobs.example/1' }] },
    { ...base, jobs: [{ ...base.jobs[0], postingUrl: 'https://jobs.example/one\\two' }] },
    { ...base, privateTaskId: 'task-secret' },
  ])('rejects malformed or private projections', value => expect(parseObjectiveJobEvidence(value)).toBeUndefined())

  it('rejects accessor-backed data instead of invoking it', () => {
    const value = { ...base, jobs: [...base.jobs] } as { jobs: unknown[] }
    Object.defineProperty(value.jobs[0], 'company', { enumerable: true, get: () => 'Acme' })
    expect(parseObjectiveJobEvidence(value)).toBeUndefined()
  })
})
