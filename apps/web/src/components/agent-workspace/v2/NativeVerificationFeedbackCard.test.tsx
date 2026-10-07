import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NativeVerificationFeedbackCard } from './NativeVerificationFeedbackCard'
import { extractNativeVerificationFeedback } from './native-verification-feedback'

function criterion(disposition: string, reasonCode: string, evidenceReferenceIds: string[] = []) {
  return { criterionId: 'criterion-1', disposition, reasonCode, evidenceReferenceIds }
}

function render(disposition: string, reasonCode: string, lang: 'en' | 'zh', refs: string[] = []) {
  const view = extractNativeVerificationFeedback({ nativeVerificationFeedback: { disposition, criteria: [criterion(disposition, reasonCode, refs)] } })
  return renderToStaticMarkup(<NativeVerificationFeedbackCard view={view} lang={lang} />)
}

describe('NativeVerificationFeedbackCard', () => {
  it('renders every reason in English and Chinese with the compatible disposition', () => {
    const cases = [
      ['passed', 'meets_criterion', 'Evidence meets this check', '证据符合此项要求'],
      ['failed', 'does_not_meet_criterion', 'Evidence does not meet this check', '证据未满足此项要求'],
      ['uncertain', 'evidence_missing', 'Evidence is missing', '缺少证据'],
      ['failed', 'evidence_conflict', 'Evidence conflicts', '证据存在冲突'],
      ['uncertain', 'ambiguous', 'Evidence is ambiguous', '证据含义不明确'],
      ['failed', 'unsupported_claim', 'Claim is unsupported', '主张缺乏支持'],
      ['uncertain', 'unsupported_claim', 'Claim is unsupported', '主张缺乏支持'],
    ] as const
    for (const [disposition, reason, english, chinese] of cases) {
      expect(render(disposition, reason, 'en', disposition === 'passed' ? ['reference-should-not-render'] : [])).toContain(english)
      expect(render(disposition, reason, 'zh', disposition === 'passed' ? ['reference-should-not-render'] : [])).toContain(chinese)
    }
  })

  it('distinguishes an actual failed check from unavailable feedback', () => {
    const failed = extractNativeVerificationFeedback({ nativeVerificationFeedback: { disposition: 'failed', criteria: [criterion('failed', 'does_not_meet_criterion')] } })
    const unavailable = extractNativeVerificationFeedback({ nativeVerificationFeedback: { disposition: 'failed', criteria: [criterion('passed', 'meets_criterion')] } })
    const failedHtml = renderToStaticMarkup(<NativeVerificationFeedbackCard view={failed} lang="en" />)
    const unavailableHtml = renderToStaticMarkup(<NativeVerificationFeedbackCard view={unavailable} lang="en" />)
    expect(failedHtml).toContain('Failed')
    expect(failedHtml).not.toContain('Checks unavailable')
    expect(unavailableHtml).toContain('data-native-verification-feedback="unavailable"')
    expect(unavailableHtml).toContain('Checks unavailable')
    expect(unavailableHtml).not.toContain('Failed')
  })

  it('renders escaped fixed labels and never renders evidence references or private markers', () => {
    const html = render('passed', 'meets_criterion', 'en', ['private-ref-12345678', 'PRIVATE_DIGEST_MARKER'])
    expect(html).toContain('Result checks')
    expect(html).toContain('Check 1')
    expect(html).toContain('Passed')
    expect(html).not.toContain('private-ref-12345678')
    expect(html).not.toContain('PRIVATE_DIGEST_MARKER')
    expect(html).not.toContain('<script>')
    const malformed = render('passed', 'meets_criterion', 'en', ['<script>marker</script>'])
    expect(malformed).toContain('Checks unavailable')
    expect(malformed).not.toContain('<script>')
  })

  it('keeps wait-result groups distinct and restarts criterion numbering for each result', () => {
    const feedback = { disposition: 'uncertain', criteria: [criterion('passed', 'meets_criterion', ['private-a']), { ...criterion('uncertain', 'ambiguous'), criterionId: 'criterion-2' }] }
    const view = extractNativeVerificationFeedback({ status: 'ready', tasks: [
      { result: { nativeVerificationFeedback: feedback } },
      { result: { nativeVerificationFeedback: { disposition: 'failed', criteria: [criterion('failed', 'does_not_meet_criterion', ['private-b'])] } } },
    ] })
    const html = renderToStaticMarkup(<NativeVerificationFeedbackCard view={view} lang="en" />)
    expect(html).toContain('Result 1')
    expect(html).toContain('Result 2')
    expect(html.match(/Check 1/g)).toHaveLength(2)
    expect(html).not.toContain('Check 3')
    expect(html).not.toContain('private-a')
    expect(html).not.toContain('private-b')
  })

  it('renders nothing when no recognized feedback is available', () => {
    expect(renderToStaticMarkup(<NativeVerificationFeedbackCard view={{ state: 'none' }} lang="en" />)).toBe('')
  })
})
