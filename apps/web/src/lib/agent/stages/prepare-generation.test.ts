import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ modelChat: vi.fn() }))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  stripFences: (value: string) => value,
}))

import type { AiConfig } from '@/lib/model-router'
import type { AgentConfigFull, ScoredJob } from '../types'
import { generateCoverLetter, generateTailoredResume } from './prepare-generation'

const aiConfig = { provider: 'minimax', model: 'test', apiKey: 'test-key' } as AiConfig

function scoredJob(location = 'Dublin'): ScoredJob {
  return {
    job: {
      id: 'job_1',
      company: 'Acme',
      role: 'Engineer',
      location,
      url: 'https://example.test/jobs/engineer',
      description: 'Build reliable software with the engineering team.',
    } as never,
    score: 90,
    matchedKeywords: ['TypeScript'],
    missingKeywords: ['PostgreSQL'],
    recommendation: 'Strong fit',
    analysisFenceAt: '2026-09-26T10:00:00.001Z',
  }
}

function coverConfig(): AgentConfigFull {
  return { coverTone: 'professional' } as AgentConfigFull
}

describe('prepare generation helpers', () => {
  beforeEach(() => {
    mocks.modelChat.mockReset().mockResolvedValue({ text: '  Generated cover letter  ' })
  })

  it('extracts the tailored resume JSON and includes the confirmed evidence boundary', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '```json\n{"summary":"Tailored engineer"}\n```' })

    const result = await generateTailoredResume(
      scoredJob(),
      { summary: 'Original engineer' },
      aiConfig,
      'Writer system prompt',
      'Confirmed Persona facts',
      'Evidence: resume paragraph 1',
    )

    expect(result).toEqual({ summary: 'Tailored engineer' })
    expect(mocks.modelChat).toHaveBeenCalledWith([
      { role: 'system', content: 'Writer system prompt' },
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Persona is a hard fact boundary'),
      }),
    ], aiConfig, 2200)
    const prompt = mocks.modelChat.mock.calls[0][0][1].content as string
    expect(prompt).toContain('CONFIRMED PERSONA:\nConfirmed Persona facts')
    expect(prompt).toContain('Evidence: resume paragraph 1')
    expect(prompt).toContain('MATCHED: TypeScript')
    expect(prompt).toContain('MISSING: PostgreSQL')
  })

  it('rejects a tailored resume response with no JSON object', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: 'I could not create the resume.' })

    await expect(generateTailoredResume(scoredJob(), {}, aiConfig))
      .rejects.toThrow('AI returned no resume JSON')
  })

  it.each([
    ['Berlin', 'German', 'Use formal German business conventions, including Sie/Ihnen where appropriate.'],
    ['Paris', 'French', 'Use formal French business conventions, including vous/votre where appropriate.'],
    ['Amsterdam', 'Dutch', 'Use formal Dutch business conventions, including u/uw where appropriate.'],
    ['Madrid', 'Spanish', 'Use formal Spanish business conventions, including usted/su where appropriate.'],
    ['Dublin', 'English', 'Use polished business English and a professional European application style.'],
  ])('uses the %s locale to write the cover letter in %s', async (location, language, formalityGuide) => {
    const result = await generateCoverLetter(
      scoredJob(location),
      coverConfig(),
      { contact: { name: 'Alex Candidate' }, experience: [{ role: 'Developer', company: 'Prior Co', period: '2022–2025' }] },
      aiConfig,
      undefined,
      'Confirmed Persona facts',
      'Evidence: work history',
    )

    expect(result).toBe('Generated cover letter')
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    const [messages, usedConfig, maxTokens] = mocks.modelChat.mock.calls[0]
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain(`Language: Write this cover letter in ${language}. ${formalityGuide}`)
    expect(messages[0].content).toContain('Alex Candidate, Developer at Prior Co')
    expect(messages[0].content).toContain('CONFIRMED PERSONA:\nConfirmed Persona facts')
    expect(messages[0].content).toContain('Evidence: work history')
    expect(usedConfig).toBe(aiConfig)
    expect(maxTokens).toBe(800)
  })
})
