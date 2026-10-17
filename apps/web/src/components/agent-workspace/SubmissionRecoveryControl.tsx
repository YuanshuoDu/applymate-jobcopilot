'use client'

import React from 'react'

interface SubmissionRecoveryControlProps {
  sessionId: string
  applicationTaskId: string
  taskStatus: string
  checkpoint: string | null
}

export async function postSubmissionRecovery(sessionId: string, applicationTaskId: string, confirmedNotReceived: boolean) {
  if (!confirmedNotReceived) throw new Error('confirmation_required')
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'confirm_submission_not_received',
      applicationTaskId,
      requestId: crypto.randomUUID(),
      confirmedNotReceived: true,
    }),
  })
  if (!response.ok) throw new Error(`server_rejected:${response.status}`)
  window.dispatchEvent(new Event('applymate:sessions-changed'))
}

export function SubmissionRecoveryControl({ sessionId, applicationTaskId, taskStatus, checkpoint }: SubmissionRecoveryControlProps) {
  const [confirmed, setConfirmed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [requested, setRequested] = React.useState(false)
  const [error, setError] = React.useState('')

  if (taskStatus !== 'waiting_for_user' || checkpoint !== 'submission_uncertain') return null

  async function onConfirm() {
    if (!confirmed || submitting || requested) return
    setSubmitting(true)
    setError('')
    try {
      await postSubmissionRecovery(sessionId, applicationTaskId, confirmed)
      setRequested(true)
    } catch (reason) {
      const status = reason instanceof Error ? /^server_rejected:(\d+)$/.exec(reason.message)?.[1] : null
      setError(status ? `Recovery rejected by the server (HTTP ${status}). Refresh before trying again.` : 'Could not start a fresh form review. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={containerStyle} data-submission-recovery="true">
      {requested ? <div role="status" style={statusStyle}>A fresh fill-and-review attempt was requested. The previous submission outcome is still uncertain.</div> : <>
        <div style={warningStyle}>This is your attestation, not proof from the employer. A request already delivered may still be processed later.</div>
        <label style={labelStyle}>
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          I checked the employer&apos;s site and confirmed that no application appears.
        </label>
        <div style={noteStyle}>This starts a fresh form fill for review. It will not submit the application.</div>
        <button type="button" disabled={!confirmed || submitting} onClick={() => { void onConfirm() }} style={buttonStyle}>
          {submitting ? 'Starting…' : 'Confirm and start fresh fill for review'}
        </button>
        {error && <div role="alert" aria-live="assertive" style={errorStyle}>{error}</div>}
      </>}
    </div>
  )
}

const containerStyle: React.CSSProperties = { padding: 8, marginTop: 7, border: '1px solid var(--border)', borderRadius: 6, display: 'grid', gap: 6 }
const warningStyle: React.CSSProperties = { fontSize: 10, lineHeight: 1.45, color: '#92400e' }
const labelStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 10, lineHeight: 1.4, color: 'var(--text)' }
const noteStyle: React.CSSProperties = { fontSize: 9, lineHeight: 1.4, color: 'var(--text-muted)' }
const buttonStyle: React.CSSProperties = { justifySelf: 'start', fontSize: 9, color: '#0f766e', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '4px 6px', cursor: 'pointer' }
const errorStyle: React.CSSProperties = { fontSize: 9, color: '#b91c1c' }
const statusStyle: React.CSSProperties = { fontSize: 10, lineHeight: 1.45, color: 'var(--c-success)' }
