import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { ApplyJobCard, type ApplyReadyJob } from './ApplyJobCard'

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
  it('renders applied state from the job URL marker', () => {
    const html = renderToString(
      <ApplyJobCard
        job={{ ...job, url: `_applied_${job.url}` }}
        onApplied={vi.fn()}
      />,
    )

    expect(html).toContain('已投递')
    expect(html).not.toContain('立即申请')
  })

  it('keeps the apply action available before confirmation', () => {
    const html = renderToString(<ApplyJobCard job={job} onApplied={vi.fn()} />)

    expect(html).toContain('立即申请')
  })
})
