import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Settings } from 'lucide-react'
import { C, type PopupLabels } from './popup-constants'

export function PopupHeader({ user, onSettings, onLogout, onDashboard, labels }: { user: string; onSettings: () => void; onLogout: () => void; onDashboard: () => void; labels: PopupLabels }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const initial = user.trim().slice(0, 1).toUpperCase() || 'A'
  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const runMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  return (
    <header style={{ position: 'relative', padding: '10px 12px 9px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <img src={chrome.runtime.getURL('icons/icon48.png')} alt="ApplyMate AI" width={38} height={38} style={{ display: 'block', borderRadius: 12, boxShadow: '0 5px 12px rgba(81,70,229,0.18)' }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, lineHeight: 1.1, fontWeight: 750, color: C.navy, letterSpacing: '-0.03em' }}>ApplyMate AI</div>
          <div style={{ marginTop: 3, fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 155 }}>{labels.yourAiJobCopilot}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <IconButton label={labels.menuSettings} onClick={onSettings}><Settings size={19} strokeWidth={1.8} /></IconButton>
        <button ref={triggerRef} type="button" aria-label={labels.accountMenu} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: '#EAEAFF', color: C.primary, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{initial}</button>
      </div>
      {menuOpen && <div ref={menuRef} role="menu" style={{ position: 'absolute', right: 14, top: 61, zIndex: 3, width: 172, padding: 6, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: '0 12px 30px rgba(31,38,94,0.16)' }}>
        <MenuButton label={labels.menuDashboard} onClick={() => runMenuAction(onDashboard)} />
        <MenuButton label={labels.menuSettings} onClick={() => runMenuAction(onSettings)} />
        <MenuButton label={labels.menuSignOut} onClick={() => runMenuAction(onLogout)} danger />
      </div>}
    </header>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', border: `1px solid ${C.border}`, borderRadius: '50%', background: '#FCFCFF', color: C.muted, cursor: 'pointer' }}>{children}</button>
}

function MenuButton({ label, onClick, danger = false }: { label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} style={{ display: 'block', width: '100%', padding: '9px 10px', border: 'none', borderRadius: 8, background: 'transparent', textAlign: 'left', color: danger ? '#B54747' : C.navy, fontSize: 12, cursor: 'pointer' }}>{label}</button>
}
