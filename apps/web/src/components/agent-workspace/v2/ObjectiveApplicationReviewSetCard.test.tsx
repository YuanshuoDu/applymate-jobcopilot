import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'

const api = vi.hoisted(() => ({ data: null as unknown }))
vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: api.data, error: null, loading: false, refetch: vi.fn() }) }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { ObjectiveApplicationReviewSetCard, parseObjectiveApplicationReviewSnapshot } from './ObjectiveApplicationReviewSetCard'

const reviewTurnId = 'review-turn-1'
const member = (decisionAvailable: boolean) => ({
  slotOrdinal: 3, approvalId: 'objective-review:opaque-set:3', status: 'pending', receiptRevision: 2,
  job: { company: 'Example', role: 'Engineer' },
  artifactRef: { artifactId: 'draft-3', version: 4, contentHash: 'sha256:' + 'a'.repeat(64), sourceDigest: 'sha256:' + 'b'.repeat(64) },
  resumeId: 'resume-3', decisionAvailable,
})
function content(decisionAvailable: boolean) {
  return { snapshot: { turnId: reviewTurnId, turnRevision: 7, setStatus: 'pending', members: [member(decisionAvailable)] } }
}

beforeEach(() => { api.data = content(true) })

describe('ObjectiveApplicationReviewSetCard', () => {
  it('shows the exact job material with per-member approve and decline controls', () => {
    const html = renderToStaticMarkup(<I18nProvider><ObjectiveApplicationReviewSetCard sessionId="session-1" turnId={reviewTurnId} refreshKey="1" onAccepted={() => undefined} /></I18nProvider>)
    expect(html).toContain('Engineer · Example')
    expect(html).toContain('View reviewed draft')
    expect(html).not.toContain('data-selected-job-draft="true"')
    expect(html).toContain('/resume/resume-3/print')
    expect(html).toContain('Approve for form fill')
    expect(html).toContain('Decline')
    expect(html).toContain('Submitting an application requires separate approval.')
    expect(html).not.toContain('objective-review:opaque-set:3')
    expect(html).not.toContain('sha256:')
  })

  it('keeps decline available for stale pending material while hiding approval', () => {
    api.data = content(false)
    const html = renderToStaticMarkup(<I18nProvider><ObjectiveApplicationReviewSetCard sessionId="session-1" turnId={reviewTurnId} refreshKey="2" onAccepted={() => undefined} /></I18nProvider>)
    expect(html).not.toContain('Approve for form fill')
    expect(html).toContain('Decline')
    expect(html).toContain('Close this request to start a fresh review.')
    expect(html).toContain('data-objective-review-member="pending"')
  })

  it('rejects foreign identities, extra proof fields, and malformed member order', () => {
    expect(parseObjectiveApplicationReviewSnapshot(content(true).snapshot, 'foreign-turn')).toBeNull()
    expect(parseObjectiveApplicationReviewSnapshot({ ...content(true), privateProof: 'secret' }, reviewTurnId)).toBeNull()
    expect(parseObjectiveApplicationReviewSnapshot({ ...content(true).snapshot, members: [
      { ...member(true), slotOrdinal: 4, approvalId: 'objective-review:opaque-set:4' },
      { ...member(true), slotOrdinal: 3, approvalId: 'objective-review:opaque-set:3' },
    ] }, reviewTurnId)).toBeNull()
    expect(parseObjectiveApplicationReviewSnapshot({ ...content(true).snapshot, members: [{ ...member(true), privateProof: 'secret' }] }, reviewTurnId)).toBeNull()
  })
})
