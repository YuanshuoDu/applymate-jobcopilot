'use client'

import React from 'react'
import type { TurnComposerController } from './agent-turn-commands'

const composerStatusLabel = {
  sending: 'Sending',
  accepted: 'Accepted',
  consumed: 'Consumed',
  failed: 'Failed',
} as const

export function AgentComposerActiveTurn({ controller }: { controller: TurnComposerController }) {
  return (
    <div data-testid="active-turn-composer" style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(79,70,229,0.05)', border: '1px solid rgba(79,70,229,0.14)', color: 'var(--text)', fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>Active Turn: {controller.activeTurn?.status ?? 'ready'}{controller.activeTurn ? ` · revision ${controller.activeTurn.revision}` : ''}</span>
        {controller.activeTurn && (
          <button type="button" data-testid="interrupt-turn" onClick={controller.interrupt} disabled={controller.interrupting} style={{ minHeight: 28, padding: '0 9px', border: '1px solid rgba(220,38,38,0.28)', borderRadius: 7, background: 'transparent', color: '#b91c1c', cursor: controller.interrupting ? 'wait' : 'pointer', font: 'inherit', fontWeight: 700 }}>
            {controller.interrupting ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      <div role="group" aria-label="Turn delivery" style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
        {(['steer', 'follow_up'] as const).map(option => (
          <button key={option} type="button" aria-pressed={controller.delivery === option} onClick={() => controller.setDelivery(option)} style={{ minHeight: 28, padding: '0 8px', border: `1px solid ${controller.delivery === option ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 7, background: controller.delivery === option ? 'rgba(79,70,229,0.1)' : 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 650 }}>
            {option === 'steer' ? 'Steer current Turn' : 'Queue follow-up'}
          </button>
        ))}
      </div>
      {controller.commandError && (
        <div role="alert" data-testid="turn-command-error" style={{ marginTop: 7, color: '#b91c1c' }}>
          {controller.commandError.code}: {controller.commandError.message}
        </div>
      )}
      {controller.messages.length > 0 && (
        <div aria-live="polite" style={{ display: 'grid', gap: 3, marginTop: 7 }}>
          {controller.messages.map(message => (
            <div key={message.clientMessageId} data-testid={`turn-message-${message.status}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{message.text}</span>
              <strong>{composerStatusLabel[message.status]}</strong>
              {message.error && <span>{message.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
