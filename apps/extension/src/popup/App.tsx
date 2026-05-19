import { useState, useEffect, useCallback } from 'react'
import { getSettings, saveSettings, isLoggedIn, clearAuth } from '@/lib/storage'
import { login as apiLogin } from '@/lib/api'
import type { ExtensionSettings, ScrapedJob, SavedJob, DashboardStats } from '@/lib/types'

// ── Design tokens (aligned with web app brand) ────────────────
const C = {
  primary:      '#4F46E5',
  primaryHover: '#4338CA',
  accent:       '#7C3AED',
  green:        '#059669',
  red:          '#DC2626',
  amber:        '#D97706',
  teal:         '#0891B2',
  bg:           '#F8F9FF',
  bgCard:       '#FFFFFF',
  bgSecondary:  '#F1F3FF',
  border:       'rgba(99,102,241,0.15)',
  text:         '#0F172A',
  muted:        '#64748B',
  subtle:       '#94A3B8',
  gradient:     'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
}

const SOURCE_META: Record<string, { color: string; label: string }> = {
  linkedin:  { color: '#0077B5', label: 'LinkedIn'  },
  indeed:    { color: '#003A9B', label: 'Indeed'    },
  glassdoor: { color: '#0CAA41', label: 'Glassdoor' },
  stepstone: { color: '#E8001E', label: 'Stepstone' },
  xing:      { color: '#026466', label: 'Xing'      },
  wellfound: { color: '#333333', label: 'Wellfound' },
  greenhouse:{ color: '#3BB273', label: 'Greenhouse'},
  lever:     { color: '#005AFF', label: 'Lever'     },
  workday:   { color: '#F5821F', label: 'Workday'   },
  unknown:   { color: C.primary, label: 'Job'       },
}

