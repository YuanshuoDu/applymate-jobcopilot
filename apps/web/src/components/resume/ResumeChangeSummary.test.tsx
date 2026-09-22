import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ResumeChange } from '@/lib/resume-change-diff'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'resume.changesTitle': 'Recent resume changes',
      'resume.changesHint': 'Green marks added content and red marks removed content.',
      'resume.changeSourceAi': 'AI insights',
      'resume.changeSourceAudit': 'Independent audit',
      'resume.changeSectionContact': 'Contact',
      'resume.summary': 'SUMMARY',
      'resume.skills': 'SKILLS',
      'resume.section.experience': 'EXPERIENCE',
      'resume.section.education': 'EDUCATION',
      'resume.section.languages': 'LANGUAGES',
      'resume.section.projects': 'PROJECTS',
      'resume.section.certifications': 'CERTIFICATIONS',
      'resume.coverLetter': 'Cover letter',
      'resume.changeBefore': 'Before',
      'resume.changeAfter': 'After',
      'resume.changeHide': 'Hide this highlight',
      'resume.changeClear': 'Clear highlights',
      'resume.changeAppliedLabel': 'Applied change',
    }[key] ?? key),
  }),
}))

import { ResumeChangeSummary } from './ResumeChangeSummary'

const changes: ResumeChange[] = [{
  id: 'ai-summary-1',
  source: 'ai_insights',
  section: 'summary',
  before: 'Managed delivery timelines for distributed teams.',
  after: 'Managed complex delivery timelines for distributed teams.',
  createdAt: Date.now(),
}]

describe('ResumeChangeSummary', () => {
  it('shows source, before/after columns, and inline word-level changes', () => {
    const markup = renderToStaticMarkup(
      <ResumeChangeSummary changes={changes} onDismiss={vi.fn()} onClear={vi.fn()} />,
    )

    expect(markup).toContain('Recent resume changes')
    expect(markup).toContain('AI insights')
    expect(markup).toContain('Before')
    expect(markup).toContain('After')
    expect(markup).toContain('complex')
    expect(markup).toContain('class="resume-change-diff-token is-added"')
    expect(markup).toContain('data-resume-change-summary')
  })
})
