import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; enabled: boolean; cache: boolean }>,
  state: { data: null as unknown, loading: true, error: null as unknown, refetch: vi.fn() },
}))

vi.mock('@/lib/hooks', () => ({
  useApi: (url: string, options: { enabled?: boolean; cache?: boolean } = {}) => {
    api.calls.push({ url, enabled: options.enabled !== false, cache: options.cache !== false })
    return api.state
  },
}))

import { OBJECTIVE_JOURNEY_REPORT_SCHEMA, OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2, OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3,
  type ObjectiveJourneyReport as JourneyReport } from '@/lib/agent/session/objective-journey-report-contract'
import {
  buildObjectiveJourneyReportUrl,
  focusObjectiveFillEvidence,
  ObjectiveJourneyReport,
} from './ObjectiveJourneyReport'

const identity = { sessionId: 'session-1', finalItemId: 'final-source-1', graphRevision: 8 }
const sourceCounts = {
  discoveredJobs: { knownCount: 4, coverage: 'complete' as const },
  analyzedJobs: { knownCount: 3, coverage: 'partial' as const },
}
const slots = [{ ordinal: 1, tailoringStatus: 'ready' as const }, { ordinal: 2, tailoringStatus: 'stale' as const }]
const completeSourceCounts = { discoveredJobs: { knownCount: 4, coverage: 'complete' as const },
  analyzedJobs: { knownCount: 3, coverage: 'complete' as const } }
const journey = {
  schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA, finalItemId: identity.finalItemId, graphRevision: identity.graphRevision,
  sourceCounts, reviewCoverage: 'partial', slots: [
    { ordinal: 1, tailoringStatus: 'ready', job: { company: 'Example Company', role: 'Engineer' },
      reviewStatus: 'approved', reviewTurnId: 'review-turn-1', retirementReason: null, applicationStatus: 'submitted',
      submissionEvidence: { fillTurnId: 'fill-turn-1', finalItemId: 'fill-final-1' } },
    { ordinal: 2, tailoringStatus: 'stale', job: { company: 'Other Company', role: 'Engineer' },
      reviewStatus: 'expired', reviewTurnId: 'review-turn-2', retirementReason: 'resume_material_changed', applicationStatus: 'not_started',
      submissionEvidence: null },
  ],
}
const floor = { status: 'complete' as const, minimumScore: 7.5, qualifyingJobCount: 0 }
const journeyWithFloor = { ...journey, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2, sourceCounts: completeSourceCounts, reportedScoreFloor: floor }
const journeyWithRequirements = { ...journey, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3,
  requirementEvidenceCoverage: { status: 'complete' as const, checkedReadyJobs: 1, verifiedReadyJobs: 0 } }

function view(reportedScoreFloor?: typeof floor | { status: 'not_requested' | 'unavailable' }, counts: JourneyReport['sourceCounts'] = sourceCounts) {
  return <ObjectiveJourneyReport {...identity} sourceCounts={counts} reportedScoreFloor={reportedScoreFloor} slots={slots} lang="en" />
}

