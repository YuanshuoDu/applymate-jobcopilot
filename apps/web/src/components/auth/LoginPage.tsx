'use client'

import React, { useState, useEffect } from 'react'
import { signIn, signOut, getProviders } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { authLink, safeCallbackUrl } from '@/lib/auth-callback'
import { credentialsSignInMessage, signInUrlErrorMessage } from '@/lib/auth-errors'
import { useI18n } from '@/lib/i18n'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  primary:    '#4F46E5',
  text:       '#0F172A',
  muted:      '#64748B',
  subtle:     '#94A3B8',
  border:     'rgba(79,70,229,0.12)',
  red:        '#DC2626',
  success:    '#15803D',
}

const FEATURES = [
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
    title: 'Smart Job Matching',
    desc:  'AI evaluates how well each job matches your resume',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    title: 'Resume Tailoring',
    desc:  'Optimize resume keywords and formatting for every job description',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
    title: 'AI Agent Auto-Apply',
    desc:  'Set your rules and let the Agent discover and apply to jobs 24/7',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    title: 'Gmail Tracking',
    desc:  'Automatically identify recruiter replies and track your applications',
  },
]

// ── Helper components ─────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
  )
}

function EyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {visible ? <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></> : <><path d="m3 3 18 18" /><path d="M10.6 6.2A10.7 10.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17.4 17.4 0 0 1-3 3.7M6.2 6.3C3.8 8 2.5 12 2.5 12a17.4 17.4 0 0 0 3.7 4.2A10.7 10.7 0 0 0 12 18c.8 0 1.6-.1 2.3-.3" /></>}
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  )
}

function OAuthBtn({ icon, label, onClick, loading, dark }: {
  icon: React.ReactNode; label: string; onClick: () => void; loading?: boolean; dark?: boolean
}) {
  const [hov, setHov] = React.useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        width: '100%', padding: '11px 16px',
        background: dark
          ? (hov ? '#1a1a1a' : '#24292e')
          : (hov ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.90)'),
        border: dark ? 'none' : '1px solid rgba(79,70,229,0.18)',
        borderRadius: 10, fontSize: 13, fontWeight: 500,
        color: dark ? '#fff' : '#0F172A',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1,
        transition: 'all 0.15s',
        boxShadow: dark
          ? '0 2px 8px rgba(0,0,0,0.25)'
          : '0 1px 4px rgba(79,70,229,0.08)',
      }}
    >
      {loading ? <Spinner /> : icon}
      {label}
    </button>
  )
}

export { safeCallbackUrl } from '@/lib/auth-callback'

