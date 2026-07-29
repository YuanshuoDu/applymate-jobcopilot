import { describe, expect, it } from 'vitest'

import type { GmailTrackingResponse, TrackedGmailMessage } from './types'

describe('Gmail tracker view types', () => {
  it('represents persisted application evidence with an optional linked job', () => {
    const message: TrackedGmailMessage = {
      id: 'message-1',
      gmailMessageId: 'gmail-1',
      gmailThreadId: null,
      kind: 'interview_invitation',
      senderEmail: 'talent@example.com',
      senderName: 'Talent team',
      subject: 'Interview invitation',
      excerpt: 'Choose a time for your interview.',
      inferredCompany: 'Example',
      inferredRole: 'Product Designer',
      receivedAt: '2026-07-29T08:00:00.000Z',
      job: { id: 'job-1', company: 'Example', role: 'Product Designer', status: 'interview' },
    }
    const response: GmailTrackingResponse = { messages: [message], pendingRecommendationCount: 0 }

    expect(response.messages?.[0].job?.status).toBe('interview')
  })
})
