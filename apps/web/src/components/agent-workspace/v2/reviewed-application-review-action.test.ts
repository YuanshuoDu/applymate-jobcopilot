import { describe, expect, it, vi } from 'vitest'

import {
  canRequestReviewedApplicationReview,
  createReviewedApplicationReviewId,
  isCurrentReviewedApplicationReviewRequest,
  postReviewedApplicationReview,
  reviewedApplicationReviewIdForSelection,
} from './reviewed-application-review-action'

function response(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('reviewed application review action', () => {
  it('requires authenticated current review-passed material with fresh source evidence and a source Turn', () => {
    const eligible = { authenticated: true, sourceTurnId: 'turn_source', isCurrentVersion: true, reviewStatus: 'passed', sourceFreshness: 'current' }
    expect(canRequestReviewedApplicationReview(eligible)).toBe(true)
    for (const change of [
      { authenticated: false }, { sourceTurnId: null }, { sourceTurnId: ' ' }, { isCurrentVersion: false },
      { reviewStatus: 'needs_revision' }, { sourceFreshness: 'stale' }, { sourceFreshness: 'unavailable' },
    ]) expect(canRequestReviewedApplicationReview({ ...eligible, ...change })).toBe(false)
  })

  it('posts only the exact selected source and idempotency key with same-origin credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ turnId: 'turn_review', disposition: 'started' }))
    await expect(postReviewedApplicationReview({ sessionId: 'session/one', sourceTurnId: 'turn_source', idempotencyKey: 'request-1' }, fetcher))
      .resolves.toEqual({ turnId: 'turn_review', disposition: 'started' })
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2Fone/reviewed-application-review', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceTurnId: 'turn_source', idempotencyKey: 'request-1' }),
    }))
    expect(createReviewedApplicationReviewId()).not.toBe(createReviewedApplicationReviewId())
  })

  it('fails safely on conflicts and rejects unrecognized result shapes', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: 'private detail' }, 409))
      .mockResolvedValueOnce(response({ turnId: 'turn', disposition: 'started', sourceText: 'must not leak' }))
    await expect(postReviewedApplicationReview({ sessionId: 's', sourceTurnId: 't', idempotencyKey: 'k' }, fetcher)).rejects.toThrow('status 409')
    await expect(postReviewedApplicationReview({ sessionId: 's', sourceTurnId: 't', idempotencyKey: 'k' }, fetcher)).rejects.toThrow('invalid response')
  })

  it('discards a late response after session, source Turn, or artifact selection changes', () => {
    const requestKey = 'user:session:source:artifact:v1:hash-a'
    expect(isCurrentReviewedApplicationReviewRequest('user:session:source:artifact:v1:hash-a', requestKey)).toBe(true)
    for (const currentKey of [
      'user:other-session:source:artifact:v1:hash-a', 'user:session:other-source:artifact:v1:hash-a',
      'user:session:source:other-artifact:v1:hash-a', 'user:session:source:artifact:v2:hash-b',
    ]) expect(isCurrentReviewedApplicationReviewRequest(currentKey, requestKey)).toBe(false)
  })

  it('reuses one idempotency key when retrying the same selected review intent', () => {
    const ids = new Map<string, string>()
    const first = reviewedApplicationReviewIdForSelection(ids, 'user:session:turn:artifact:v1')
    expect(reviewedApplicationReviewIdForSelection(ids, 'user:session:turn:artifact:v1')).toBe(first)
    const other = reviewedApplicationReviewIdForSelection(ids, 'user:session:turn:v2')
    expect(other).not.toBe(first)
    expect(reviewedApplicationReviewIdForSelection(ids, 'user:session:turn:artifact:v1')).toBe(first)
  })
})