export function LoginPage({ switchAccount = false, adminLogin = false }: { switchAccount?: boolean; adminLogin?: boolean }) {
  const { t } = useI18n()
  const router       = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl  = safeCallbackUrl(searchParams.get('callbackUrl'))
  const urlError     = searchParams.get('error')
  const passwordChanged = searchParams.get('passwordChanged') === '1'

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [error,    setError]    = useState(urlError ? signInUrlErrorMessage(urlError) : '')
  const [loading,  setLoading]  = useState<string | null>(null)
  const [focused,  setFocused]  = useState<string | null>(null)

  type Providers = Awaited<ReturnType<typeof getProviders>>
  const [oauthProviders, setOauthProviders] = useState<Providers>(null)
  useEffect(() => {
    if (adminLogin) return
    getProviders().then(setOauthProviders)
  }, [adminLogin])
  const providersLoaded = oauthProviders !== null
  const googleAvailable = Boolean(oauthProviders?.google)

  function releasePasswordVisibility() {
    setPasswordVisible(false)
  }

  function handlePasswordPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    setPasswordVisible(true)
  }

  function handlePasswordKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      setPasswordVisible(true)
    }
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError(t('auth.login.error.emailPasswordRequired')); return }
    setError('')
    setLoading('credentials')
    if (switchAccount) await signOut({ redirect: false })
    const result = await signIn('credentials', { email, password, redirect: false })
    setLoading(null)
    if (!result?.ok || result.error) { setError(credentialsSignInMessage(result?.error)) }
    else { router.push(callbackUrl); router.refresh() }
  }

  async function handleOAuth(provider: 'google' | 'github') {
    setLoading(provider)
    if (switchAccount) await signOut({ redirect: false })
    await signIn(provider, { callbackUrl })
  }

  function handleUnavailableGoogle() {
    setError(t('auth.login.error.googleUnavailable'))
  }

  return (
    <div className="auth-layout" style={{
      display: 'flex', minHeight: '100vh',
      backgroundImage: 'linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 35%, #EDE9FE 65%, #F0F9FF 100%)',
      backgroundAttachment: 'fixed', position: 'relative', overflowX: 'hidden',
    }}>
      {/* Decorative blobs */}
      <div style={{ position:'absolute', top:'-15%', left:'-10%', width:600, height:600, borderRadius:'50%', background:'radial-gradient(circle, rgba(79,70,229,0.10) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(40px)' }} />
      <div style={{ position:'absolute', bottom:'-20%', right:'-5%', width:700, height:700, borderRadius:'50%', background:'radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(50px)' }} />
      <div style={{ position:'absolute', top:'40%', left:'35%', width:400, height:400, borderRadius:'50%', background:'radial-gradient(circle, rgba(2,132,199,0.04) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(30px)' }} />

      {/* ── Left brand panel ────────────────────────────────── */}
      <div className="auth-panel" style={{
        width: 460, flexShrink: 0,
        background: 'rgba(255,255,255,0.76)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        borderRight: '1px solid rgba(255,255,255,0.85)',
        display: 'flex', flexDirection: 'column', padding: '48px 44px',
        position: 'relative', zIndex: 1,
      }}>
        {/* Logo — clickable */}
        <Link href="/" style={{ display:'flex', alignItems:'center', gap:12, marginBottom:52, textDecoration:'none' }}>
          <div style={{
            width:38, height:38, borderRadius:11,
            background:'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'#fff', fontSize:16, fontWeight:700,
            boxShadow:'0 4px 14px rgba(79,70,229,0.40), inset 0 1px 0 rgba(255,255,255,0.25)',
          }}>A</div>
          <div>
            <div style={{
              fontSize:16, fontWeight:700,
              background:'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
            }}>ApplyMate AI</div>
            <div style={{ fontSize:11, color:C.subtle }}>{t('auth.brandTagline')}</div>
          </div>
        </Link>

        {/* Hero text */}
        <div className="auth-brand-hero" style={{ marginBottom:40 }}>
          <h1 style={{ fontSize:28, fontWeight:800, color:C.text, lineHeight:1.25, marginBottom:14, letterSpacing:'-0.02em' }}>
            {t('auth.login.heroTitle')}
          </h1>
          <p style={{ fontSize:13, color:C.muted, lineHeight:1.75 }}>
            {t('auth.login.heroDesc')}
          </p>
        </div>

        {/* Features */}
        <div className="auth-features" style={{ display:'flex', flexDirection:'column', gap:22 }}>
          {FEATURES.map((f, index) => (
            <div key={f.title} style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
              <div style={{
                width:36, height:36, borderRadius:10, flexShrink:0,
                background:'linear-gradient(135deg, rgba(79,70,229,0.09) 0%, rgba(124,58,237,0.07) 100%)',
                border:'1px solid rgba(79,70,229,0.15)',
                display:'flex', alignItems:'center', justifyContent:'center',
                color:C.primary,
              }}>{f.icon}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:3 }}>{t(`auth.login.feature${index + 1}.title`)}</div>
                <div style={{ fontSize:11, color:C.muted, lineHeight:1.65 }}>{t(`auth.login.feature${index + 1}.desc`)}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Testimonial */}
        <div className="auth-testimonial" style={{ marginTop:'auto', paddingTop:28, borderTop:`1px solid ${C.border}` }}>
          <div style={{
            background:'linear-gradient(135deg, rgba(79,70,229,0.06) 0%, rgba(124,58,237,0.04) 100%)',
            border:'1px solid rgba(79,70,229,0.12)', borderRadius:12, padding:'16px 18px',
          }}>
            <div style={{ fontSize:24, lineHeight:1, color:C.primary, opacity:0.28, fontFamily:'Georgia,serif', marginBottom:4, userSelect:'none' }}>&ldquo;</div>
            <p style={{ fontSize:12, color:C.text, lineHeight:1.80, margin:'0 0 12px' }}>
              {t('auth.login.testimonial')}
            </p>
            <div style={{ fontSize:11, color:C.muted }}>
              — <span style={{ fontWeight:600, color:C.text }}>{t('auth.testimonialAuthor')}</span>, {t('auth.testimonialRole')}
            </div>
          </div>
        </div>
      </div>

      {/* ── Right form panel ────────────────────────────────── */}
      <div className="auth-form-area" style={{
        flex:1, display:'flex', alignItems:'center', justifyContent:'center',
        padding:'32px 24px', position:'relative', zIndex:1,
      }}>
        <div className="auth-form-card" style={{
          width:'100%', maxWidth:420,
          background:'rgba(255,255,255,0.80)',
          backdropFilter:'blur(24px) saturate(200%)',
          WebkitBackdropFilter:'blur(24px) saturate(200%)',
          border:'1px solid rgba(255,255,255,0.92)',
          borderRadius:20, padding:'36px 32px',
          boxShadow:'0 8px 40px rgba(79,70,229,0.12), 0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.95)',
        }}>
          {/* Header */}
          <div style={{ marginBottom:28 }}>
            <h2 style={{ fontSize:22, fontWeight:800, color:C.text, marginBottom:6, letterSpacing:'-0.02em' }}>{t('auth.login.welcomeBack')}</h2>
            {adminLogin ? (
              <p style={{ fontSize:13, color:C.muted }}>
                {t('auth.login.adminOnly')}
              </p>
            ) : (
              <p style={{ fontSize:13, color:C.muted }}>
                {t('auth.login.noAccount')}{' '}
                <Link href={authLink('/register', callbackUrl)} style={{
                  color:C.primary, textDecoration:'none', fontWeight:600,
                  background:'linear-gradient(135deg, #4F46E5, #7C3AED)',
                  WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
                }}>{t('auth.login.signUp')}</Link>
              </p>
            )}
          </div>

          {passwordChanged && (
            <div style={{
              padding: '10px 14px', background: 'rgba(21,128,61,0.08)',
              border: '1px solid rgba(21,128,61,0.22)', borderRadius: 10, marginBottom: 20,
              fontSize: 12, color: C.success,
            }}>
              {t('auth.login.passwordUpdated')}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              padding:'10px 14px', background:'rgba(220,38,38,0.08)',
              border:'1px solid rgba(220,38,38,0.22)', borderRadius:10, marginBottom:20,
              fontSize:12, color:C.red, display:'flex', alignItems:'center', gap:8,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          {/* OAuth */}
          {!adminLogin && (providersLoaded ? (
            <>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:22 }}>
                <OAuthBtn
                  icon={<GoogleIcon />}
                  label={googleAvailable ? t('auth.login.googleLogin') : t('auth.login.googleUnavailableShort')}
                  onClick={() => googleAvailable ? handleOAuth('google') : handleUnavailableGoogle()}
                  loading={loading === 'google'}
                />
                {oauthProviders.github && <OAuthBtn icon={<GitHubIcon />} label={t('auth.login.githubLogin')} onClick={() => handleOAuth('github')} loading={loading === 'github'} dark />}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:22 }}>
                <div style={{ flex:1, height:1, background:'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
                <span style={{ fontSize:11, color:C.subtle, whiteSpace:'nowrap' }}>{t('auth.login.orEmail')}</span>
                <div style={{ flex:1, height:1, background:'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
              </div>
            </>
          ) : (
            <div style={{ marginBottom:22 }}>
              <div style={{ height:46, borderRadius:10, marginBottom:10, background:'rgba(79,70,229,0.06)' }} />
              <div style={{ height:46, borderRadius:10, background:'rgba(79,70,229,0.04)' }} />
            </div>
          ))}

          {/* Credentials form */}
          <form onSubmit={handleCredentials} style={{ display:'flex', flexDirection:'column', gap:15 }}>
            {/* Email */}
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <label htmlFor="login-email" style={{ fontSize:12, fontWeight:500, color:C.muted }}>{t('auth.login.email')}</label>
              <input
                id="login-email" name="email" type="email" value={email} autoComplete="email" placeholder={t('auth.emailPlaceholder')}
                onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
                onChange={e => setEmail(e.target.value)}
                style={{
                  width:'100%', padding:'10px 13px',
                  background: focused === 'email' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.65)',
                  border: focused === 'email' ? '1.5px solid rgba(79,70,229,0.55)' : '1px solid rgba(79,70,229,0.18)',
                  borderRadius:9, fontSize:13, color:C.text, outline:'none',
                  boxShadow: focused === 'email' ? '0 0 0 3px rgba(79,70,229,0.12)' : '0 1px 2px rgba(0,0,0,0.04)',
                  transition:'all 0.18s', backdropFilter:'blur(8px)',
                }}
              />
            </div>
            {/* Password */}
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <label htmlFor="login-password" style={{ fontSize:12, fontWeight:500, color:C.muted }}>{t('auth.login.password')}</label>
                {!adminLogin && <Link href="/forgot-password" style={{ fontSize:11, color:C.primary, textDecoration:'none', fontWeight:500 }}>{t('auth.login.forgotPassword')}</Link>}
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-password" name="password" type={passwordVisible ? 'text' : 'password'} value={password} autoComplete="current-password" placeholder="••••••••"
                  onFocus={() => setFocused('password')} onBlur={() => setFocused(null)}
                  onChange={e => setPassword(e.target.value)}
                  style={{
                    width:'100%', padding:'10px 40px 10px 13px', boxSizing:'border-box',
                    background: focused === 'password' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.65)',
                    border: focused === 'password' ? '1.5px solid rgba(79,70,229,0.55)' : '1px solid rgba(79,70,229,0.18)',
                    borderRadius:9, fontSize:13, color:C.text, outline:'none',
                    boxShadow: focused === 'password' ? '0 0 0 3px rgba(79,70,229,0.12)' : '0 1px 2px rgba(0,0,0,0.04)',
                    transition:'all 0.18s', backdropFilter:'blur(8px)',
                  }}
                />
                <button
                  type="button"
                  aria-label={passwordVisible ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
                  title={t('auth.login.showPassword')}
                  aria-pressed={passwordVisible}
                  onPointerDown={handlePasswordPointerDown}
                  onPointerUp={releasePasswordVisibility}
                  onPointerCancel={releasePasswordVisibility}
                  onPointerLeave={releasePasswordVisibility}
                  onKeyDown={handlePasswordKeyDown}
                  onKeyUp={releasePasswordVisibility}
                  onBlur={releasePasswordVisibility}
                  style={{
                    position:'absolute', top:'50%', right:6, transform:'translateY(-50%)',
                    width:30, height:30, padding:0, border:0, borderRadius:7,
                    background:'transparent', color:C.muted, cursor:'pointer',
                    display:'flex', alignItems:'center', justifyContent:'center',
                  }}
                >
                  <EyeIcon visible={passwordVisible} />
                </button>
              </div>
            </div>
            {/* Submit */}
            <button
              type="submit" disabled={!!loading}
              style={{
                width:'100%', padding:'12px', marginTop:4, border:'none',
                background:'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
                color:'#fff', borderRadius:10, fontSize:13, fontWeight:600,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.85 : 1,
                transition:'all 0.18s cubic-bezier(.4,0,.2,1)',
                display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                boxShadow:'0 4px 14px rgba(79,70,229,0.38), inset 0 1px 0 rgba(255,255,255,0.20)',
                letterSpacing:'0.01em',
              }}
            >
              {loading === 'credentials' && <Spinner />}
              {loading === 'credentials' ? t('auth.login.loggingIn') : t('auth.login.login')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
