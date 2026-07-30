import { describe, expect, it } from 'vitest'

import type { GmailRecommendation, GmailTrackingResponse } from './types'

describe('Gmail tracker view types', () => {
  it('represents the recommendation queue returned to the management page', () => {
    const recommendation: GmailRecommendation = {
      id: 'recommendation-1', platform: 'Indeed', company: 'Example', role: 'Product Designer', location: 'Dublin', salary: null, url: null, description: null,
      status: 'pending', createdAt: '2026-07-29T08:00:00.000Z',
      sourceMessage: { gmailMessageId: 'gmail-1', gmailThreadId: null, subject: 'Job alert', receivedAt: '2026-07-29T08:00:00.000Z', senderName: 'Indeed', senderEmail: 'alerts@example.com', matchConfidence: null },
      savedJob: null,
    }
    const response: GmailTrackingResponse = { recommendations: [recommendation], pendingRecommendationCount: 1 }

    expect(response.recommendations?.[0].status).toBe('pending')
  })
})
