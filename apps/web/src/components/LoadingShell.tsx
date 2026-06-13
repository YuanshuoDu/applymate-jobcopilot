export function LoadingShell({ text = 'Loading…' }: { text?: string }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-tertiary)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 28, height: 28,
          border: '2.5px solid rgba(79,70,229,0.20)',
          borderTopColor: 'var(--primary)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }} />
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{text}</div>
      </div>
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
      {/* Top bar skeleton */}
      <div style={{
        height: 48, background: 'var(--bg)',
        borderBottom: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 20px',
      }}>
        <div style={{ width: 100, height: 12, background: 'var(--bg-tertiary)', borderRadius: 4 }} />
      </div>
      {/* Content skeleton */}
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          {[1,2,3,4].map(i => (
            <div key={i} style={{ height: 80, background: 'var(--bg)', borderRadius: 12, border: '0.5px solid var(--border)' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <div style={{ height: 300, background: 'var(--bg)', borderRadius: 12, border: '0.5px solid var(--border)' }} />
          <div style={{ height: 300, background: 'var(--bg)', borderRadius: 12, border: '0.5px solid var(--border)' }} />
        </div>
      </div>
    </div>
  )
}
