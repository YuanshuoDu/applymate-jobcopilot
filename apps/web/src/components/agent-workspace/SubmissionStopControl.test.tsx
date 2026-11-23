import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isSubmissionStopTarget, parseSubmissionStopOutcome, postSubmissionStop,
  postSubmissionStopAndRefresh, SubmissionStopControl, submissionStopFeedback, submissionStopMessage,
} from './SubmissionStopControl'

const mocks = vi.hoisted(() => ({ lang: 'en' as 'en' | 'de' | 'fr' | 'es' | 'nl' | 'zh' }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: mocks.lang }) }))

const target = `ast1_${'a'.repeat(64)}`
const outcomes = ['stop_requested', 'too_late', 'submitted', 'uncertain'] as const

describe('Workbench submission Stop control', () => {
  beforeEach(() => { mocks.lang = 'en' })

  it('accepts only the exact opaque server target shape', () => {
    expect(isSubmissionStopTarget(target)).toBe(true)
    expect(isSubmissionStopTarget(`ast1_${'A'.repeat(64)}`)).toBe(false)
    expect(isSubmissionStopTarget('private-attempt-id')).toBe(false)
    expect(isSubmissionStopTarget(null)).toBe(false)
  })

  it.each(outcomes)('accepts the closed %s outcome', outcome => {
    expect(parseSubmissionStopOutcome({ outcome })).toBe(outcome)
    expect(parseSubmissionStopOutcome({ outcome, privateId: 'x' })).toBe(null)
  })

  it('posts the exact rendered token and owned IDs once without a rebind read', async () => {
    const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ outcome: 'stop_requested' }), { status: 200 })
    }
    await expect(postSubmissionStop('session-owned', 'task-owned', target, fetcher)).resolves.toBe('stop_requested')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/agent/application-tasks/submission-stop')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: 'session-owned', applicationTaskId: 'task-owned', expectedAttemptTarget: target,
    })
  })

  it('refreshes the displayed session after recording an outcome without retrying on refresh failure', async () => {
    let requests = 0
    const fetcher: typeof fetch = async () => { requests += 1; return new Response(JSON.stringify({ outcome: 'too_late' }), { status: 200 }) }
    const onOutcome = vi.fn(), onRefresh = vi.fn().mockRejectedValue(new Error('refresh unavailable'))
    await expect(postSubmissionStopAndRefresh('s', 't', target, onOutcome, onRefresh, fetcher)).resolves.toBe('too_late')
    expect(onOutcome).toHaveBeenCalledWith('too_late')
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(requests).toBe(1)
  })

  it('does not send an invalid target and treats ambiguous responses as uncertain', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(postSubmissionStop('session', 'task', 'invalid', fetcher)).resolves.toBe(null)
    expect(fetcher).not.toHaveBeenCalled()
    const failed: typeof fetch = async () => new Response(JSON.stringify({ outcome: 'stop_requested' }), { status: 503 })
    await expect(postSubmissionStop('session', 'task', target, failed)).resolves.toBe('uncertain')
    const malformed: typeof fetch = async () => new Response('{', { status: 200 })
    await expect(postSubmissionStop('session', 'task', target, malformed)).resolves.toBe('uncertain')
  })

  it('keeps same-attempt feedback after token removal and marks a different valid token as the successor', () => {
    const feedback = { target, outcome: 'stop_requested' as const }
    expect(submissionStopFeedback(feedback, target)).toEqual({ outcome: 'stop_requested', previous: false })
    expect(submissionStopFeedback(feedback, `ast1_${'b'.repeat(64)}`)).toEqual({ outcome: 'stop_requested', previous: true })
    expect(submissionStopFeedback(feedback, null)).toEqual({ outcome: 'stop_requested', previous: false })
    expect(submissionStopFeedback(feedback, 'invalid')).toEqual({ outcome: 'stop_requested', previous: false })
    expect(submissionStopMessage('stop_requested', 'en', submissionStopFeedback(feedback, null)!.previous))
      .not.toContain('Previous attempt')
    expect(submissionStopMessage('stop_requested', 'en', submissionStopFeedback(feedback, `ast1_${'b'.repeat(64)}`)!.previous))
      .toContain('Previous attempt')
  })

  it('renders no action without an eligible exact target and localizes the four outcomes', () => {
    expect(renderToStaticMarkup(<SubmissionStopControl sessionId="s" applicationTaskId="t" eligible target="bad" />)).toBe('')
    expect(renderToStaticMarkup(<SubmissionStopControl sessionId="s" applicationTaskId="t" eligible={false} target={target} />)).toBe('')
    expect(renderToStaticMarkup(<SubmissionStopControl sessionId="s" applicationTaskId="t" eligible target={target} />)).toContain('Stop submission')
    for (const outcome of outcomes) expect(submissionStopMessage(outcome, 'zh')).not.toBe(submissionStopMessage(outcome, 'en'))
    expect(submissionStopMessage('submitted', 'en')).toContain('confirmed evidence')
    expect(submissionStopMessage('stop_requested', 'en', true)).toContain('Previous attempt')
  })
})
