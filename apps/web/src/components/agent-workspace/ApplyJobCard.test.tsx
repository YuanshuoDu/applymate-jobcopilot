import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { ApplyJobCard, type ApplyReadyJob } from './ApplyJobCard'

const auth = vi.hoisted(() => ({ userId: 'user-1' }))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: auth.userId } }, status: 'authenticated' }),
}))

const job: ApplyReadyJob = {
  jobId: 'job-1',
  company: 'N26',
  role: 'Software Engineer',
  score: 94,
  url: 'https://example.com/apply',
  location: 'Berlin',
  matchedKeywords: ['TypeScript'],
}

describe('ApplyJobCard', () => {
  it('offers employer navigation and a separate explicit submitted-record action', () => {
    const html = renderToString(<ApplyJobCard job={job} onApplied={vi.fn()} />)

    expect(html).toContain('Apply now')
    expect(html).toContain('I submitted — record application')
    expect(html).not.toContain('Delivered')
  })

  it('preserves the queued Worker state without manual-record actions', () => {
    const html = renderToString(<ApplyJobCard job={{ ...job, mode: 'queued' }} onApplied={vi.fn()} />)

    expect(html).toContain('Posting in the background')
    expect(html).not.toContain('I submitted — record application')
  })

  it('labels a completed manual record as the user confirmation, not employer delivery', () => {
    const html = renderToString(
      <ApplyJobCard job={{ ...job, manualRecordStatuses: { 'user-1': 'reported' } }} onApplied={vi.fn()} />,
    )

    expect(html).toContain('Recorded from your confirmation')
    expect(html).not.toContain('Delivered')
    expect(html).not.toContain('Apply now')
  })

  it('does not inherit another account’s record when the session changes', () => {
    const jobReportedByA: ApplyReadyJob = {
      ...job,
      manualRecordStatuses: { 'user-a': 'reported' },
    }
    auth.userId = 'user-b'
    const accountB = renderToString(<ApplyJobCard job={jobReportedByA} onApplied={vi.fn()} />)
    auth.userId = 'user-a'
    const accountA = renderToString(<ApplyJobCard job={jobReportedByA} onApplied={vi.fn()} />)

    expect(accountB).toContain('I submitted — record application')
    expect(accountB).not.toContain('Recorded from your confirmation')
    expect(accountA).toContain('Recorded from your confirmation')
  })
})
