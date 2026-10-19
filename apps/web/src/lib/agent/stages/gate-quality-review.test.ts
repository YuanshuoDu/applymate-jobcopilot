import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationPackage, PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({ modelChat: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat }))

import { reviewApplicationQuality } from './gate-quality-review'

const validResult = {
  clScore: 8,
  fitGap: 'Limited evidence of incident response ownership.',
  recommendation: 'Add one concrete example of an incident you handled.',
  readyToApply: true,
}

const invalidResponses: Array<[string, string]> = [
  ['malformed JSON', '{not-json'],
  ['incomplete JSON', JSON.stringify({ clScore: 8, fitGap: 'gap', readyToApply: true })],
  ['extra fields', JSON.stringify({ ...validResult, unexpected: 'value' })],
  ['score with the wrong type', JSON.stringify({ ...validResult, clScore: '8' })],
  ['score below range', JSON.stringify({ ...validResult, clScore: -0.1 })],
  ['score above range', JSON.stringify({ ...validResult, clScore: 10.1 })],
  ['non-finite score', '{"clScore":1e309,"fitGap":"gap","recommendation":"fix","readyToApply":true}'],
  ['fit gap with the wrong type', JSON.stringify({ ...validResult, fitGap: null })],
  ['fit gap above its limit', JSON.stringify({ ...validResult, fitGap: 'x'.repeat(241) })],
  ['recommendation with the wrong type', JSON.stringify({ ...validResult, recommendation: false })],
  ['recommendation above its limit', JSON.stringify({ ...validResult, recommendation: 'x'.repeat(361) })],
  ['readiness with the wrong type', JSON.stringify({ ...validResult, readyToApply: 'yes' })],
]

function packageWithContent(): ApplicationPackage {
  return {
    job: { id: 'job_1', company: 'Example', role: 'Analyst', description: 'Incident response role.' } as ApplicationPackage['job'],
    score: 75,
    matchedKeywords: ['SOC'],
    missingKeywords: [],
    recommendation: '',
    coverLetter: 'A draft cover letter.',
  }
}

function context(): Pick<PipelineCtx, 'roleConfigs' | 'aiConfig'> {
  return {
    roleConfigs: {} as PipelineCtx['roleConfigs'],
    aiConfig: { provider: 'minimax', model: 'MiniMax-M3' },
  }
}

beforeEach(() => mocks.modelChat.mockReset())

describe('reviewApplicationQuality', () => {
  it('marks absent cover letter and job description as not applicable without calling a provider', async () => {
    const pkg = packageWithContent()
    pkg.coverLetter = undefined
    pkg.job.description = null

    await expect(reviewApplicationQuality(pkg, context())).resolves.toEqual({ kind: 'not_applicable' })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('accepts a complete bounded result', async () => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(validResult) })

    await expect(reviewApplicationQuality(packageWithContent(), context())).resolves.toEqual({
      kind: 'valid', result: validResult,
    })
  })

  it.each([0, 10])('accepts score boundary %s and string-length boundaries', async clScore => {
    const result = { clScore, fitGap: 'g'.repeat(240), recommendation: 'r'.repeat(360), readyToApply: false }
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(result) })

    await expect(reviewApplicationQuality(packageWithContent(), context())).resolves.toEqual({ kind: 'valid', result })
  })

  it('returns unavailable when the provider rejects without exposing its error', async () => {
    mocks.modelChat.mockRejectedValue(new Error('provider-secret-detail'))

    await expect(reviewApplicationQuality(packageWithContent(), context())).resolves.toEqual({ kind: 'unavailable' })
  })

  it.each(invalidResponses)('returns unavailable for %s', async (_label, responseText) => {
    mocks.modelChat.mockResolvedValue({ text: responseText })

    await expect(reviewApplicationQuality(packageWithContent(), context())).resolves.toEqual({ kind: 'unavailable' })
  })
})
