import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postSubmissionRecovery, SubmissionRecoveryControl } from './SubmissionRecoveryControl'

function render(taskStatus = 'waiting_for_user', checkpoint: string | null = 'submission_uncertain') {
  return renderToStaticMarkup(<SubmissionRecoveryControl sessionId="session/1" applicationTaskId="application_1" taskStatus={taskStatus} checkpoint={checkpoint} />)
}

describe('SubmissionRecoveryControl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows recovery only for a waiting task with an uncertain submission', () => {
    expect(render()).toContain('data-submission-recovery="true"')
    expect(render('filling')).toBe('')
    expect(render('failed')).toBe('')
    expect(render('waiting_for_user', 'form_answer_required')).toBe('')
  })

  it('requires explicit employer-site confirmation before enabling recovery', () => {
    const html = render()
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('I checked the employer&#x27;s site and confirmed that no application appears.')
  })

  it('explains uncertainty and that recovery never submits', () => {
    const html = render()
    expect(html).toContain('This is your attestation, not proof from the employer.')
    expect(html).toContain('A request already delivered may still be processed later.')
    expect(html).toContain('It will not submit the application.')
    expect(html).not.toContain('type="submit"')
  })

  it('does not make a request without confirmation', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(postSubmissionRecovery('session_1', 'application_1', false)).rejects.toThrow('confirmation_required')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts only the recovery action and refreshes on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    const dispatchEvent = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('recovery-request-1234') })
    vi.stubGlobal('window', { dispatchEvent })

    await postSubmissionRecovery('session/1', 'application_1', true)

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session%2F1/actions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'confirm_submission_not_received', applicationTaskId: 'application_1', requestId: 'recovery-request-1234', confirmedNotReceived: true }),
    }))
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/submit')
    expect(dispatchEvent).toHaveBeenCalledOnce()
  })
})
