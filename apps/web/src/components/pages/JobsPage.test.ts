import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Job } from '@/lib/types'
import { toMobileJobCard } from './JobsPage'

const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')

describe('mobile job card projection', () => {
  it('keeps the fields needed to review a saved job', () => {
    const job = {
      id: 'job-1',
      company: 'Acme Labs',
      logo: 'AC',
      role: 'Senior Platform Engineer',
      location: 'Berlin, Germany',
      status: 'saved',
      score: 86,
      url: null,
      description: null,
      salary: null,
      source: 'greenhouse',
      notes: null,
      coverLetter: null,
      analysisNote: null,
      keywords: 'TypeScript, AWS',
      appliedAt: null,
      followUpAt: null,
      workflowState: 'draft',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      userId: 'user-1',
      finalResumeId: null,
      finalCoverLetterId: null,
    } as Job

    expect(toMobileJobCard(job)).toEqual({
      id: 'job-1',
      company: 'Acme Labs',
      logo: 'AC',
      role: 'Senior Platform Engineer',
      location: 'Berlin, Germany',
      status: 'saved',
      score: 86,
      date: '2026-08-01T10:00:00.000Z',
    })
  })

  it('uses the card list before the desktop table is clipped on narrow desktop widths', () => {
    expect(globalCss).toMatch(/@media \(max-width: 1200px\)[\s\S]*\.jobs-desktop-list\s*\{\s*display:\s*none/)
    expect(globalCss).toMatch(/@media \(max-width: 1200px\)[\s\S]*\.jobs-mobile-list\s*\{[\s\S]*display:\s*flex/)
  })
})
