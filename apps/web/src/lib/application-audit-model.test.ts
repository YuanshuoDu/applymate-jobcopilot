import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runParsedAudit } from './application-audit-model'

const mocks = vi.hoisted(() => ({ modelChat: vi.fn() }))
vi.mock('./model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: (text: string) => JSON.parse(text),
  withMiniMaxThinking: (config: object, thinking: string) => ({ ...config, thinking }),
}))

const config = { provider: 'minimax' as const, model: 'MiniMax-M3', thinking: 'adaptive' as const }
const response = (text: string) => ({ provider: 'minimax', model: 'MiniMax-M3', text })

describe('independent application audit model handling', () => {
  beforeEach(() => mocks.modelChat.mockReset())
  afterEach(() => vi.useRealTimers())

  it('does not persist a proposal changed by normalization', async () => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: [{
      area: 'resume', severity: 'warning', target: 'experience', title: 'Review',
      proposedValue: [{ company: 'Acme', role: 'Engineer', period: '2020', bullets: ['Built'], extra: 'do not erase' }],
    }] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(audit.verdict).toBe('needs_review')
    expect(audit.findings[0]).not.toHaveProperty('proposedValue')
  })

  it.each(['warning', 'critical'] as const)('does not discard an actionable %s after the twelfth finding', async severity => {
    const findings = [
      ...Array.from({ length: 12 }, (_, index) => ({ area: 'resume', severity: 'pass', title: `Pass ${index}` })),
      { area: 'resume', severity, title: 'Hidden factual issue' },
    ]
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(audit.verdict).toBe(severity === 'critical' ? 'blocked' : 'needs_review')
    expect(audit.findings).toHaveLength(12)
    expect(audit.findings).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Audit results exceed the display limit', severity: 'warning' })]))
    expect(audit.summary).toContain('too many findings')
  })

  it.each(['job_match', 'cover_letter'] as const)('does not treat overflow %s advice as a factual contradiction when the letter is absent', async area => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: [
      ...Array.from({ length: 12 }, () => ({ area: 'resume', severity: 'pass' })),
      { area, severity: 'critical' },
    ] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(audit.verdict).toBe('needs_review')
    expect(audit.findings).toHaveLength(12)
  })

  it('blocks on an overflow critical for a selected cover letter', async () => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: [
      { area: 'resume', severity: 'pass' }, { area: 'cover_letter', severity: 'pass' },
      ...Array.from({ length: 10 }, () => ({ area: 'job_match', severity: 'pass' })),
      { area: 'cover_letter', severity: 'critical' },
    ] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', true)
    expect(audit.verdict).toBe('blocked')
    expect(audit.findings).toHaveLength(12)
  })

  it('accepts twelve complete passing results without an overflow warning', async () => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: [
      { area: 'resume', severity: 'pass' }, { area: 'cover_letter', severity: 'pass' },
      ...Array.from({ length: 10 }, () => ({ area: 'job_match', severity: 'warning' })),
    ] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', true)
    expect(audit.verdict).toBe('pass')
    expect(audit.findings).toHaveLength(12)
    expect(audit.findings.some(finding => finding.title === 'Audit results exceed the display limit')).toBe(false)
  })

  it('keeps incomplete-coverage guidance within the twelve-finding limit', async () => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: Array.from({ length: 12 }, () => ({ area: 'resume', severity: 'pass' })) })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', true)
    expect(audit.verdict).toBe('needs_review')
    expect(audit.findings).toHaveLength(12)
    expect(audit.findings).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Incomplete independent audit', area: 'cover_letter' })]))
  })

  it('requires factual resume coverage and ignores an absent optional cover letter', async () => {
    mocks.modelChat.mockResolvedValue(response(JSON.stringify({ findings: [
      { area: 'cover_letter', severity: 'critical', title: 'No letter' },
      { area: 'job_match', severity: 'critical', title: 'Optional match advice' },
    ] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(audit.verdict).toBe('needs_review')
    expect(audit.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ area: 'cover_letter' })]))
    expect(audit.findings).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'resume', title: 'Incomplete independent audit' })]))
  })

  it('returns a retryable review state after two invalid structured responses', async () => {
    mocks.modelChat.mockResolvedValue(response('not-json'))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(mocks.modelChat).toHaveBeenCalledTimes(2)
    expect(mocks.modelChat.mock.calls[1][0][0].content).toContain('previous response was invalid')
    expect(audit).toMatchObject({ verdict: 'needs_review', findings: [expect.objectContaining({ title: 'Audit response needs retry' })] })
  })

  it('retries an aborted model request once', async () => {
    vi.useFakeTimers()
    const aborted = new Error('aborted'); aborted.name = 'AbortError'
    mocks.modelChat.mockRejectedValueOnce(aborted).mockResolvedValueOnce(response(JSON.stringify({ findings: [{ area: 'resume', severity: 'pass' }] })))
    const pending = runParsedAudit('prompt', config, 'parent_resume', false)
    await vi.advanceTimersByTimeAsync(750)
    expect((await pending).audit.verdict).toBe('pass')
    expect(mocks.modelChat).toHaveBeenCalledTimes(2)
  })

  it('retries MiniMax reasoning exhaustion with disabled thinking', async () => {
    mocks.modelChat.mockRejectedValueOnce(new Error('minimax returned no final content (finish reason: length)'))
      .mockResolvedValueOnce(response(JSON.stringify({ findings: [{ area: 'resume', severity: 'pass' }] })))
    const { audit } = await runParsedAudit('prompt', config, 'parent_resume', false)
    expect(audit.verdict).toBe('pass')
    expect(mocks.modelChat.mock.calls[1][1]).toMatchObject({ model: 'MiniMax-M3', thinking: 'disabled' })
    expect(mocks.modelChat.mock.calls[1][2]).toBe(4096)
  })
})
