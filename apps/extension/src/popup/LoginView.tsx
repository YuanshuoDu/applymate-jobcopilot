import { useEffect, useState, type ReactNode } from 'react'
import { login as apiLogin } from '@/lib/api'
import { saveSettings } from '@/lib/storage'
import type { ExtensionSettings } from '@/lib/types'
import { openCurrentSidePanel } from './popup-utils'
import { C } from './popup-constants'

export type PopupLang = 'en' | 'de' | 'fr' | 'es' | 'nl' | 'zh'

type LoginLabels = {
  connectTitle: string; connectSub: string; emailLabel: string; pwLabel: string
  loginBtn: string; loggingIn: string; noAccount: string; signupLink: string
  googleLogin: string; githubLogin: string; orEmail: string; openSidebar: string
  loginError: string; sidePanelError: string
}

const LABELS: Record<PopupLang, LoginLabels> = {
  en: { connectTitle: 'Connect to ApplyMate AI', connectSub: 'Sign in to sync all your jobs automatically', emailLabel: 'Email', pwLabel: 'Password', loginBtn: 'Sign in', loggingIn: 'Signing in…', noAccount: "Don't have an account?", signupLink: 'Sign up free →', googleLogin: 'Sign in with Google', githubLogin: 'Sign in with GitHub', orEmail: 'or sign in with email', openSidebar: 'Open sidebar', loginError: 'Sign in failed', sidePanelError: 'Chrome could not open the side panel. Use the Side panel button in the toolbar.' },
  de: { connectTitle: 'Mit ApplyMate AI verbinden', connectSub: 'Melde dich an, um Jobs automatisch zu synchronisieren', emailLabel: 'E-Mail', pwLabel: 'Passwort', loginBtn: 'Anmelden', loggingIn: 'Anmelden…', noAccount: 'Noch kein Konto?', signupLink: 'Kostenlos registrieren →', googleLogin: 'Mit Google anmelden', githubLogin: 'Mit GitHub anmelden', orEmail: 'oder mit E-Mail anmelden', openSidebar: 'Seitenleiste öffnen', loginError: 'Anmeldung fehlgeschlagen', sidePanelError: 'Die Seitenleiste konnte nicht geöffnet werden.' },
  fr: { connectTitle: 'Connecter à ApplyMate AI', connectSub: 'Connectez-vous pour synchroniser vos offres', emailLabel: 'E-mail', pwLabel: 'Mot de passe', loginBtn: 'Se connecter', loggingIn: 'Connexion…', noAccount: 'Pas de compte?', signupLink: 'Inscription gratuite →', googleLogin: 'Se connecter avec Google', githubLogin: 'Se connecter avec GitHub', orEmail: 'ou se connecter par e-mail', openSidebar: 'Ouvrir le panneau', loginError: 'Connexion échouée', sidePanelError: 'Le panneau latéral n’a pas pu être ouvert.' },
  es: { connectTitle: 'Conectar a ApplyMate AI', connectSub: 'Inicia sesión para sincronizar tus empleos', emailLabel: 'Correo', pwLabel: 'Contraseña', loginBtn: 'Iniciar sesión', loggingIn: 'Iniciando sesión…', noAccount: '¿Sin cuenta?', signupLink: 'Registrarse gratis →', googleLogin: 'Iniciar sesión con Google', githubLogin: 'Iniciar sesión con GitHub', orEmail: 'o iniciar sesión con correo', openSidebar: 'Abrir panel', loginError: 'Error de inicio', sidePanelError: 'No se pudo abrir el panel lateral.' },
  nl: { connectTitle: 'Verbinden met ApplyMate AI', connectSub: 'Log in om vacatures automatisch te synchroniseren', emailLabel: 'E-mail', pwLabel: 'Wachtwoord', loginBtn: 'Inloggen', loggingIn: 'Inloggen…', noAccount: 'Geen account?', signupLink: 'Gratis registreren →', googleLogin: 'Inloggen met Google', githubLogin: 'Inloggen met GitHub', orEmail: 'of inloggen met e-mail', openSidebar: 'Zijpaneel openen', loginError: 'Inloggen mislukt', sidePanelError: 'Het zijpaneel kon niet worden geopend.' },
  zh: { connectTitle: '连接 ApplyMate AI', connectSub: '登录后自动同步所有职位', emailLabel: '邮箱', pwLabel: '密码', loginBtn: '登录', loggingIn: '登录中…', noAccount: '还没有账号？', signupLink: '免费注册 →', googleLogin: '使用 Google 登录', githubLogin: '使用 GitHub 登录', orEmail: '或使用邮箱登录', openSidebar: '打开侧边栏', loginError: '登录失败', sidePanelError: 'Chrome 无法打开侧边栏，请使用浏览器工具栏中的侧边栏按钮。' },
}

