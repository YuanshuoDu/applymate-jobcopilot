import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { TaskGraphVerificationDisplayNode } from '@jobcopilot/agent-protocol'
import { TaskGraphVerificationSummary } from './TaskGraphVerificationSummary'

const checks = [
  { kind: 'candidate_count_gte', minimum: 2, status: 'passed' },
  { kind: 'finding_count_gte', minimum: 3, status: 'failed' },
  { kind: 'evidence_count_gte', minimum: 4, status: 'unverified' },
  { kind: 'all_candidates_have_evidence', minimumItems: 2, status: 'passed' },
  { kind: 'all_findings_have_evidence', minimumItems: 1, status: 'passed' },
  { kind: 'reported_score_gte', minimumScore: 7.5, minimumFindings: 2, aggregation: 'all', status: 'passed' },
  { kind: 'findings_from_scout_dependency', status: 'passed' },
  { kind: 'findings_cover_scout_candidates_gte', minimumPercent: 75, status: 'failed' },
] as const

describe('TaskGraphVerificationSummary', () => {
  it('renders fixed English check descriptions and recorded outcomes without identifiers or source text', () => {
    const node: TaskGraphVerificationDisplayNode = { status: 'unverified', checks, totalCount: 8, passedCount: 5, failedCount: 2, unverifiedCount: 1 }
    const html = renderToStaticMarkup(<TaskGraphVerificationSummary node={node} lang="en" />)
    expect(html).toContain('Verification: Not verified')
    expect(html).toContain('Checks: 8')
    expect(html).toContain('At least this many candidates: 2')
    expect(html).toContain('At least this many findings: 3')
    expect(html).toContain('At least this many evidence items: 4')
    expect(html).toContain('All candidates have evidence (minimum items: 2)')
    expect(html).toContain('All findings have evidence (minimum items: 1)')
    expect(html).toContain('Reported score threshold: 7.5 / 10 (minimum findings: 2, all)')
    expect(html).toContain('Analysis uses discovered jobs')
    expect(html).toContain('Findings cover at least this percentage of the declared Scout cohort: 75%')
    expect(html).toContain('data-task-graph-verification="unverified"')
    expect(html).not.toMatch(/dependencyNodeKey|taskId|criterionId|digest|receipt|PRIVATE|passed\?/i)
  })

  it('localizes failed, unavailable, and omitted legacy states without treating completion as verification', () => {
    const failed: TaskGraphVerificationDisplayNode = { status: 'failed', checks: [
      { kind: 'findings_cover_scout_candidates_gte', minimumPercent: 75, status: 'failed' },
    ], totalCount: 1, passedCount: 0, failedCount: 1, unverifiedCount: 0 }
    const failedHtml = renderToStaticMarkup(<TaskGraphVerificationSummary node={failed} lang="zh" />)
    expect(failedHtml).toContain('验证结果: 未通过')
    expect(failedHtml).toContain('分析结果至少覆盖声明的 Scout 候选集合比例: 75%')
    expect(failedHtml).toContain('未通过')
    const unavailable = renderToStaticMarkup(<TaskGraphVerificationSummary node={{ status: 'unavailable' }} lang="zh" />)
    expect(unavailable).toContain('验证不可用；未记录有效报告。')
    expect(unavailable).toContain('data-task-graph-verification="unavailable"')
    expect(renderToStaticMarkup(<TaskGraphVerificationSummary node={null} lang="en" />)).toBe('')
  })

  it('shows each recorded coverage outcome without inferring verification from task completion', () => {
    const cases = [
      { status: 'passed', passedCount: 1, failedCount: 0, unverifiedCount: 0, label: 'Passed' },
      { status: 'failed', passedCount: 0, failedCount: 1, unverifiedCount: 0, label: 'Failed' },
      { status: 'unverified', passedCount: 0, failedCount: 0, unverifiedCount: 1, label: 'Not verified' },
    ] as const
    for (const item of cases) {
      const node: TaskGraphVerificationDisplayNode = { status: item.status, checks: [
        { kind: 'findings_cover_scout_candidates_gte', minimumPercent: 75, status: item.status },
      ], totalCount: 1, passedCount: item.passedCount, failedCount: item.failedCount, unverifiedCount: item.unverifiedCount }
      const html = renderToStaticMarkup(<TaskGraphVerificationSummary node={node} lang="en" />)
      expect(html).toContain(`Findings cover at least this percentage of the declared Scout cohort: 75%`)
      expect(html).toContain(item.label)
    }
  })
})
