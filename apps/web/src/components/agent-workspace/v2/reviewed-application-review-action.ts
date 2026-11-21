export interface ReviewedApplicationReviewRequest {
  readonly sessionId: string
  readonly sourceTurnId: string
  readonly idempotencyKey: string
  readonly signal?: AbortSignal
}

export interface ReviewedApplicationReviewResult {
  readonly turnId: string
  readonly disposition: 'started' | 'duplicate'
}

export function canRequestReviewedApplicationReview(input: {
  readonly authenticated: boolean
  readonly sourceTurnId: string | null
  readonly isCurrentVersion: boolean
  readonly reviewStatus: string | null
  readonly sourceFreshness: string
}): boolean {
  return input.authenticated && validIdentity(input.sourceTurnId)
    && input.isCurrentVersion && input.reviewStatus === 'passed' && input.sourceFreshness === 'current'
}

export function createReviewedApplicationReviewId(): string {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `reviewed-application-review-${randomId}`
}

/** Reuses one command key per exact UI intent, including an uncertain retry after a lost response. */
export function reviewedApplicationReviewIdForSelection(ids: Map<string, string>, selectionKey: string): string {
  const existing = ids.get(selectionKey)
  if (existing) return existing
  const id = createReviewedApplicationReviewId()
  ids.set(selectionKey, id)
  return id
}

/** A late completion can update UI only while the original selection remains current. */
export function isCurrentReviewedApplicationReviewRequest(currentKey: string, requestKey: string): boolean {
  return currentKey === requestKey
}

export async function postReviewedApplicationReview(
  request: ReviewedApplicationReviewRequest,
  fetcher: typeof fetch = fetch,
): Promise<ReviewedApplicationReviewResult> {
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(request.sessionId)}/reviewed-application-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ sourceTurnId: request.sourceTurnId, idempotencyKey: request.idempotencyKey }),
    ...(request.signal ? { signal: request.signal } : {}),
  })
  if (!response.ok) throw new ReviewedApplicationReviewRequestError(response.status)
  const body = await response.json().catch(() => null) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Review request returned an invalid response')
  const row = body as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'disposition,turnId'
    || typeof row.turnId !== 'string' || !validIdentity(row.turnId)
    || (row.disposition !== 'started' && row.disposition !== 'duplicate')) {
    throw new Error('Review request returned an invalid response')
  }
  return { turnId: row.turnId, disposition: row.disposition }
}

export class ReviewedApplicationReviewRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Reviewed application review request failed with status ${status}`)
    this.name = 'ReviewedApplicationReviewRequestError'
    this.status = status
  }
}

function validIdentity(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
