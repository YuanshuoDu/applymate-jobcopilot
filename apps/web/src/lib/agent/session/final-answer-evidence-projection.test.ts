import { describe, expect, it } from 'vitest'

import {
  projectAnswerEvidence, projectCompletedAnswerEvidence, projectFinalAnswerContent, projectFinalAnswerDisplayContent,
} from './final-answer-evidence-projection'

const evidence = {
  schemaVersion: 1,
  sources: [{ key: 'S1', kind: 'job', label: 'Senior Engineer at Example Co', excerpt: 'Remote role. Contact alex@example.test or +353 871234567.' }],
}

describe('final answer evidence projection', () => {
  it('keeps only a strict bounded manifest and redacts contact details', () => {
    expect(projectAnswerEvidence(evidence)).toEqual({
      schemaVersion: 1,
      sources: [{
        key: 'S1', kind: 'job', label: 'Senior Engineer at Example Co',
        excerpt: 'Remote role. Contact [REDACTED_EMAIL] or [REDACTED_PHONE].',
      }],
    })
  })

  it('rejects unknown keys, invalid kinds, duplicate source keys, and unbounded input', () => {
    const invalid: unknown[] = [
      { ...evidence, rawOutput: 'PRIVATE_RAW_OUTPUT' },
      { schemaVersion: 1, sources: [{ ...evidence.sources[0], sourceId: 'PRIVATE_SOURCE_ID' }] },
      { schemaVersion: 1, sources: [{ ...evidence.sources[0], kind: 'tool' }] },
      { schemaVersion: 1, sources: [evidence.sources[0], evidence.sources[0]] },
      { schemaVersion: 1, sources: [{ ...evidence.sources[0], excerpt: 'x'.repeat(601) }] },
    ]
    for (const value of invalid) expect(projectAnswerEvidence(value)).toBeNull()
  })

  it('drops source entries containing URLs or internal locator material', () => {
    expect(projectAnswerEvidence({
      schemaVersion: 1,
      sources: [
        evidence.sources[0],
        { key: 'S2', kind: 'resume', label: 'Resume', excerpt: 'https://private.example/resume' },
      ],
    })).toEqual({ schemaVersion: 1, sources: [expect.objectContaining({ key: 'S1' })] })
    expect(projectAnswerEvidence({
      schemaVersion: 1,
      sources: [{ key: 'S2', kind: 'persona', label: 'Preference', excerpt: 'source_digest=sha256:deadbeef' }],
    })).toBeNull()
  })

  it('drops unknown-TLD URLs and common internal identifier formats from previews', () => {
    const cuid = `c${'a'.repeat(23)}`
    const internalValues = [
      'private.example.xyz/listing',
      'ftp://private.example.xyz/listing',
      `job id ${cuid}`,
      'call_1',
      'turn-12345',
      'E-internal_lookup_key',
      'source digest ' + 'a'.repeat(64),
    ]

    for (const excerpt of internalValues) {
      expect(projectAnswerEvidence({
        schemaVersion: 1,
        sources: [{ ...evidence.sources[0], excerpt }],
      })).toBeNull()
    }
  })

  it('projects only answer text, safe summary, and a validated manifest from a persisted final wrapper', () => {
    const projected = projectFinalAnswerContent({
      text: 'I found a match. [[source:S1]]',
      final: {
        response: 'I found a match. [[source:S1]]', summary: 'Good fit.', answerEvidence: evidence,
        evidenceRefs: ['PRIVATE_TOOL_CALL'], usage: { inputTokens: 7 }, goal: 'PRIVATE_GOAL',
      },
    })
    expect(projected).toEqual({
      text: 'I found a match. [[source:S1]]', summary: 'Good fit.',
      answerEvidence: {
        schemaVersion: 1,
        sources: [{ key: 'S1', kind: 'job', label: 'Senior Engineer at Example Co', excerpt: 'Remote role. Contact [REDACTED_EMAIL] or [REDACTED_PHONE].' }],
      },
    })
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_TOOL_CALL|PRIVATE_GOAL|alex@example\.test|871234567/)
  })

  it('shares strict final evidence projection between query and replay content', () => {
    const text = 'A match. [[source:S1]]'
    const projected = projectFinalAnswerDisplayContent({ text, summary: 'Good fit.', answerEvidence: evidence })
    expect(projected).toEqual({
      text, summary: 'Good fit.',
      answerEvidence: {
        schemaVersion: 1,
        sources: [{ key: 'S1', kind: 'job', label: 'Senior Engineer at Example Co', excerpt: 'Remote role. Contact [REDACTED_EMAIL] or [REDACTED_PHONE].' }],
      },
    })
    expect(projectFinalAnswerDisplayContent({ text: 'Legacy answer', summary: 'Legacy summary' }))
      .toEqual({ text: 'Legacy answer', summary: 'Legacy summary' })
    expect(projectFinalAnswerDisplayContent({ text, summary: 'x'.repeat(1001) })).toBeNull()
    expect(projectFinalAnswerDisplayContent({ text, answerEvidence: { ...evidence, extra: 'PRIVATE' } })).toBeNull()

    const persisted = { text, final: { response: text, answerEvidence: evidence } }
    expect(projectCompletedAnswerEvidence(persisted, 'final_answer', 'completed')).toEqual(projected?.answerEvidence)
    expect(projectCompletedAnswerEvidence(persisted, 'commentary', 'completed')).toBeUndefined()
    expect(projectCompletedAnswerEvidence(persisted, 'final_answer', 'streaming')).toBeUndefined()
  })

  it('fails closed when final response text is not bound to the persisted response', () => {
    expect(projectFinalAnswerContent({ text: 'visible', final: { response: 'different', answerEvidence: evidence } })).toBeNull()
    expect(projectFinalAnswerContent({ text: 'visible', final: { response: 'visible', answerEvidence: evidence }, extra: 'ignored by other query fields' })).toBeNull()
    expect(projectFinalAnswerContent({ text: 'visible', final: { response: 'visible', answerEvidence: evidence, internal: 'ignored' } }))
      .toMatchObject({ text: 'visible', answerEvidence: { schemaVersion: 1 } })
    expect(projectFinalAnswerContent({ text: 'legacy', final: { response: 'legacy', summary: 'Legacy summary' } }))
      .toEqual({ text: 'legacy', summary: 'Legacy summary' })
  })

  it('leaves ordinary answer prose unchanged while redacting only evidence previews', () => {
    const text = 'Role job-123; contact alex@example.test; see https://jobs.example.test/opening'
    const projected = projectFinalAnswerContent({
      text,
      final: {
        response: text,
        answerEvidence: {
          schemaVersion: 1,
          sources: [{ key: 'S1', kind: 'persona', label: 'Preference', excerpt: 'Contact alex@example.test; private.example.com/profile' }],
        },
      },
    })
    expect(projected?.text).toBe(text)
    expect(projected?.answerEvidence).toBeUndefined()
  })
})
