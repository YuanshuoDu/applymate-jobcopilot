import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { RecommendationList } from './RecommendationList'
import type { GmailRecommendation } from './types'

const recommendation: GmailRecommendation = {
  id: 'recommendation-1', platform: 'Indeed', company: 'HubSpot', role: 'Senior Support Engineer', location: 'Dublin, Ireland', salary: '€55k–€65k',
  url: 'https://example.com/job', description: 'Help customers troubleshoot technical issues.', status: 'pending', createdAt: '2026-07-29T08:00:00.000Z',
  sourceMessage: { gmailMessageId: 'gmail-1', gmailThreadId: 'thread-1', subject: 'New jobs from Indeed', receivedAt: '2026-07-29T08:00:00.000Z', senderName: 'Indeed Jobs', senderEmail: 'jobs@indeed.com', matchConfidence: null }, savedJob: null,
}

describe('RecommendationList', () => {
  it('renders recommendations as a grouped table with the primary actions', () => {
    const html = renderToString(<RecommendationList recommendations={[recommendation]} selectedIds={new Set()} expandedId={null} busyIds={new Set()} onToggle={vi.fn()} onToggleAll={vi.fn()} onExpand={vi.fn()} onAction={vi.fn()} />)

    expect(html).toContain('<table')
    expect(html).toContain('Senior Support Engineer')
    expect(html).toContain('Indeed logo')
    expect(html).toContain('recommendation-save')
    expect(html).toContain('Save')
    expect(html).toContain('Dismiss')
  })

  it('renders source email detail inside the expanded list row', () => {
    const html = renderToString(<RecommendationList recommendations={[recommendation]} selectedIds={new Set()} expandedId={recommendation.id} busyIds={new Set()} onToggle={vi.fn()} onToggleAll={vi.fn()} onExpand={vi.fn()} onAction={vi.fn()} />)

    expect(html).toContain('Email subject:')
    expect(html).toContain('Open source email')
    expect(html).toContain('Salary:')
    expect(html).toContain('Help customers troubleshoot technical issues.')
  })
})
