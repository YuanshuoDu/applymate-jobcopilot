import { describe, expect, it } from 'vitest'

import { latestWriterArtifact, parseDraftArtifactPayload, selectedDraftArtifactUrl, type DraftArtifactRef } from './draft-artifact-projection'

const ref: DraftArtifactRef = { artifactId: 'draft/1', version: 2, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }
const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'writer-1', sessionId: 'session-1', turnId: 'turn-1', role: 'writer', taskType: 'cover_letter_draft',
  status: 'passed', goal: 'Prepare draft', hasResult: true, updatedAt: '2026-09-29T00:00:00Z', artifactRef: ref, ...overrides,
})

describe('selected job draft artifact projection', () => {
  it('selects only the newest writer artifact from this session', () => {
    expect(latestWriterArtifact('session-1', [task(), task({ id: 'reviewer', role: 'reviewer', taskType: 'cover_letter_review' }), task({ id: 'other-session', sessionId: 'session-2' })])).toEqual(ref)
    expect(latestWriterArtifact('session-2', [task()])).toBeNull()
  })

  it('builds a URL bound to the full immutable ref', () => {
    expect(selectedDraftArtifactUrl('session/1', ref)).toBe(`/api/agent/sessions/session%2F1/artifacts/draft%2F1/versions/2?contentHash=${encodeURIComponent(ref.contentHash)}&sourceDigest=${encodeURIComponent(ref.sourceDigest)}`)
  })

  it('accepts content only when every immutable reference field matches', () => {
    const payload = { job: { company: 'N26', role: 'Engineer' }, artifact: { ...ref, content: { text: 'Draft body' }, provenanceRefs: ['persona:fact-1'], evidenceRefs: ['job:job-1'] }, review: { status: 'needs_revision', reviewHash: 'review-hash', evidenceRefs: ['resume:fact-2'], findings: [{ code: 'claim', severity: 'warning', message: 'Check this claim.', evidenceRefs: ['resume:fact-2'] }] } }
    expect(parseDraftArtifactPayload(payload, ref)).toMatchObject({ artifact: { content: { text: 'Draft body' }, evidenceRefs: ['job:job-1'] }, review: { status: 'needs_revision' } })
    expect(parseDraftArtifactPayload({ ...payload, artifact: { ...payload.artifact, contentHash: `sha256:${'c'.repeat(64)}` } }, ref)).toBeNull()
  })

  it('rejects malformed refs and never accepts draft text from arbitrary fields', () => {
    expect(latestWriterArtifact('session-1', [task({ artifactRef: { ...ref, userId: 'foreign' } })])).toBeNull()
    expect(parseDraftArtifactPayload({ job: { company: 'N26', role: 'Engineer' }, artifact: { ...ref, content: { text: 'wrong' } }, content: { text: 'private' }, review: null }, { ...ref, version: 3 })).toBeNull()
  })
})
