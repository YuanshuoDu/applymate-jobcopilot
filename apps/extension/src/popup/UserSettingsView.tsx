import { useState } from 'react'
import { ArrowLeft, ExternalLink, LogOut, SlidersHorizontal, UserRound } from 'lucide-react'
import { saveSettings } from '@/lib/storage'
import type { ExtensionSettings } from '@/lib/types'
import { C } from './popup-constants'
import { getLabels } from './popup-utils'

export function UserSettingsView({ settings, onBack, onLogout }: {
  settings: ExtensionSettings
  onBack: () => void
  onLogout: () => void
}) {
  const labels = getLabels()
  const [autoSave, setAutoSave] = useState(settings.autoSave)
  const [saved, setSaved] = useState(false)

  async function toggleAutoSave() {
    const next = !autoSave
    setAutoSave(next)
    await saveSettings({ autoSave: next })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  const openAccount = () => chrome.tabs.create({ url: `${settings.apiBaseUrl}/?page=settings` })

  return <div style={{ minHeight: 360, background: C.bg, color: C.navy, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 14px 11px', borderBottom: `1px solid ${C.border}` }}>
      <button type="button" aria-label={labels.settingsBack} onClick={onBack} style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 9, background: C.lavender, color: C.primary, cursor: 'pointer' }}><ArrowLeft size={16} /></button>
      <h1 style={{ margin: 0, fontSize: 17, fontWeight: 730, letterSpacing: '-0.02em' }}>{labels.menuSettings}</h1>
    </header>

    <main style={{ padding: '12px 10px 14px', display: 'grid', gap: 10 }}>
      <section style={{ padding: 12, border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, boxShadow: C.shadow }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 11, background: C.lavender, color: C.primary }}><UserRound size={18} /></div>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 680 }}>{labels.account}</div><div style={{ marginTop: 3, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.muted }}>{settings.userEmail}</div></div>
          <span style={{ marginLeft: 'auto', flexShrink: 0, padding: '4px 7px', borderRadius: 999, background: C.greenBg, color: C.green, fontSize: 10, fontWeight: 680 }}>{labels.signedIn}</span>
        </div>
      </section>

      <section style={{ padding: 12, border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, boxShadow: C.shadow }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><SlidersHorizontal size={15} color={C.primary} /><h2 style={{ margin: 0, fontSize: 12, fontWeight: 680 }}>{labels.preferences}</h2></div>
        <button type="button" onClick={() => void toggleAutoSave()} aria-pressed={autoSave} style={{ display: 'flex', alignItems: 'center', width: '100%', padding: 0, border: 'none', background: 'transparent', color: C.navy, textAlign: 'left', cursor: 'pointer' }}>
          <span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', fontSize: 12, fontWeight: 650 }}>{labels.autoSave}</strong><small style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: C.muted }}>{labels.autoSaveSub}</small></span>
          <span style={{ width: 36, height: 21, padding: 2, borderRadius: 999, background: autoSave ? C.primary : '#D8DCEB', transition: 'background .16s' }}><span style={{ display: 'block', width: 17, height: 17, borderRadius: '50%', background: '#fff', transform: autoSave ? 'translateX(15px)' : 'translateX(0)', transition: 'transform .16s', boxShadow: '0 1px 3px rgba(16,26,58,.18)' }} /></span>
        </button>
        {saved && <div role="status" style={{ marginTop: 8, color: C.green, fontSize: 10.5 }}>{labels.savedConfirm}</div>}
      </section>

      <button type="button" onClick={openAccount} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 11, background: C.panel, color: C.primary, fontSize: 12, fontWeight: 680, cursor: 'pointer' }}>{labels.manageAccount}<ExternalLink size={14} /></button>
      <button type="button" onClick={onLogout} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 12px', border: 'none', background: 'transparent', color: '#B54747', fontSize: 11, cursor: 'pointer' }}><LogOut size={14} />{labels.menuSignOut}</button>
    </main>
  </div>
}
