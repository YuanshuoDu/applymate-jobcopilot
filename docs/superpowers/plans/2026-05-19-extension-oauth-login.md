# Extension OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Sign in with Google" and "Sign in with GitHub" buttons to the Chrome extension popup login screen, reusing the existing dashboard OAuth flow and JWT bridge.

**Architecture:** Chrome extension popups cannot redirect for OAuth; instead, clicking an OAuth button opens the dashboard `/login` page in a new tab. The already-existing `syncFromDashboard()` content script detects the `<meta name="applymate:user">` tag after OAuth completes and writes the JWT to `chrome.storage.sync`. The popup polls `chrome.storage.sync` every 1.5 s and auto-logs in when the token appears.

**Tech Stack:** React (no framework — inline styles), Chrome Extension Manifest V3, TypeScript, existing `chrome.storage.sync` / `chrome.tabs` APIs.

---

## File Map

| File | Change |
|------|--------|
| `jobcopilot/apps/extension/src/popup/App.tsx` | Only file touched. Add OAuth buttons + i18n keys + polling logic. |

No backend changes needed — `/api/auth/me/extension-token` and `syncFromDashboard` already exist and work.

---

### Task 1: Add i18n keys for OAuth strings

**Files:**
- Modify: `jobcopilot/apps/extension/src/popup/App.tsx` — `POPUP_LABELS` constant (lines 41–57)

- [ ] **Step 1: Add 3 new keys to the label type and all 6 language objects**

In `App.tsx`, find the `POPUP_LABELS` type definition (the type for each language object) and add three new keys. Then add the translated values to every language entry.

Replace the existing type block and all 6 language entries. The diff is additive — only new keys are shown below; keep all existing keys untouched.

```typescript
// ── Updated type (add 3 keys after "loginError") ──────────────
type PopupLang = 'en'|'de'|'fr'|'es'|'nl'|'zh'
const POPUP_LABELS: Record<PopupLang, {
  // ... all existing keys ...
  loginError:string
  // NEW ↓
  googleLogin:string; githubLogin:string; orEmail:string
}> = {
  en: {
    // ... all existing en values ...
    googleLogin:'Sign in with Google', githubLogin:'Sign in with GitHub', orEmail:'or sign in with email',
  },
  de: {
    // ... all existing de values ...
    googleLogin:'Mit Google anmelden', githubLogin:'Mit GitHub anmelden', orEmail:'oder mit E-Mail anmelden',
  },
  fr: {
    // ... all existing fr values ...
    googleLogin:'Se connecter avec Google', githubLogin:'Se connecter avec GitHub', orEmail:'ou se connecter par e-mail',
  },
  es: {
    // ... all existing es values ...
    googleLogin:'Iniciar sesión con Google', githubLogin:'Iniciar sesión con GitHub', orEmail:'o iniciar sesión con correo',
  },
  nl: {
    // ... all existing nl values ...
    googleLogin:'Inloggen met Google', githubLogin:'Inloggen met GitHub', orEmail:'of inloggen met e-mail',
  },
  zh: {
    // ... all existing zh values ...
    googleLogin:'使用 Google 登录', githubLogin:'使用 GitHub 登录', orEmail:'或使用邮箱登录',
  },
}
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```powershell
cd "F:\ApplyMate\ApplyMate AI\jobcopilot"
pnpm --filter extension build 2>&1 | Select-String -Pattern "error TS"
```

Expected: no `error TS` lines.

---

### Task 2: Add OAuth buttons + polling to LoginView

**Files:**
- Modify: `jobcopilot/apps/extension/src/popup/App.tsx` — `LoginView` function (lines 155–233)

- [ ] **Step 1: Add GoogleIcon and GitHubIcon SVG components before LoginView**

Insert these two components immediately above the `// ── Login View` comment:

```typescript
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
```

- [ ] **Step 2: Rewrite LoginView with OAuth buttons + polling**

