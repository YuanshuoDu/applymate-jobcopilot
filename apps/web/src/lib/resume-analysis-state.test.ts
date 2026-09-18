import { describe, expect, it } from 'vitest'
import { analysisTargetKey, replaceSectionSuggestions, shouldPreserveAnalysis, shouldStartAutomaticAnalysis } from './resume-analysis-state'

describe('resume analysis state', () => {
  const target = analysisTargetKey('resume-1', 'job-1')

  it('preserves the visible result when saving the same resume/job pair', () => {
    expect(shouldPreserveAnalysis(target, analysisTargetKey('resume-1', 'job-1'))).toBe(true)
    expect(shouldStartAutomaticAnalysis({
      targetKey: analysisTargetKey('resume-1', 'job-1'),
      activeTargetKey: target,
      hasScore: true,
      hasContent: true,
      hasJobs: true,
      contentChangedSinceAnalysis: true,
    })).toBe(false)
  })

  it('starts automatically for a new target without edited content', () => {
    expect(shouldPreserveAnalysis(target, analysisTargetKey('resume-2', 'job-1'))).toBe(false)
    expect(shouldStartAutomaticAnalysis({
      targetKey: analysisTargetKey('resume-2', 'job-1'),
      activeTargetKey: target,
      hasScore: false,
      hasContent: true,
      hasJobs: true,
      contentChangedSinceAnalysis: false,
    })).toBe(true)
  })

  it('does not start an automatic request while the user has unapplied edits', () => {
    expect(shouldStartAutomaticAnalysis({
      targetKey: target,
      activeTargetKey: target,
      hasScore: false,
      hasContent: true,
      hasJobs: true,
      contentChangedSinceAnalysis: true,
    })).toBe(false)
  })

  it('replaces only one section while preserving suggestions for other sections', () => {
    const current = [
      { target: 'summary', text: 'old summary' },
      { target: 'skills', text: 'keep skills' },
    ]
    expect(replaceSectionSuggestions(current, 'summary', [{ target: 'summary', text: 'new summary' }])).toEqual([
      { target: 'skills', text: 'keep skills' },
      { target: 'summary', text: 'new summary' },
    ])
  })
})
