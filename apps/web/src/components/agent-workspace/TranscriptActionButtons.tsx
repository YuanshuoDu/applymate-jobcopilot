'use client'

import React from 'react'

export interface TranscriptButtonAction {
  label: string
  onClick?: () => Promise<void> | void
}

export function transcriptActionErrorText(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message.trim() ? message : `${label} failed. Please try again.`
}

export function TranscriptActionButtons({ actions }: { actions: TranscriptButtonAction[] }) {
  const [pendingLabel, setPendingLabel] = React.useState<string | null>(null)
  const [errorText, setErrorText] = React.useState<string | null>(null)

  async function run(action: TranscriptButtonAction) {
    if (!action.onClick || pendingLabel) return
    setPendingLabel(action.label)
    setErrorText(null)
    try {
      await action.onClick()
    } catch (error) {
      setErrorText(transcriptActionErrorText(action.label, error))
    } finally {
      setPendingLabel(null)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {actions.map(action => {
          const disabled = !action.onClick || Boolean(pendingLabel)
          return (
            <button key={action.label} type="button" onClick={() => void run(action)} disabled={disabled} style={{
              border: '1px solid var(--border)',
              borderRadius: 7,
              background: 'var(--bg)',
              color: disabled ? 'var(--text-muted)' : 'var(--text)',
              fontSize: 11,
              padding: '5px 9px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.72 : 1,
              fontFamily: 'inherit',
            }}>
              {pendingLabel === action.label ? 'Working...' : action.label}
            </button>
          )
        })}
      </div>
      {errorText && (
        <div style={{
          marginTop: 7,
          fontSize: 10,
          color: 'var(--c-danger)',
          fontWeight: 650,
        }}>
          {errorText}
        </div>
      )}
    </div>
  )
}