// ── i18n (reads same key as web app) ─────────────────────────
type PopupLang = 'en'|'de'|'fr'|'es'|'nl'|'zh'
const POPUP_LABELS: Record<PopupLang, {
  saved:string;applied:string;review:string;interview:string;offer:string;rejected:string
  today:string;yesterday:string;daysAgo:(n:number)=>string
  connectTitle:string;connectSub:string;emailLabel:string;pwLabel:string
  loginBtn:string;loggingIn:string;noAccount:string;signupLink:string
  openSidebar:string;openDashboard:string;currentJob:string;savedJobs:string
  detectingJob:string;browseLinkedIn:string;browseIndeed:string
  savingJob:string;saveJob:string;settingsTitle:string;apiUrl:string
  saveSettings:string;savedConfirm:string;currentAccount:string;notLoggedIn:string
  signOut:string;loginError:string;total:string;applied2:string;interviews:string;offers:string
  googleLogin:string;githubLogin:string;orEmail:string
}> = {
  en: { saved:'Saved',applied:'Applied',review:'In Review',interview:'Interview',offer:'Offer',rejected:'Rejected',today:'Today',yesterday:'Yesterday',daysAgo:n=>`${n}d ago`,connectTitle:'Connect to ApplyMate AI',connectSub:'Sign in to sync all your jobs automatically',emailLabel:'Email',pwLabel:'Password',loginBtn:'Sign in',loggingIn:'Signing in…',noAccount:"Don't have an account?",signupLink:'Sign up free →',openSidebar:'✨ Open AI Sidebar',openDashboard:'Open Dashboard →',currentJob:'Current Job',savedJobs:'Saved',detectingJob:'Detecting job on this page…',browseLinkedIn:'Browse LinkedIn Jobs →',browseIndeed:'Browse Indeed Jobs →',savingJob:'Saving…',saveJob:'⊕ Save to ApplyMate',settingsTitle:'Settings',apiUrl:'API Base URL',saveSettings:'Save settings',savedConfirm:'✓ Saved',currentAccount:'Signed in as:',notLoggedIn:'Not signed in',signOut:'Sign out',loginError:'Sign in failed',total:'Total',applied2:'Applied',interviews:'Interviews',offers:'Offers',googleLogin:'Sign in with Google',githubLogin:'Sign in with GitHub',orEmail:'or sign in with email' },
  de: { saved:'Gespeichert',applied:'Beworben',review:'In Prüfung',interview:'Gespräch',offer:'Angebot',rejected:'Abgelehnt',today:'Heute',yesterday:'Gestern',daysAgo:n=>`vor ${n}d`,connectTitle:'Mit ApplyMate AI verbinden',connectSub:'Melde dich an, um Jobs automatisch zu synchronisieren',emailLabel:'E-Mail',pwLabel:'Passwort',loginBtn:'Anmelden',loggingIn:'Anmelden…',noAccount:'Noch kein Konto?',signupLink:'Kostenlos registrieren →',openSidebar:'✨ KI-Seitenleiste öffnen',openDashboard:'Dashboard öffnen →',currentJob:'Aktueller Job',savedJobs:'Gespeichert',detectingJob:'Job wird erkannt…',browseLinkedIn:'LinkedIn Jobs durchsuchen →',browseIndeed:'Indeed Jobs durchsuchen →',savingJob:'Speichern…',saveJob:'⊕ Zu ApplyMate speichern',settingsTitle:'Einstellungen',apiUrl:'API-Basis-URL',saveSettings:'Einstellungen speichern',savedConfirm:'✓ Gespeichert',currentAccount:'Angemeldet als:',notLoggedIn:'Nicht angemeldet',signOut:'Abmelden',loginError:'Anmeldung fehlgeschlagen',total:'Gesamt',applied2:'Beworben',interviews:'Gespräche',offers:'Angebote',googleLogin:'Mit Google anmelden',githubLogin:'Mit GitHub anmelden',orEmail:'oder mit E-Mail anmelden' },
  fr: { saved:'Sauvegardé',applied:'Postulé',review:'En cours',interview:'Entretien',offer:'Offre',rejected:'Refusé',today:"Aujourd'hui",yesterday:'Hier',daysAgo:n=>`il y a ${n}j`,connectTitle:'Connecter à ApplyMate AI',connectSub:'Connectez-vous pour synchroniser vos offres',emailLabel:'E-mail',pwLabel:'Mot de passe',loginBtn:'Se connecter',loggingIn:'Connexion…',noAccount:'Pas de compte?',signupLink:'Inscription gratuite →',openSidebar:"✨ Ouvrir le panneau IA",openDashboard:'Ouvrir le tableau de bord →',currentJob:'Offre actuelle',savedJobs:'Sauvegardé',detectingJob:"Détection de l'offre…",browseLinkedIn:'Parcourir LinkedIn →',browseIndeed:'Parcourir Indeed →',savingJob:'Enregistrement…',saveJob:'⊕ Sauvegarder',settingsTitle:'Paramètres',apiUrl:"URL de l'API",saveSettings:'Enregistrer',savedConfirm:'✓ Enregistré',currentAccount:'Connecté en tant que:',notLoggedIn:'Non connecté',signOut:'Se déconnecter',loginError:'Connexion échouée',total:'Total',applied2:'Postulé',interviews:'Entretiens',offers:'Offres',googleLogin:'Se connecter avec Google',githubLogin:'Se connecter avec GitHub',orEmail:'ou se connecter par e-mail' },
  es: { saved:'Guardado',applied:'Aplicado',review:'En revisión',interview:'Entrevista',offer:'Oferta',rejected:'Rechazado',today:'Hoy',yesterday:'Ayer',daysAgo:n=>`hace ${n}d`,connectTitle:'Conectar a ApplyMate AI',connectSub:'Inicia sesión para sincronizar tus empleos',emailLabel:'Correo',pwLabel:'Contraseña',loginBtn:'Iniciar sesión',loggingIn:'Iniciando sesión…',noAccount:'¿Sin cuenta?',signupLink:'Registrarse gratis →',openSidebar:'✨ Abrir panel IA',openDashboard:'Abrir panel →',currentJob:'Empleo actual',savedJobs:'Guardado',detectingJob:'Detectando empleo…',browseLinkedIn:'Ver LinkedIn →',browseIndeed:'Ver Indeed →',savingJob:'Guardando…',saveJob:'⊕ Guardar',settingsTitle:'Configuración',apiUrl:'URL base de API',saveSettings:'Guardar',savedConfirm:'✓ Guardado',currentAccount:'Sesión iniciada como:',notLoggedIn:'No conectado',signOut:'Cerrar sesión',loginError:'Error de inicio',total:'Total',applied2:'Aplicado',interviews:'Entrevistas',offers:'Ofertas',googleLogin:'Iniciar sesión con Google',githubLogin:'Iniciar sesión con GitHub',orEmail:'o iniciar sesión con correo' },
  nl: { saved:'Opgeslagen',applied:'Gesolliciteerd',review:'In behandeling',interview:'Gesprek',offer:'Aanbod',rejected:'Afgewezen',today:'Vandaag',yesterday:'Gisteren',daysAgo:n=>`${n}d geleden`,connectTitle:'Verbinden met ApplyMate AI',connectSub:'Log in om vacatures automatisch te synchroniseren',emailLabel:'E-mail',pwLabel:'Wachtwoord',loginBtn:'Inloggen',loggingIn:'Inloggen…',noAccount:'Geen account?',signupLink:'Gratis registreren →',openSidebar:'✨ AI-zijpaneel openen',openDashboard:'Dashboard openen →',currentJob:'Huidige vacature',savedJobs:'Opgeslagen',detectingJob:'Vacature detecteren…',browseLinkedIn:'LinkedIn vacatures →',browseIndeed:'Indeed vacatures →',savingJob:'Opslaan…',saveJob:'⊕ Opslaan',settingsTitle:'Instellingen',apiUrl:'API basis-URL',saveSettings:'Opslaan',savedConfirm:'✓ Opgeslagen',currentAccount:'Ingelogd als:',notLoggedIn:'Niet ingelogd',signOut:'Uitloggen',loginError:'Inloggen mislukt',total:'Totaal',applied2:'Gesolliciteerd',interviews:'Gesprekken',offers:'Aanbiedingen',googleLogin:'Inloggen met Google',githubLogin:'Inloggen met GitHub',orEmail:'of inloggen met e-mail' },
  zh: { saved:'已保存',applied:'已申请',review:'审核中',interview:'面试',offer:'Offer',rejected:'已拒绝',today:'今天',yesterday:'昨天',daysAgo:n=>`${n}天前`,connectTitle:'连接 ApplyMate AI',connectSub:'登录后自动同步所有职位',emailLabel:'邮箱',pwLabel:'密码',loginBtn:'登录',loggingIn:'登录中…',noAccount:'还没有账号？',signupLink:'免费注册 →',openSidebar:'✨ 打开 AI 侧边栏',openDashboard:'打开 Dashboard →',currentJob:'当前职位',savedJobs:'已保存',detectingJob:'正在检测此页面的职位…',browseLinkedIn:'浏览 LinkedIn 职位 →',browseIndeed:'浏览 Indeed 职位 →',savingJob:'保存中…',saveJob:'⊕ 保存到 ApplyMate',settingsTitle:'设置',apiUrl:'后端 API 地址',saveSettings:'保存设置',savedConfirm:'✓ 已保存',currentAccount:'当前账号：',notLoggedIn:'未登录',signOut:'退出登录',loginError:'登录失败',total:'总计',applied2:'已申请',interviews:'面试',offers:'Offer',googleLogin:'使用 Google 登录',githubLogin:'使用 GitHub 登录',orEmail:'或使用邮箱登录' },
}

