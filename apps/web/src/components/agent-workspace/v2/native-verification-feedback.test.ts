import { describe, expect, it } from 'vitest'

import { extractNativeVerificationFeedback, safeNativeFeedbackOutput } from './native-verification-feedback'

function criterion(overrides: Record<string, unknown> = {}) {
  return { criterionId: 'criterion-1', disposition: 'passed', reasonCode: 'meets_criterion', evidenceReferenceIds: ['private-evidence-ref'], ...overrides }
}

function feedback(overrides: Record<string, unknown> = {}) {
  return { disposition: 'passed', criteria: [criterion()], ...overrides }
}

function canonicalEnvelope(feedbackValue: unknown = feedback(), overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-item', finalText: 'private text',
    structuredResult: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'analyst', findings: [], evidence: [] },
    nativeVerificationFeedback: feedbackValue,
    ...overrides,
  }
}

function viewOf(value: unknown) { return extractNativeVerificationFeedback(value) }

describe('native verification feedback projection', () => {
  it('reads the named direct slot and canonical subagent result envelope without returning references', () => {
    const expected = { state: 'available', groups: [{ checks: [{ disposition: 'passed', reason: 'meets_criterion' }] }] }
    expect(viewOf({ nativeVerificationFeedback: feedback() })).toEqual(expected)
    expect(viewOf({
      status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-item', finalText: 'private text',
      structuredResult: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'analyst', findings: [], evidence: [] },
      nativeVerificationFeedback: feedback(),
    })).toEqual(expected)
    expect(viewOf({ result: canonicalEnvelope() })).toEqual(expected)
    expect(viewOf(feedback())).toEqual({ state: 'none' })
  })

  it('marks nested feedback unavailable unless it is in a canonical completed subagent envelope', () => {
    const invalid = [
      canonicalEnvelope(feedback(), { structuredResult: { role: 'analyst', findings: [], evidence: [] } }),
      canonicalEnvelope(feedback(), { structuredResult: { schemaVersion: 'agent-harness.v1.subagent.result' } }),
      canonicalEnvelope(feedback(), { status: 'running' }),
      canonicalEnvelope(feedback(), { stepCount: '2' }),
      canonicalEnvelope(feedback(), { extraEnvelopeField: 'not canonical' }),
    ]
    for (const result of invalid) expect(viewOf({ result })).toEqual({ state: 'unavailable' })
    expect(viewOf({ result: canonicalEnvelope() })).toMatchObject({ state: 'available' })
  })

  it('accepts passed feedback after public reference filtering leaves no references', () => {
    expect(viewOf({ nativeVerificationFeedback: feedback({ criteria: [criterion({ evidenceReferenceIds: [] })] }) })).toEqual({
      state: 'available', groups: [{ checks: [{ disposition: 'passed', reason: 'meets_criterion' }] }],
    })
  })

  it('reads every bounded completed result in an agent.wait response and ignores empty results', () => {
    expect(viewOf({ status: 'ready', tasks: [
      { taskId: 'private-task-a', status: 'completed', result: { nativeVerificationFeedback: feedback() } },
      { taskId: 'private-task-b', status: 'completed', result: { nativeVerificationFeedback: feedback({ disposition: 'uncertain', criteria: [criterion({ disposition: 'uncertain', reasonCode: 'evidence_missing', evidenceReferenceIds: [] })] }) } },
      { taskId: 'private-task-c', status: 'running', result: null },
    ] })).toEqual({ state: 'available', groups: [
      { checks: [{ disposition: 'passed', reason: 'meets_criterion' }] },
      { checks: [{ disposition: 'uncertain', reason: 'evidence_missing' }] },
    ] })
  })

  it('preserves ordinary primitive and array task results beside recognized wait feedback', () => {
    const output = { status: 'ready', tasks: [
      { result: { nativeVerificationFeedback: feedback() } },
      { result: 'ordinary child summary' },
      { result: ['ordinary', 'child', 'values'] },
    ] }
    expect(viewOf(output).state).toBe('available')
    expect(safeNativeFeedbackOutput(output)).toEqual({ status: 'ready', tasks: [
      { result: undefined }, { result: 'ordinary child summary' }, { result: ['ordinary', 'child', 'values'] },
    ] })
  })

  it('validates every reason only with compatible check dispositions', () => {
    const cases = [
      ['passed', 'meets_criterion'], ['failed', 'does_not_meet_criterion'], ['uncertain', 'evidence_missing'],
      ['failed', 'evidence_conflict'], ['uncertain', 'evidence_conflict'], ['uncertain', 'ambiguous'],
      ['failed', 'unsupported_claim'], ['uncertain', 'unsupported_claim'],
    ] as const
    for (const [disposition, reasonCode] of cases) {
      const evidenceReferenceIds = disposition === 'passed' ? ['ref-1'] : []
      const result = feedback({ disposition, criteria: [criterion({ disposition, reasonCode, evidenceReferenceIds })] })
      expect(viewOf({ nativeVerificationFeedback: result }).state).toBe('available')
    }
  })

  it('rejects aggregate mismatches, invalid enums, nonsequential criteria, duplicates and oversized arrays', () => {
    const first = criterion()
    const invalid = [
      feedback({ disposition: 'failed' }),
      feedback({ criteria: [criterion({ disposition: 'mystery' })] }),
      feedback({ criteria: [{ ...first, criterionId: 'criterion-2' }] }),
      feedback({ criteria: [first, { ...first, criterionId: 'criterion-1' }] }),
      feedback({ criteria: Array.from({ length: 33 }, (_, index) => ({ ...first, criterionId: `criterion-${index + 1}` })) }),
      feedback({ criteria: [criterion({ evidenceReferenceIds: Array.from({ length: 9 }, (_, index) => `ref-${index}`) })] }),
      feedback({ criteria: [criterion({ evidenceReferenceIds: ['same-ref', 'same-ref'] })] }),
      { ...feedback(), privateReceipt: 'PRIVATE_RECEIPT_MARKER' },
      feedback({ criteria: [{ ...first, privateText: 'PRIVATE_CRITERION_MARKER' }] }),
    ]
    for (const value of invalid) expect(viewOf({ nativeVerificationFeedback: value })).toEqual({ state: 'unavailable' })
  })

  it('rejects malformed arrays and accessors without invoking them', () => {
    const sparse = new Array(1)
    const malformed = [
      { ...feedback(), criteria: sparse },
      feedback({ criteria: [criterion({ evidenceReferenceIds: new Array(1) })] }),
      feedback({ criteria: [criterion({ reasonCode: 'free text' })] }),
    ]
    for (const value of malformed) expect(viewOf({ nativeVerificationFeedback: value })).toEqual({ state: 'unavailable' })

    let invoked = false
    const unsafe = { ...feedback() }
    Object.defineProperty(unsafe.criteria[0], 'reasonCode', { enumerable: true, get() { invoked = true; return 'meets_criterion' } })
    expect(viewOf({ nativeVerificationFeedback: unsafe })).toEqual({ state: 'unavailable' })
    expect(invoked).toBe(false)
  })

  it('fails closed for private reports and malformed wait result slots', () => {
    expect(viewOf({ status: 'completed', nativeVerificationReport: { private: 'PRIVATE_REPORT_MARKER' } })).toEqual({ state: 'unavailable' })
    expect(viewOf({ status: 'ready', tasks: new Array(1) })).toEqual({ state: 'unavailable' })
    expect(viewOf({ status: 'ready', tasks: Array.from({ length: 9 }, () => ({ result: null })) })).toEqual({ state: 'unavailable' })
    expect(viewOf({ status: 'ready', tasks: [{ result: { nativeVerificationFeedback: { private: 'PRIVATE_FEEDBACK_MARKER' } } }] })).toEqual({ state: 'unavailable' })
  })

  it('does not search arbitrary descendants or parse JSON strings', () => {
    expect(viewOf({ nested: { nativeVerificationFeedback: feedback() } })).toEqual({ state: 'none' })
    expect(viewOf(JSON.stringify({ nativeVerificationFeedback: feedback() }))).toEqual({ state: 'none' })
    expect(viewOf({ status: 'ready', tasks: [{ result: { status: 'ready', tasks: [{ result: { nativeVerificationFeedback: feedback() } }] } }] })).toEqual({ state: 'none' })
    const cyclic = { status: 'ready', tasks: [] as unknown[] }
    cyclic.tasks.push({ result: cyclic })
    expect(viewOf(cyclic)).toEqual({ state: 'none' })
  })

  it('removes public references and private report slots from generic output', () => {
    const output = { summary: 'safe', nativeVerificationReport: { secret: 'PRIVATE_REPORT_MARKER' }, nativeVerificationFeedback: feedback() }
    expect(safeNativeFeedbackOutput(output)).toEqual({ summary: 'safe' })
    expect(safeNativeFeedbackOutput(feedback())).toEqual(feedback())
    const waitOutput = { status: 'ready', tasks: [{ taskId: 'private-task', result: output }] }
    expect(safeNativeFeedbackOutput(waitOutput)).toEqual({ status: 'ready', tasks: [{ taskId: 'private-task', result: { summary: 'safe' } }] })
  })
})
