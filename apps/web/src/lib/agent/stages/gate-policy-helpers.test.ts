import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionCancelledError } from '../execution-control'
import type { ApplicationPackage, PipelineCtx } from '../types'
import { hashArtifactContent } from '../artifacts/hash'
import type { ArtifactSummary } from '../artifacts/types'
import { assertScheduledGateCurrent, gateWriteOwner, prepareReviewedPackage } from './gate-policy-helpers'

describe('Gate policy helpers', () => {
  it('creates a write owner only for a complete session execution', () => {
    expect(gateWriteOwner({} as PipelineCtx)).toBeUndefined()
    expect(() => gateWriteOwner({ sessionId: 'session-1' } as unknown as PipelineCtx)).toThrow(AgentExecutionCancelledError)
    expect(gateWriteOwner({ sessionId: 'session-1', turnId: 'turn-1', executionAttempt: 2 } as unknown as PipelineCtx))
      .toMatchObject({ turnId: 'turn-1', executionAttempt: 2 })
  })

  it('skips artifact work when no prepared artifacts exist', () => {
    const pkg = { job: { id: 'job-1' } } as ApplicationPackage
    const result = prepareReviewedPackage(pkg, {} as PipelineCtx)

    expect(result).toEqual({ reviewedPackage: pkg, artifacts: [], issues: [], reviews: [] })
  })

  it('uses proof-bound Worker constraints only behind the scheduled Gate owner fence', () => {
    const artifact: ArtifactSummary = { id: 'resume-1', kind: 'resume', lifecycle: 'draft', version: 1,
      hash: hashArtifactContent({ resume: 'tailored' }), baseArtifactId: 'resume-base',
      baseHash: hashArtifactContent({ resume: 'base' }), constraintHash: hashArtifactContent({ checkpoint: 'prepare-proof' }),
      provenance: [{ sourceType: 'resume', sourceRef: 'resume:resume-base', evidenceHash: hashArtifactContent({ source: 'resume' }) }] }
    const pkg = { job: { id: 'job-1', role: 'Engineer', company: 'Fixture Co' }, tailoredResumeArtifact: artifact } as ApplicationPackage
    const agentCfg = { targetRoles: ['Engineer'], targetLocations: ['Dublin'], excludeCompanies: [], priorityCompanies: [],
      minMatchScore: 70, coverTone: 'professional' }
    const fenced = { userId: 'user-1', agentCfg, scheduledTaskGraphOwnerFence: {} } as unknown as PipelineCtx
    const reviewed = prepareReviewedPackage(pkg, fenced, true)

    expect(reviewed.issues).toEqual([])
    expect(reviewed.reviews).toHaveLength(1)
    expect(reviewed.reviews[0]).toMatchObject({ status: 'passed', constraintHash: artifact.constraintHash })
    expect(prepareReviewedPackage(pkg, { userId: 'user-1', agentCfg } as unknown as PipelineCtx, true).issues)
      .toEqual(['resume:stale_constraints'])
  })

  it('enforces the scheduled owner fence when present', async () => {
    const assertExecutionCurrent = vi.fn().mockResolvedValue(false)
    const stale = { scheduledTaskGraphOwnerFence: {}, assertExecutionCurrent } as unknown as PipelineCtx

    await expect(assertScheduledGateCurrent(stale, true)).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(assertExecutionCurrent).toHaveBeenCalledOnce()
    await expect(assertScheduledGateCurrent(stale, false)).resolves.toBeUndefined()
  })
})