function getPopupLang(): PopupLang {
  try {
    const s = localStorage.getItem('applymate_lang') as PopupLang|null
    if (s && s in POPUP_LABELS) return s
  } catch {}
  return 'en'
}

const STATUS_META: Record<string, { color: string }> = {
  saved:     { color: C.subtle   },
  applied:   { color: C.primary  },
  review:    { color: C.amber    },
  interview: { color: C.teal     },
  offer:     { color: C.green    },
  rejected:  { color: C.red     },
}

function formatDate(iso: string, L: typeof POPUP_LABELS['en']): string {
  const d    = new Date(iso)
  const now  = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return L.today
  if (diff === 1) return L.yesterday
  if (diff < 7)  return L.daysAgo(diff)
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

// ── Global styles injected once ───────────────────────────────
const GLOBAL_CSS = `
  @keyframes am-spin { to { transform: rotate(360deg) } }
  * { box-sizing: border-box; }
  body { margin: 0; width: 360px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
`

// ── Main App ──────────────────────────────────────────────── v2

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [view,     setView]     = useState<'main' | 'login' | 'settings'>('main')
  const [loading,  setLoading]  = useState(true)
  const [lang,     setLang]     = useState<PopupLang>('en')

  // Sync language from web app localStorage (reads same key)
  useEffect(() => {
    setLang(getPopupLang())
    const id = setInterval(() => setLang(getPopupLang()), 2000)
    return () => clearInterval(id)
  }, [])
  const L = POPUP_LABELS[lang]

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s)
      setLoading(false)
      if (!isLoggedIn(s)) setView('login')
    })
  }, [])

  const refresh = useCallback(() => { getSettings().then(setSettings) }, [])

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {loading || !settings ? (
        <LoadingScreen />
      ) : view === 'login' ? (
        <LoginView settings={settings} L={L} onLogin={s => { setSettings(s); setView('main') }} />
      ) : view === 'settings' ? (
        <SettingsView settings={settings} L={L} refresh={refresh} onBack={() => setView('main')} />
      ) : (
        <MainView
          settings={settings}
          L={L}
          onSettings={() => setView('settings')}
          onLogout={() => { clearAuth(); setView('login') }}
        />
      )}
    </>
  )
}

