import React from 'react'

export function AgentNewChatWelcome() {
  return (
    <section aria-label="New chat welcome" style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 'clamp(28px, 7vh, 88px) 20px' }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 15, textAlign: 'center' }}>
        <span aria-label="ApplyMate AI" style={{
          width: 58, height: 58, display: 'grid', placeItems: 'center', borderRadius: 18,
          background: 'var(--brand-gradient)', color: '#fff', fontSize: 25, fontWeight: 800,
          letterSpacing: '-0.06em', boxShadow: '0 12px 28px rgba(79,70,229,0.24)',
        }}>A</span>
        <div>
          <h1 style={{ margin: 0, fontSize: 'clamp(23px, 3vw, 32px)', lineHeight: 1.16, letterSpacing: '-0.04em', color: 'var(--text)' }}>
            What can I help you with?
          </h1>
          <p style={{ margin: '9px auto 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)' }}>
            Start a new ApplyMate conversation below.
          </p>
        </div>
      </div>
    </section>
  )
}
