import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OBJECTIVE_JOURNEY_REPORT_SCHEMA, type ObjectiveJourneyReport } from '@/lib/agent/session/objective-journey-report-contract'
import { OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA } from '@/lib/agent/session/objective-journey-skill-comparison-contract'
import {
  bindObjectiveJourneySkillComparison,
  focusObjectiveJourneyJobSlot,
  objectiveJourneySkillComparisonKey,
  ObjectiveJourneySkillComparison,
  requestObjectiveJourneySkillComparison,
} from './ObjectiveJourneySkillComparison'

const report: ObjectiveJourneyReport = {
  schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA, finalItemId: 'final-1', graphRevision: 8,
  sourceCounts: { discoveredJobs: { knownCount: 2, coverage: 'complete' }, analyzedJobs: { knownCount: 2, coverage: 'complete' } },
  reviewCoverage: 'complete', slots: [
    { ordinal: 1, tailoringStatus: 'ready', job: { company: 'Example', role: 'Engineer' }, reviewStatus: 'approved',
      reviewTurnId: 'review-1', retirementReason: null, applicationStatus: 'not_started', submissionEvidence: null },
    { ordinal: 2, tailoringStatus: 'stale', job: { company: 'Other', role: 'Engineer' }, reviewStatus: 'expired',
      reviewTurnId: 'review-2', retirementReason: 'resume_material_changed', applicationStatus: 'not_started', submissionEvidence: null },
  ],
}
const comparison = {
  schemaVersion: OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA, finalItemId: 'final-1', graphRevision: 8, coverage: 'complete' as const,
  skills: [{ label: 'TypeScript', evidenceStatus: 'confirmed_persona_match' as const, slotOrdinals: [1] }], suggestedTerms: ['TypeScript'],
}
const reportRoot = { current: null } as React.RefObject<HTMLElement | null>

describe('ObjectiveJourneySkillComparison', () => {
  it('renders an explicit action without loading or exposing comparison data', () => {
    const html = renderToStaticMarkup(<ObjectiveJourneySkillComparison reportUrl='/api/objective-report' sessionId='session-1'
      finalItemId='final-1' graphRevision={8} report={report} lang='en' reportRoot={reportRoot} />)
    expect(html).toContain('Compare with my confirmed Skills for Job discovery')
    expect(html).toContain('data-objective-skill-comparison="idle"')
    expect(html).not.toContain('TypeScript')
  })

  it('keeps the explicit action accessible in Chinese without a deficit claim', () => {
    const html = renderToStaticMarkup(<ObjectiveJourneySkillComparison reportUrl='/api/objective-report' sessionId='session-1'
      finalItemId='final-1' graphRevision={8} report={report} lang='zh' reportRoot={reportRoot} />)
    expect(html).toContain('对比允许用于职位发现的已确认技能')
    expect(html).not.toContain('缺少技能')
  })

  it('posts only the explicit comparison action and parses the quote-free envelope', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ comparison }), { status: 200 }))
    await expect(requestObjectiveJourneySkillComparison({ url: '/api/objective-report', graphRevision: 8, fetcher })).resolves.toEqual(comparison)
    expect(fetcher).toHaveBeenCalledWith('/api/objective-report', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ compareConfirmedSkills: true, graphRevision: 8 }) }))
  })

  it('rejects malformed or failed responses without surfacing their payload', async () => {
    const malformed = vi.fn(async () => new Response(JSON.stringify({ comparison: { ...comparison, quote: 'PRIVATE' } }), { status: 200 }))
    await expect(requestObjectiveJourneySkillComparison({ url: '/api/objective-report', graphRevision: 8, fetcher: malformed })).resolves.toBeUndefined()
    const failed = vi.fn(async () => new Response(JSON.stringify({ comparison }), { status: 404 }))
    await expect(requestObjectiveJourneySkillComparison({ url: '/api/objective-report', graphRevision: 8, fetcher: failed })).resolves.toBeUndefined()
  })

  it('binds results to the current final item, graph revision, and ready Job slots', () => {
    const expected = { finalItemId: 'final-1', graphRevision: 8, readySlotOrdinals: [1] }
    expect(bindObjectiveJourneySkillComparison(comparison, expected)).toEqual(comparison)
    expect(bindObjectiveJourneySkillComparison({ ...comparison, finalItemId: 'other-final' }, expected)).toBeUndefined()
    expect(bindObjectiveJourneySkillComparison({ ...comparison, graphRevision: 7 }, expected)).toBeUndefined()
    expect(bindObjectiveJourneySkillComparison({ ...comparison, skills: [{ ...comparison.skills[0], slotOrdinals: [2] }] }, expected)).toBeUndefined()
  })

  it('changes the remount key when the report is refreshed or its slot identity changes', () => {
    const base = { sessionId: 'session-1', finalItemId: 'final-1', graphRevision: 8, reportRefreshEpoch: 0, report }
    expect(objectiveJourneySkillComparisonKey(base)).not.toBe(objectiveJourneySkillComparisonKey({ ...base, reportRefreshEpoch: 1 }))
    expect(objectiveJourneySkillComparisonKey(base)).not.toBe(objectiveJourneySkillComparisonKey({ ...base,
      report: { ...report, slots: [{ ...report.slots[0], job: { company: 'Changed', role: 'Engineer' } }, report.slots[1]] } }))
  })

  it('focuses only a matching slot inside the report root', () => {
    const target = { scrollIntoView: vi.fn(), focus: vi.fn() }
    const root = { querySelector: vi.fn(() => target) } as unknown as ParentNode
    expect(focusObjectiveJourneyJobSlot(1, root)).toBe(true)
    expect(root.querySelector).toHaveBeenCalledWith('[data-objective-journey-slot="1"]')
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(focusObjectiveJourneyJobSlot(2, { querySelector: () => null } as unknown as ParentNode)).toBe(false)
  })
})