// ── Loading ───────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 240, gap: 10 }}>
      <div style={{ width: 22, height: 22, border: `2.5px solid rgba(24,95,165,0.15)`, borderTopColor: C.primary, borderRadius: '50%', animation: 'am-spin 0.7s linear infinite' }} />
      <span style={{ color: C.subtle, fontSize: 11 }}>Loading…</span>
    </div>
  )
}

// ── Login View ────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  )
}

function OAuthExtBtn({ icon, label, onClick, dark }: {
  icon: React.ReactNode; label: string; onClick: () => void; dark?: boolean
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        width: '100%', padding: '9px 12px', borderRadius: 9,
        background: dark
          ? (hov ? '#1a1a1a' : '#24292e')
          : (hov ? '#fff' : 'rgba(255,255,255,0.90)'),
        border: dark ? 'none' : `1.5px solid ${C.border}`,
        color: dark ? '#fff' : C.text,
        fontSize: 12, fontWeight: 500,
        cursor: 'pointer', transition: 'all 0.15s',
        boxShadow: dark ? '0 2px 8px rgba(0,0,0,0.25)' : '0 1px 3px rgba(79,70,229,0.08)',
        fontFamily: 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

type LType = typeof POPUP_LABELS['en']

function LoginView({ settings, L, onLogin }: { settings: ExtensionSettings; L: LType; onLogin: (s: ExtensionSettings) => void }) {
  const [email,        setEmail]        = useState('')
  const [password,     setPassword]     = useState('')
  const [error,        setError]        = useState('')
  const [loading,      setLoading]      = useState(false)
  const [oauthPending, setOauthPending] = useState<'google' | 'github' | null>(null)

  // Poll chrome.storage.sync for token appearing after OAuth on dashboard tab
  useEffect(() => {
    if (!oauthPending) return
    let stopped = false
    const deadline = Date.now() + 30_000

    const poll = async () => {
      if (stopped) return
      if (Date.now() > deadline) { setOauthPending(null); return }
      const result = await chrome.storage.sync.get('settings')
      const s = result.settings ?? {}
      if (s.apiToken && s.userEmail) {
        stopped = true
        setOauthPending(null)
        onLogin({ ...settings, ...s })
        return
      }
      setTimeout(poll, 1500)
    }

    const t = setTimeout(poll, 1500)
    return () => { stopped = true; clearTimeout(t) }
  }, [oauthPending])

  function openOAuth(provider: 'google' | 'github') {
    chrome.tabs.create({ url: `${settings.apiBaseUrl}/login`, active: true })
    setOauthPending(provider)
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await apiLogin(settings, email, password)
      const next   = { ...settings, apiToken: result.token, userEmail: result.user.email, userName: result.user.name ?? '' }
      await saveSettings(next)
      onLogin(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : L.loginError)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ background: C.bg, minHeight: 320 }}>
      <Header showSettings={false} />
      <div style={{ padding: '20px 20px 24px' }}>
        {/* Brand header */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 16, margin: '0 auto 12px',
            background: `linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 800, color: '#fff',
            boxShadow: `0 6px 20px rgba(79,70,229,0.35)`,
          }}>A</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>{L.connectTitle}</div>
          <div style={{ fontSize: 12, color: C.muted }}>{L.connectSub}</div>
        </div>

        {/* OAuth pending state */}
        {oauthPending ? (
          <div style={{
            textAlign: 'center', padding: '14px 12px',
            background: 'rgba(79,70,229,0.06)', borderRadius: 10,
            border: `1px solid ${C.border}`, marginBottom: 14,
            fontSize: 12, color: C.muted,
          }}>
            <div style={{
              width: 16, height: 16,
              border: `2px solid rgba(79,70,229,0.2)`, borderTopColor: C.primary,
              borderRadius: '50%', animation: 'am-spin 0.7s linear infinite',
              margin: '0 auto 8px',
            }} />
            Waiting for login in browser tab…
            <br />
            <button
              onClick={() => setOauthPending(null)}
              style={{ marginTop: 8, fontSize: 11, color: C.subtle, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            {/* OAuth buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <OAuthExtBtn icon={<GoogleIcon />} label={L.googleLogin} onClick={() => openOAuth('google')} />
              <OAuthExtBtn icon={<GitHubIcon />} label={L.githubLogin} onClick={() => openOAuth('github')} dark />
            </div>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <span style={{ fontSize: 10, color: C.subtle, whiteSpace: 'nowrap' }}>{L.orEmail}</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>

            {/* Email / password form */}
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Input label={L.emailLabel} type="email"    value={email}    onChange={setEmail}    placeholder="you@example.com" />
              <Input label={L.pwLabel}   type="password" value={password} onChange={setPassword} placeholder="••••••••" />
              {error && (
                <div style={{ fontSize: 11, color: C.red, padding: '7px 10px', background: 'rgba(163,45,45,0.07)', borderRadius: 7, borderLeft: `3px solid ${C.red}` }}>
                  {error}
                </div>
              )}
              <div style={{ marginTop: 4 }}>
                <Btn type="submit" disabled={loading} primary>{loading ? L.loggingIn : L.loginBtn}</Btn>
              </div>
            </form>

            <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 14 }}>
              {L.noAccount}
              <a href={`${settings.apiBaseUrl}/register`} target="_blank" rel="noreferrer"
                style={{ color: C.primary, marginLeft: 4, fontWeight: 600, textDecoration: 'none' }}>
                {L.signupLink}
              </a>
            </div>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <button
            onClick={() => {
              chrome.windows.getLastFocused().then(win => {
                if (win?.id) {
                  chrome.sidePanel.open({ windowId: win.id }).catch(() => {
                    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: true })
                  })
                }
              })
            }}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.subtle, fontSize: 10, padding: '4px 8px', fontFamily: 'inherit' }}
          >
            {L.openSidebar}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main View ─────────────────────────────────────────────────

function MainView({ settings, L, onSettings, onLogout }: {
  settings: ExtensionSettings; L: LType; onSettings: () => void; onLogout: () => void
}) {
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [recentJobs, setRecentJobs] = useState<SavedJob[]>([])
  const [stats,      setStats]      = useState<DashboardStats | null>(null)
  const [saving,     setSaving]     = useState(false)
  const [savedMsg,   setSavedMsg]   = useState('')
  const [tab,        setTab]        = useState<'current' | 'recent'>('current')

  useEffect(() => {
    // Check chrome.runtime.lastError to suppress "port closed" warnings
    // These occur when the MV3 service worker sleeps before responding
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (!tabId) return
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {
        void chrome.runtime.lastError // suppress port-closed warning
        chrome.storage.local.get('currentJob', r => setCurrentJob(r.currentJob ?? null))
      })
    })
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => {
      void chrome.runtime.lastError
      setRecentJobs(r?.jobs ?? [])
    })
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, r => {
      void chrome.runtime.lastError
      setStats(r?.stats ?? null)
    })
  }, [])

  async function handleSave() {
    if (!currentJob) return
    setSaving(true)
    let res: { success?: boolean; error?: string } | null = null
    try {
      res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
    } catch {
      // Service worker may have closed the port — treat as failure
    }
    setSaving(false)
    if (res?.success) {
      setSavedMsg(`✓ Saved — ${currentJob.company}`)
      chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => {
        void chrome.runtime.lastError
        setRecentJobs(r?.jobs ?? [])
      })
    } else {
      setSavedMsg(`✗ ${res?.error ?? 'Save failed'}`)
    }
    setTimeout(() => setSavedMsg(''), 3000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
      <Header user={settings.userName || settings.userEmail} onSettings={onSettings} onLogout={onLogout} showSettings />

      {stats && <StatsBar stats={stats} L={L} />}

      {/* Tabs */}
      <div style={{ display: 'flex', background: C.bg, borderBottom: `1px solid ${C.border}`, padding: '0 10px' }}>
        {(['current', 'recent'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 12px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 12, fontWeight: tab === t ? 700 : 400,
            color: tab === t ? C.primary : C.muted,
            borderBottom: tab === t ? `2px solid ${C.primary}` : '2px solid transparent',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.12s',
            fontFamily: 'inherit',
          }}>
            {t === 'current' ? L.currentJob : L.savedJobs}
            {t === 'recent' && recentJobs.length > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 700, lineHeight: '15px', padding: '0 5px',
                background: tab === 'recent' ? C.primary : C.subtle,
                color: '#fff', borderRadius: 999, minWidth: 16, textAlign: 'center',
              }}>
                {recentJobs.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {tab === 'current' && (
          <CurrentJobPanel job={currentJob} saving={saving} savedMsg={savedMsg} onSave={handleSave} settings={settings} L={L} />
        )}
        {tab === 'recent' && (
          <RecentJobsList jobs={recentJobs} settings={settings} L={L} />
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, background: C.bgSecondary, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Btn onClick={() => {
          chrome.windows.getLastFocused().then(win => {
            if (win?.id) {
              chrome.sidePanel.open({ windowId: win.id }).catch(() => {
                chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: true })
              })
            }
          })
        }}>
          {L.openSidebar}
        </Btn>
        <Btn primary onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })}>
          {L.openDashboard}
        </Btn>
      </div>
    </div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────

function StatsBar({ stats, L }: { stats: DashboardStats; L: LType }) {
  const items = [
    { label: L.total,      value: stats.total,      color: C.primary },
    { label: L.applied2,   value: stats.applied,    color: '#818CF8' },
    { label: L.interviews, value: stats.interviews, color: C.teal    },
    { label: L.offers,     value: stats.offers,     color: C.green   },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', background: C.bgSecondary, borderBottom: `1px solid ${C.border}` }}>
      {items.map((s, i) => (
        <div key={s.label} style={{
          padding: '10px 0', textAlign: 'center',
          borderRight: i < 3 ? `1px solid ${C.border}` : 'none',
        }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
          <div style={{ fontSize: 9, color: C.subtle, marginTop: 3, letterSpacing: '0.03em', textTransform: 'uppercase', fontWeight: 600 }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Current Job Panel ─────────────────────────────────────────

function CurrentJobPanel({ job, saving, savedMsg, onSave, settings, L }: {
  job: ScrapedJob | null; saving: boolean; savedMsg: string; onSave: () => void; settings: ExtensionSettings; L: LType
}) {
  if (!job) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 16px 16px', color: C.muted }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>🔍</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>{L.detectingJob}</div>
        <div style={{ fontSize: 11, lineHeight: 1.9, color: C.muted, marginBottom: 16 }}>
          On a <strong>job list page</strong>, hover a card and click <strong>⊕</strong> to save.<br /><br />
          On a <strong>job detail page</strong>, click the <strong>Save to ApplyMate</strong> button in the top-right.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          <a href="https://www.linkedin.com/jobs/" target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: C.primary, textDecoration: 'none', fontWeight: 600 }}>
            {L.browseLinkedIn}
          </a>
          <a href="https://www.indeed.com/" target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: C.muted, textDecoration: 'none' }}>
            {L.browseIndeed}
          </a>
        </div>
      </div>
    )
  }

  const sm  = SOURCE_META[job.source] ?? SOURCE_META.unknown
  const sc  = sm.color

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Job card */}
      <div style={{
        background: C.bgCard, borderRadius: 10, padding: 13,
        border: `1px solid ${C.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${sc}12`, color: sc, border: `1.5px solid ${sc}22`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
          }}>
            {job.company.slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, marginBottom: 2, color: C.text }}>{job.title}</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{job.company}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {job.location && <span style={{ fontSize: 10, color: C.subtle }}>📍 {job.location}</span>}
              {job.salary   && <span style={{ fontSize: 10, color: C.green, fontWeight: 500 }}>💰 {job.salary}</span>}
            </div>
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, flexShrink: 0,
            background: `${sc}12`, color: sc, borderRadius: 999, padding: '3px 8px',
          }}>
            {sm.label}
          </span>
        </div>
      </div>

      {/* Action */}
      {savedMsg ? (
        <div style={{
          textAlign: 'center', fontSize: 12, padding: '10px', fontWeight: 600, borderRadius: 8,
          color: savedMsg.startsWith('✓') ? C.green : C.red,
          background: savedMsg.startsWith('✓') ? 'rgba(59,109,17,0.08)' : 'rgba(163,45,45,0.08)',
        }}>
          {savedMsg}
        </div>
      ) : (
        <Btn onClick={onSave} disabled={saving} primary>
          {saving ? L.savingJob : L.saveJob}
        </Btn>
      )}

    </div>
  )
}

// ── Recent Jobs List ──────────────────────────────────────────

function RecentJobsList({ jobs, settings, L }: { jobs: SavedJob[]; settings: ExtensionSettings; L: LType }) {
  if (!jobs.length) {
    return (
      <div style={{ textAlign: 'center', color: C.muted, padding: '36px 16px 24px' }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>No saved jobs yet</div>
        <div style={{ fontSize: 11, lineHeight: 1.8 }}>Hover a job card and click ⊕<br />or use the top-right button on a detail page</div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {jobs.map(job => {
        const meta    = STATUS_META[job.status] ?? { color: C.subtle }
        const statusLabel = ({ saved: L.saved, applied: L.applied, review: L.review, interview: L.interview, offer: L.offer, rejected: L.rejected })[job.status] ?? job.status
        const dateStr = formatDate(job.createdAt, L)
        return (
          <a
            key={job.id}
            href={`${settings.apiBaseUrl}/jobs?highlight=${job.id}`}
            target="_blank"
            rel="noreferrer"
            style={{
              background: C.bgCard, borderRadius: 9, padding: '10px 11px',
              border: `1px solid ${C.border}`, display: 'flex', gap: 9, alignItems: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)', textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            {/* Avatar */}
            <div style={{
              width: 34, height: 34, borderRadius: 8, flexShrink: 0,
              background: `${meta.color}14`, color: meta.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700,
            }}>
              {job.company.slice(0, 2).toUpperCase()}
            </div>
            {/* Text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text }}>
                {job.role}
              </div>
              <div style={{ fontSize: 10, color: C.muted, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{job.company}</span>
                <span style={{ color: C.subtle, flexShrink: 0 }}>·</span>
                <span style={{ color: C.subtle, flexShrink: 0 }}>{dateStr}</span>
              </div>
            </div>
            {/* Right */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: '2px 7px',
                color: meta.color, background: `${meta.color}14`, borderRadius: 999,
              }}>
                {statusLabel}
              </span>
              {job.score != null && (
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: job.score >= 80 ? C.green : job.score >= 60 ? C.amber : C.muted,
                }}>
                  {job.score}%
                </span>
              )}
            </div>
          </a>
        )
      })}
    </div>
  )
}

// ── Settings View ─────────────────────────────────────────────

function SettingsView({ settings, L, refresh, onBack }: {
  settings: ExtensionSettings; L: LType; refresh: () => void; onBack: () => void
}) {
  const [apiUrl, setApiUrl] = useState(settings.apiBaseUrl)
  const [saved,  setSaved]  = useState(false)

  async function handleSave() {
    await saveSettings({ apiBaseUrl: apiUrl })
    refresh()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, background: C.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onBack} style={{ background: C.bgCard, border: `1px solid ${C.border}`, cursor: 'pointer', color: C.muted, fontSize: 16, padding: '3px 8px', borderRadius: 7, lineHeight: 1.4 }}>
          ←
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{L.settingsTitle}</span>
      </div>

      <Input label={L.apiUrl} type="url" value={apiUrl} onChange={setApiUrl} placeholder="http://localhost:3000" />

      <div style={{ fontSize: 11, color: C.muted, background: 'rgba(24,95,165,0.05)', padding: '9px 11px', borderRadius: 7, lineHeight: 1.8, border: `1px solid rgba(24,95,165,0.12)` }}>
        <span style={{ color: C.text, fontWeight: 600 }}>Dev:</span>{' '}
        <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.04)', padding: '0 4px', borderRadius: 3 }}>http://localhost:3000</code><br />
        <span style={{ color: C.text, fontWeight: 600 }}>Prod:</span>{' '}
        <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.04)', padding: '0 4px', borderRadius: 3 }}>https://your-domain.com</code>
      </div>

      <Btn onClick={handleSave} primary>{saved ? L.savedConfirm : L.saveSettings}</Btn>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, color: C.muted, padding: '7px 10px', background: C.bgCard, borderRadius: 7, border: `1px solid ${C.border}` }}>
          {L.currentAccount} {settings.userEmail || L.notLoggedIn}
        </div>
        <Btn onClick={() => clearAuth().then(onBack)}>{L.signOut}</Btn>
      </div>
    </div>
  )
}

// ── Shared components ─────────────────────────────────────────

function Header({ user, onSettings, onLogout, showSettings }: {
  user?: string; onSettings?: () => void; onLogout?: () => void; showSettings: boolean
}) {
  return (
    <div style={{
      padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderBottom: `1px solid ${C.border}`,
      background: 'linear-gradient(135deg, rgba(79,70,229,0.04) 0%, rgba(124,58,237,0.03) 100%)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 8, flexShrink: 0,
          background: C.gradient,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 800, color: '#fff',
          boxShadow: '0 2px 8px rgba(79,70,229,0.35)',
        }}>A</div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, background: C.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>ApplyMate AI</div>
          {user && <div style={{ fontSize: 9, color: C.subtle, lineHeight: 1.2 }}>{user}</div>}
        </div>
      </div>
      {showSettings && (
        <div style={{ display: 'flex', gap: 2 }}>
          <IconBtn title="Settings" onClick={onSettings}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </IconBtn>
          <IconBtn title="Sign out" onClick={onLogout}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </IconBtn>
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, onClick, title }: {
  children: React.ReactNode; onClick?: () => void; title?: string
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick} title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'rgba(79,70,229,0.08)' : 'transparent',
        border: 'none', cursor: 'pointer',
        color: hovered ? C.primary : C.subtle,
        padding: '5px 6px', borderRadius: 6, lineHeight: 1,
        transition: 'all 0.12s', display: 'flex', alignItems: 'center',
      }}
    >{children}</button>
  )
}

function Input({ label, type, value, onChange, placeholder }: {
  label: string; type: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: C.muted, fontWeight: 600, letterSpacing: '0.02em' }}>{label}</span>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={()  => setFocused(false)}
        style={{
          padding: '8px 11px', fontSize: 12, outline: 'none',
          background: focused ? '#fff' : C.bgSecondary,
          color: C.text, borderRadius: 9,
          border: `1.5px solid ${focused ? 'rgba(79,70,229,0.5)' : C.border}`,
          boxShadow: focused ? '0 0 0 3px rgba(79,70,229,0.10)' : 'none',
          transition: 'all 0.15s', fontFamily: 'inherit',
        }}
      />
    </label>
  )
}

function Btn({ children, onClick, disabled, primary, type }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; type?: 'submit' | 'button'
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      type={type ?? 'button'} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: '100%', padding: '9px', borderRadius: 9,
        background: primary
          ? (disabled ? 'rgba(79,70,229,0.5)' : hov ? C.primaryHover : C.primary)
          : (hov ? 'rgba(79,70,229,0.08)' : C.bgSecondary),
        color: primary ? '#fff' : C.text,
        fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.7 : 1, transition: 'all 0.15s',
        boxShadow: primary && !disabled ? '0 3px 12px rgba(79,70,229,0.35)' : 'none',
        fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        border: primary ? 'none' : `1px solid ${C.border}`,
      }}
    >{children}</button>
  )
}