describe('ObjectiveJourneyReport', () => {
  beforeEach(() => {
    api.calls = []
    api.state = { data: null, loading: true, error: null, refetch: vi.fn() }
  })

  it('loads the owner-scoped final-item report without writing and renders verified slot outcomes', () => {
    api.state = { data: { report: journey }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(view())
    expect(buildObjectiveJourneyReportUrl(identity.sessionId, identity.finalItemId)).toBe(
      '/api/agent/sessions/session-1/final-items/final-source-1/objective-report')
    expect(api.calls).toContainEqual({ url: buildObjectiveJourneyReportUrl(identity.sessionId, identity.finalItemId), enabled: true, cache: false })
    expect(html).toContain('data-objective-journey-report="available"')
    expect(html).toContain('Example Company — Engineer')
    expect(html).toContain('Review coverage: Partial')
    expect(html).toContain('Shortlisted')
    expect(html).toContain('Ready')
    expect(html).toContain('Site-confirmed')
    expect(html).toContain('Unresolved')
    expect(html).toContain('<dt>Review</dt><dd>Approved</dd>')
    expect(html).toContain('<dt>Application</dt><dd>Site-confirmed</dd>')
    expect(html).toContain('<dt>Review</dt><dd>Expired</dd>')
    expect(html).toContain('Review expiry reason: Resume changed after review')
    expect(html).toContain('The material changed; request a fresh review.')
    expect(html).toContain('Material changed</dt><dd>1</dd>')
    expect(html).toContain('Unresolved</dt><dd>0</dd>')
    expect(html).toContain('Submission confirmed with verified fill evidence.')
    expect(html).toContain('View fill evidence')
    expect(html).not.toContain('fill-final-1')
    expect(html).not.toContain('review-turn-1')
    expect(html).not.toContain('href=')
  })

  it('accepts V1 slots without comparing unavailable manifest source counts', () => {
    const legacyView = <ObjectiveJourneyReport {...identity} slots={slots} lang="en" />
    api.state = { data: { report: journey }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(legacyView)
    expect(html).toContain('data-objective-journey-report="available"')
    expect(html).toContain('Example Company — Engineer')
    expect(html).toContain('Submission confirmed with verified fill evidence.')
  })

  it('shows the inclusive Analyst-reported floor and preserves a complete zero count', () => {
    api.state = { data: { report: journeyWithFloor }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(view(floor, completeSourceCounts))
    expect(html).toContain('Analyst-reported score floor')
    expect(html).toContain('≥ 7.5: 0 qualifying jobs')
    expect(html).not.toContain('Not requested')
  })

  it('renders requested and unavailable floor states without inventing a count', () => {
    for (const value of [{ status: 'not_requested' as const }, { status: 'unavailable' as const }]) {
      api.state = { data: { report: { ...journey, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
        reportedScoreFloor: value } }, loading: false, error: null, refetch: vi.fn() }
      const html = renderToStaticMarkup(view(value))
      expect(html).toContain(value.status === 'not_requested' ? 'Not requested' : 'Unavailable')
      expect(html).not.toContain('qualifying jobs')
    }
  })

  it('shows only the bounded ready-Job requirement coverage summary', () => {
    api.state = { data: { report: journeyWithRequirements }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(view())
    expect(html).toContain('Verified Job requirement evidence')
    expect(html).toContain('0 verified of 1 checked ready Jobs (complete coverage)')
    expect(html).not.toContain('proofDigest')
    expect(html).not.toContain('requirementId')
    expect(html).not.toContain('quote')
  })

  it('localizes the complete ready-Job requirement count in Chinese', () => {
    api.state = { data: { report: journeyWithRequirements }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(<ObjectiveJourneyReport {...identity} sourceCounts={sourceCounts} slots={slots} lang="zh" />)
    expect(html).toContain('1 个已检查的就绪职位中，0 个职位的要求证据已验证（完整覆盖）')
    expect(html).not.toContain('verified of')
  })

  it('renders unavailable requirement coverage without numeric claims', () => {
    api.state = { data: { report: { ...journeyWithRequirements,
      requirementEvidenceCoverage: { status: 'unavailable' } } }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(view())
    expect(html).toContain('Verified Job requirement evidence')
    expect(html).toContain('<dd>Unavailable</dd>')
    expect(html).not.toContain('checked ready Jobs')
  })

  it('hides a report when the expected V3 floor differs from its server report', () => {
    api.state = { data: { report: { ...journeyWithFloor, reportedScoreFloor: { status: 'not_requested' } } },
      loading: false, error: null, refetch: vi.fn() }
    expect(renderToStaticMarkup(view(floor))).toContain('data-objective-journey-report="unavailable"')
  })

  it('shows observed confirmations and an unresolved count when some application states are unknown', () => {
    const report = { ...journey, reviewCoverage: 'partial', slots: [
      journey.slots[0], { ...journey.slots[1], reviewStatus: 'unknown', reviewTurnId: null, retirementReason: null,
        applicationStatus: 'unknown' },
    ] }
    api.state = { data: { report }, loading: false, error: null, refetch: vi.fn() }
    const html = renderToStaticMarkup(view())
    expect(html).toContain('1 observed; some outcomes unavailable')
    expect(html).toContain('Unresolved</dt><dd>1</dd>')
  })

  it('hides report data when item, revision, counts, or slots do not match the final item', () => {
    const mismatches = [
      { ...journey, finalItemId: 'different-final' },
      { ...journey, graphRevision: identity.graphRevision - 1 },
      { ...journey, sourceCounts: { ...sourceCounts, analyzedJobs: { knownCount: 9, coverage: 'complete' } } },
      { ...journey, slots: [{ ...journey.slots[0]!, tailoringStatus: 'stale' }] },
    ]
    for (const report of mismatches) {
      api.state = { data: { report }, loading: false, error: null, refetch: vi.fn() }
      const html = renderToStaticMarkup(view())
      expect(html).toContain('data-objective-journey-report="unavailable"')
      expect(html).not.toContain('Application: Submitted')
    }
  })

  it('keeps loading, malformed, and failed responses explicit and bounded', () => {
    const loading = renderToStaticMarkup(view())
    expect(loading).toContain('Loading the verified application report')
    api.state = { data: { report: { ...journey, privateProof: 'PRIVATE' } }, loading: false, error: null, refetch: vi.fn() }
    const malformed = renderToStaticMarkup(view())
    expect(malformed).toContain('The application report is unavailable.')
    expect(malformed).not.toContain('PRIVATE')
    api.state = { data: { report: journey }, loading: true, error: 'unavailable', refetch: vi.fn() }
    expect(renderToStaticMarkup(view())).toContain('The application report is unavailable.')
  })

  it('focuses only the exact mounted fill item and returns false when transcript evidence is absent', () => {
    const target = {
      getAttribute: vi.fn((name: string) => name === 'data-agent-harness-item' ? 'fill-final-1' : null),
      hasAttribute: vi.fn(() => false), setAttribute: vi.fn(), scrollIntoView: vi.fn(), focus: vi.fn(),
    }
    const root = { querySelectorAll: vi.fn(() => [target]) } as unknown as Document
    expect(focusObjectiveFillEvidence('fill-final-1', root)).toBe(true)
    expect(target.setAttribute).toHaveBeenCalledWith('tabindex', '-1')
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(focusObjectiveFillEvidence('missing-final', { querySelectorAll: () => [] } as unknown as Document)).toBe(false)
  })
})
