import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Job, ScoreResult, Suggestion } from '@/lib/types'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.edit': 'Edit',
      'common.apply': 'Apply',
      'common.copy': 'Copy',
      'resume.applied': 'Applied',
      'resume.regenerateSection': 'Regenerate section',
    }[key] ?? key),
  }),
}))

vi.mock('@/components/ui', () => ({
  Divider: () => <hr />,
  MatchScoreRing: ({ score }: { score: number }) => <span>{score}%</span>,
}))

import { AiPanel } from './AiPanel'

const job = { id: 'job-1', company: 'Acme', role: 'Product Owner' } as Job
const scoreResult = {
  score: 72,
  matchedKeywords: ['Agile'],
  missingItems: [],
  sectionMatches: [{ section: 'Summary', keywords: ['Agile'], score: 78, tip: 'Keep the summary focused.' }],
  sectionScores: { Summary: 78 },
  sectionTips: { Summary: 'Keep the summary focused.' },
  strengthSummary: 'Good match',
  skillsGap: [],
} satisfies ScoreResult

const suggestions: Suggestion[] = [
  { text: 'Applied summary suggestion', target: 'summary', action: 'rewrite', proposed: 'Updated summary', applied: true },
  { text: 'Pending general suggestion', target: 'general', action: 'none', applied: false },
]

describe('AiPanel suggestion states', () => {
  it('keeps applied suggestions visible and exposes section regeneration', () => {
    const markup = renderToStaticMarkup(
      <AiPanel
        selectedJob={job}
        scoreResult={scoreResult}
        suggestions={suggestions}
        scoring={false}
        suggesting={false}
        noJobSelected={false}
        onApplySuggestion={vi.fn()}
        onAnalyze={vi.fn()}
        onAddKeyword={vi.fn()}
        onEditSection={vi.fn()}
        onRegenerateSection={vi.fn()}
        onAudit={vi.fn()}
      />,
    )

    expect(markup).toContain('Applied summary suggestion')
    expect(markup).toContain('✓ Applied')
    expect(markup).toContain('↻ Regenerate section')
    expect(markup).toContain('Pending general suggestion')
  })
})