export function getPopupLang(): PopupLang {
  try {
    const value = localStorage.getItem('applymate_lang') as PopupLang | null
    if (value && value in LABELS) return value
  } catch { /* popup storage can be unavailable during extension reload */ }
  return 'en'
}

export function getLoginLabels(lang: PopupLang): LoginLabels { return LABELS[lang] }

export function LoginView({ settings, labels, onLogin }: { settings: ExtensionSettings; labels: LoginLabels; onLogin: (settings: ExtensionSettings) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [oauthPending, setOauthPending] = useState(false)

  useEffect(() => {
    if (!oauthPending) return
    let stopped = false
    let timer: number | undefined
    const deadline = Date.now() + 30_000
    const startingToken = settings.apiToken
    const startingEmail = settings.userEmail
    const accept = (candidate: Partial<ExtensionSettings>) => {
      if (stopped || !candidate.apiToken || !candidate.userEmail) return false
      if (candidate.apiToken === startingToken && candidate.userEmail === startingEmail) return false
      stopped = true
      setOauthPending(false)
      onLogin({ ...settings, ...candidate } as ExtensionSettings)
      return true
    }
    const poll = async () => {
      if (stopped) return
      if (Date.now() > deadline) return
      const result = await chrome.storage.sync.get('settings').catch(() => ({ settings: undefined }))
      if (!accept((result.settings ?? {}) as Partial<ExtensionSettings>)) timer = window.setTimeout(poll, 1500)
    }
    const onStorageChange = (changes: { settings?: { newValue?: ExtensionSettings } }, area: string) => {
      if (area === 'sync') accept(changes.settings?.newValue ?? {})
    }
    chrome.storage.onChanged.addListener(onStorageChange)
    timer = window.setTimeout(poll, 1200)
    const timeout = window.setTimeout(() => { if (!stopped) { stopped = true; setOauthPending(false); setError('OAuth sign-in timed out. Your previous session was kept.') } }, 30_000)
    return () => { stopped = true; if (timer) window.clearTimeout(timer); window.clearTimeout(timeout); chrome.storage.onChanged.removeListener(onStorageChange) }
  }, [oauthPending, onLogin, settings])

  const openOAuth = () => {
    setError('')
    setOauthPending(true)
    const url = new URL('/login', settings.apiBaseUrl)
    url.searchParams.set('switchAccount', '1')
    url.searchParams.set('callbackUrl', '/')
    void chrome.tabs.create({ url: url.toString(), active: true })
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault(); setError(''); setLoading(true)
    try {
      const result = await apiLogin(settings, email, password)
      const next = { ...settings, apiToken: result.token, userEmail: result.user.email, userName: result.user.name ?? '' }
      await saveSettings(next); onLogin(next)
    } catch (caught) { setError(caught instanceof Error ? caught.message : labels.loginError) }
    finally { setLoading(false) }
  }

  return <div style={{ background: C.bg, minHeight: 360, color: C.navy }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${C.border}` }}>
      <img src={chrome.runtime.getURL('icons/icon48.png')} alt="ApplyMate AI" width={32} height={32} style={{ display: 'block', borderRadius: 10 }} />
      <div><div style={{ fontSize: 15, fontWeight: 750 }}>ApplyMate AI</div><div style={{ marginTop: 2, fontSize: 10, color: C.muted }}>Your AI job copilot</div></div>
    </header>
    <main style={{ padding: '20px 20px 22px' }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{labels.connectTitle}</div><div style={{ fontSize: 11.5, color: C.muted }}>{labels.connectSub}</div></div>
      {oauthPending ? <div style={{ textAlign: 'center', padding: '16px 12px', background: C.lavender, borderRadius: 10, border: `1px solid ${C.border}`, color: C.muted, fontSize: 12 }}><div className="am-spin" style={{ width: 16, height: 16, margin: '0 auto 8px', border: '2px solid rgba(79,70,229,0.2)', borderTopColor: C.primary, borderRadius: '50%' }} />Waiting for login in browser tab…<br /><button type="button" onClick={() => setOauthPending(false)} style={linkStyle}>Cancel</button></div> : <>
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}><OAuthButton icon={<GoogleIcon />} label={labels.googleLogin} onClick={openOAuth} /><OAuthButton icon={<GitHubIcon />} label={labels.githubLogin} onClick={openOAuth} dark /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}><span style={ruleStyle} /><span style={{ fontSize: 10, color: C.subtle }}>{labels.orEmail}</span><span style={ruleStyle} /></div>
        <form onSubmit={handleLogin} style={{ display: 'grid', gap: 10 }}><Input label={labels.emailLabel} type="email" value={email} onChange={setEmail} placeholder="you@example.com" /><Input label={labels.pwLabel} type="password" value={password} onChange={setPassword} placeholder="••••••••" />{error && <div role="alert" style={{ fontSize: 11, color: '#B54747', padding: '7px 10px', background: '#FFF2F2', borderRadius: 7 }}>{error}</div>}<Button type="submit" disabled={loading} primary>{loading ? labels.loggingIn : labels.loginBtn}</Button></form>
        <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 14 }}>{labels.noAccount}<a href={`${settings.apiBaseUrl}/register`} target="_blank" rel="noreferrer" style={{ ...linkStyle, marginLeft: 4 }}>{labels.signupLink}</a></div>
      </>}
      <div style={{ marginTop: 16, paddingTop: 11, borderTop: `1px solid ${C.border}`, textAlign: 'center' }}><button type="button" onClick={() => void openCurrentSidePanel().catch(() => setError(labels.sidePanelError))} style={linkStyle}>{labels.openSidebar}</button></div>
    </main>
  </div>
}

const ruleStyle = { flex: 1, height: 1, background: C.border }
const linkStyle = { border: 'none', padding: '4px 8px', background: 'transparent', color: C.primary, fontSize: 11, cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit' }

function GoogleIcon() { return <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> }
function GitHubIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688.1.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg> }

function OAuthButton({ icon, label, onClick, dark }: { icon: ReactNode; label: string; onClick: () => void; dark?: boolean }) { return <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '9px 12px', borderRadius: 9, background: dark ? '#24292e' : '#fff', border: dark ? 'none' : `1.5px solid ${C.border}`, color: dark ? '#fff' : C.navy, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>{icon}{label}</button> }
function Input({ label, type, value, onChange, placeholder }: { label: string; type: string; value: string; onChange: (value: string) => void; placeholder: string }) { return <label style={{ display: 'grid', gap: 5 }}><span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{label}</span><input type={type} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} style={{ padding: '8px 11px', fontSize: 12, outline: 'none', background: C.lavender, color: C.navy, borderRadius: 9, border: `1px solid ${C.border}`, fontFamily: 'inherit' }} /></label> }
function Button({ children, disabled, primary, type = 'button' }: { children: ReactNode; disabled?: boolean; primary?: boolean; type?: 'submit' | 'button' }) { return <button type={type} disabled={disabled} style={{ width: '100%', padding: '9px', borderRadius: 9, background: primary ? C.primary : C.lavender, color: primary ? '#fff' : C.navy, border: primary ? 'none' : `1px solid ${C.border}`, fontSize: 12, fontWeight: 650, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.7 : 1, fontFamily: 'inherit' }}>{children}</button> }
