import { useEffect, useState } from 'react'
import { getSettings, isLoggedIn, clearAuth } from '@/lib/storage'
import type { ExtensionSettings } from '@/lib/types'
import { PopupMainView } from './MainView'
import { UserSettingsView } from './UserSettingsView'
import { LoginView, getLoginLabels, getPopupLang, type PopupLang } from './LoginView'

const GLOBAL_CSS = `
  @keyframes am-spin { to { transform: rotate(360deg) } }
  .am-spin { animation: am-spin 0.8s linear infinite; }
  html, body, #root { margin: 0; padding: 0; width: 100%; max-width: 360px; min-width: 0; overflow: hidden; }
  body { background: #F8F8FF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
`

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [view, setView] = useState<'main' | 'login' | 'settings'>('main')
  const [lang, setLang] = useState<PopupLang>('en')

  useEffect(() => {
    setLang(getPopupLang())
    const timer = window.setInterval(() => setLang(getPopupLang()), 2000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    const applySettings = (next: ExtensionSettings) => {
      if (!active) return
      setSettings(next)
      setView(current => !isLoggedIn(next) ? 'login' : current === 'login' ? 'main' : current)
    }
    void getSettings().then(applySettings)
    const onStorageChange = (changes: { settings?: chrome.storage.StorageChange }, area: string) => {
      if (area === 'sync' && changes.settings) void getSettings().then(applySettings)
    }
    chrome.storage.onChanged.addListener(onStorageChange)
    return () => {
      active = false
      chrome.storage.onChanged.removeListener(onStorageChange)
    }
  }, [])

  const labels = getLoginLabels(lang)
  const login = (next: ExtensionSettings) => { setSettings(next); setView('main') }
  const logout = () => {
    setSettings(current => current ? { ...current, apiToken: '', userEmail: '', userName: '' } : current)
    void clearAuth()
    setView('login')
  }

  return <>
    <style>{GLOBAL_CSS}</style>
    {!settings ? <LoadingScreen /> : view === 'login' ? (
      <LoginView settings={settings} labels={labels} onLogin={login} />
    ) : view === 'settings' ? (
      <UserSettingsView settings={settings} onBack={() => setView('main')} onLogout={logout} />
    ) : (
      <PopupMainView settings={settings} onSettings={() => setView('settings')} onLogout={logout} />
    )}
  </>
}

function LoadingScreen() {
  return <div style={{ height: 240, display: 'grid', placeItems: 'center', background: '#F8F8FF' }}>
    <div style={{ width: 22, height: 22, border: '2.5px solid rgba(79,70,229,0.15)', borderTopColor: '#5146E5', borderRadius: '50%' }} className="am-spin" />
  </div>
}
