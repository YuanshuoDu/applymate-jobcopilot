import { useState, type ReactNode } from 'react'
import { Settings } from 'lucide-react'
import { C, type PopupLabels } from './popup-constants'

export function PopupHeader({ user, onSettings, onLogout, onDashboard, labels }: { user: string; onSettings: () => void; onLogout: () => void; onDashboard: () => void; labels: PopupLabels }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const initial = user.trim().slice(0, 1).toUpperCase() || 'A'
  return (
    <header style={{ position: 'relative', padding: '16px 16px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <div role="img" aria-label="ApplyMate AI" style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: 14, background: 'linear-gradient(135deg, #5146E5 0%, #7038D8 100%)', color: '#fff', fontSize: 22, fontWeight: 800, boxShadow: '0 6px 14px rgba(81,70,229,0.20)' }}>A</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, lineHeight: 1.1, fontWeight: 750, color: C.navy, letterSpacing: '-0.03em' }}>ApplyMate AI</div>
          <div style={{ marginTop: 5, fontSize: 12, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 155 }}>Your AI job copilot</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <IconButton label={labels.menuSettings} onClick={onSettings}><Settings size={22} strokeWidth={1.8} /></IconButton>
        <button type="button" aria-label="Account menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} style={{ width: 38, height: 38, borderRadius: '50%', border: 'none', background: '#EAEAFF', color: C.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{initial}</button>
      </div>
      {menuOpen && <div role="menu" style={{ position: 'absolute', right: 14, top: 68, zIndex: 3, width: 172, padding: 6, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: '0 12px 30px rgba(31,38,94,0.16)' }}>
        <MenuButton label={labels.menuDashboard} onClick={onDashboard} />
        <MenuButton label={labels.menuSettings} onClick={onSettings} />
        <MenuButton label={labels.menuSignOut} onClick={onLogout} danger />
      </div>}
    </header>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', border: 'none', borderRadius: '50%', background: 'transparent', color: C.muted, cursor: 'pointer' }}>{children}</button>
}

function MenuButton({ label, onClick, danger = false }: { label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} style={{ display: 'block', width: '100%', padding: '9px 10px', border: 'none', borderRadius: 8, background: 'transparent', textAlign: 'left', color: danger ? '#B54747' : C.navy, fontSize: 12, cursor: 'pointer' }}>{label}</button>
}
