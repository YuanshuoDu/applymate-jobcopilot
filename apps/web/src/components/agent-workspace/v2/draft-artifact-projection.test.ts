import { describe, expect, it } from 'vitest'

import { latestWriterArtifact, parseDraftArtifactPayload, selectedDraftArtifactUrl, type DraftArtifactRef } from './draft-artifact-projection'

const ref: DraftArtifactRef = { artifactId: 'draft/1', version: 2, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }
const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'writer-1', sessionId: 'session-1', turnId: 'turn-1', role: 'writer', taskType: 'cover_letter_draft',
  status: 'passed', goal: 'Prepare draft', hasResult: true, updatedAt: '2026-09-29T00:00:00Z', artifactRef: ref, ...overrides,
})

describe('selected job draft artifact projection', () => {
  it('selects only the newest writer artifact from this session', () => {
    const activeGraph = { sessionId: 'session-1', graphItemId: 'graph-1', turnId: 'turn-1', rootTaskId: 'root-1', revision: 2 }
    expect(latestWriterArtifact('session-1', [task({ rootTaskId: 'root-1' }), task({ id: 'reviewer', rootTaskId: 'root-1', role: 'reviewer', taskType: 'cover_letter_review' }), task({ id: 'other-session', sessionId: 'session-2', rootTaskId: 'root-1' })], activeGraph)).toEqual(ref)
    expect(latestWriterArtifact('session-2', [task({ rootTaskId: 'root-1' })], activeGraph)).toBeNull()
  })

  it('hides an older session draft while the active graph has no Writer receipt', () => {
    const activeGraph = { sessionId: 'session-1', graphItemId: 'graph-2', turnId: 'turn-2', rootTaskId: 'root-2', revision: 1 }
    const olderDraft = task({ turnId: 'turn-1', rootTaskId: 'root-1', updatedAt: '2026-09-30T00:00:00Z' })
    const currentWithoutReceipt = task({ id: 'writer-2', turnId: 'turn-2', rootTaskId: 'root-2', artifactRef: undefined, updatedAt: '2026-09-30T00:01:00Z' })

    expect(latestWriterArtifact('session-1', [olderDraft, currentWithoutReceipt], activeGraph)).toBeNull()
  })

  it('accepts only Writer receipts from the active TaskGraph turn and root', () => {
    const activeGraph = { sessionId: 'session-1', graphItemId: 'graph-2', turnId: 'turn-2', rootTaskId: 'root-2', revision: 1 }
    const olderDraft = task({ turnId: 'turn-1', rootTaskId: 'root-1' })
    const currentDraft = task({ id: 'writer-2', turnId: 'turn-2', rootTaskId: 'root-2' })

    expect(latestWriterArtifact('session-1', [olderDraft, currentDraft], activeGraph)).toEqual(ref)
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
    const activeGraph = { sessionId: 'session-1', graphItemId: 'graph-1', turnId: 'turn-1', rootTaskId: 'root-1', revision: 2 }
    expect(latestWriterArtifact('session-1', [task({ rootTaskId: 'root-1', artifactRef: { ...ref, userId: 'foreign' } })], activeGraph)).toBeNull()
    expect(parseDraftArtifactPayload({ job: { company: 'N26', role: 'Engineer' }, artifact: { ...ref, content: { text: 'wrong' } }, content: { text: 'private' }, review: null }, { ...ref, version: 3 })).toBeNull()
  })
})