Replace the entire `LoginView` function with the version below. Key changes:
- `oauthPending` state: tracks which provider tab was opened (`'google' | 'github' | null`)
- `openOAuth(provider)`: opens `${settings.apiBaseUrl}/login` in a new tab (the dashboard `/login` page already has Google + GitHub buttons)
- `useEffect` polling: while `oauthPending` is set, polls `chrome.storage.sync` every 1.5 s; when a non-empty `apiToken` appears it calls `onLogin` with the merged settings; 30 s hard timeout stops the poll
- UI: Google button (white/bordered), GitHub button (dark), separator, then existing email/password form

```typescript
function LoginView({ settings, L, onLogin }: { settings: ExtensionSettings; L: LType; onLogin: (s: ExtensionSettings) => void }) {
  const [email,        setEmail]        = useState('')
  const [password,     setPassword]     = useState('')
  const [error,        setError]        = useState('')
  const [loading,      setLoading]      = useState(false)
  const [oauthPending, setOauthPending] = useState<'google' | 'github' | null>(null)

  // Poll chrome.storage.sync for a token appearing after OAuth on dashboard
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
        {/* Brand */}
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

        {/* OAuth buttons */}
        {oauthPending ? (
          <div style={{
            textAlign: 'center', padding: '14px 12px',
            background: 'rgba(79,70,229,0.06)', borderRadius: 10,
            border: `1px solid ${C.border}`, marginBottom: 14,
            fontSize: 12, color: C.muted,
          }}>
            <div style={{ width: 16, height: 16, border: `2px solid rgba(79,70,229,0.2)`, borderTopColor: C.primary, borderRadius: '50%', animation: 'am-spin 0.7s linear infinite', margin: '0 auto 8px' }} />
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {/* Google */}
            <OAuthExtBtn icon={<GoogleIcon />} label={L.googleLogin} onClick={() => openOAuth('google')} />
            {/* GitHub */}
            <OAuthExtBtn icon={<GitHubIcon />} label={L.githubLogin} onClick={() => openOAuth('github')} dark />
          </div>
        )}

        {/* Divider */}
        {!oauthPending && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, height: 1, background: C.border }} />
            <span style={{ fontSize: 10, color: C.subtle, whiteSpace: 'nowrap' }}>{L.orEmail}</span>
            <div style={{ flex: 1, height: 1, background: C.border }} />
          </div>
        )}

        {/* Email / password form */}
        {!oauthPending && (
          <>
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
```

- [ ] **Step 3: Add the OAuthExtBtn helper component**

Insert this small component right before `LoginView` (below the icon components added in Step 1):

```typescript
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
```

- [ ] **Step 4: Build to verify no TypeScript errors**

```powershell
cd "F:\ApplyMate\ApplyMate AI\jobcopilot"
pnpm --filter extension build 2>&1 | Select-String -Pattern "error TS"
```

Expected: no `error TS` lines.

- [ ] **Step 5: Commit**

```powershell
cd "F:\ApplyMate\ApplyMate AI\jobcopilot"
git add apps/extension/src/popup/App.tsx
git commit -m "feat(extension): add Google/GitHub OAuth login buttons to popup"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Load the unpacked extension**

In Chrome, go to `chrome://extensions` → Enable "Developer mode" → "Load unpacked" → select `jobcopilot/apps/extension/dist` (or wherever the build outputs to).

- [ ] **Step 2: Open the popup and verify OAuth buttons appear**

Click the extension icon. The login screen should show:
- "Sign in with Google" button (white, bordered, Google logo)
- "Sign in with GitHub" button (dark, GitHub logo)
- Divider "or sign in with email"
- Email + Password form as before

- [ ] **Step 3: Test the Google flow**

1. Click "Sign in with Google" — a new tab opens to the dashboard `/login` page
2. The popup shows "Waiting for login in browser tab…" spinner
3. Complete Google OAuth in the new tab
4. Within ~3 s the extension popup should automatically navigate to the main job-tracking view (token was synced by `syncFromDashboard`)

- [ ] **Step 4: Test the cancel flow**

Click "Sign in with Google" then click "Cancel" in the popup — popup returns to showing the OAuth buttons immediately.

- [ ] **Step 5: Verify email/password still works**

Enter valid credentials in the email/password form → login succeeds as before.
