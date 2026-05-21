'use client'

import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const C = {
  primary: '#185FA5', green: '#3B6D11', red: '#A32D2D',
  border: 'rgba(0,0,0,0.08)', text: '#0f0f10', muted: '#6b7280',
  bg: '#ffffff', bgSide: '#f0f5fb',
}

const PLAN_FEATURE_KEYS = {
  free: ['auth.register.planFree.feature1', 'auth.register.planFree.feature2', 'auth.register.planFree.feature3', 'auth.register.planFree.feature4'],
  pro: ['auth.register.planPro.feature1', 'auth.register.planPro.feature2', 'auth.register.planPro.feature3', 'auth.register.planPro.feature4', 'auth.register.planPro.feature5'],
}

export function RegisterPage() {
  const router = useRouter()

  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState<string | null>(null)
  const { t } = useI18n()
  const [step,     setStep]     = useState<'form' | 'success'>('form')

  // ── Validation ───────────────────────────────────────────────
  function validate(): string | null {
    if (!name.trim())              return t('auth.register.error.nameRequired')
    if (!email.trim())             return t('auth.register.error.emailRequired')
    if (!/\S+@\S+\.\S+/.test(email)) return t('auth.register.error.emailInvalid')
    if (password.length < 8)      return t('auth.register.error.passwordTooShort')
    if (password !== confirm)     return t('auth.register.error.passwordMismatch')
    return null
  }

  // ── Submit ───────────────────────────────────────────────────
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }
    setError('')
    setLoading('register')

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? t('auth.register.error.registerFailed')); setLoading(null); return }

      // Auto login after register
      const login = await signIn('credentials', { email, password, redirect: false })
      setLoading(null)
      if (login?.error) {
        router.push('/login')
      } else {
        setStep('success')
        setTimeout(() => { router.push('/'); router.refresh() }, 1800)
      }
    } catch {
      setLoading(null)
      setError(t('auth.register.error.networkError'))
    }
  }

  // ── OAuth ─────────────────────────────────────────────────────
  async function handleOAuth(provider: 'google' | 'github') {
    setLoading(provider)
    await signIn(provider, { callbackUrl: '/' })
  }

  // ── Success screen ────────────────────────────────────────────
  if (step === 'success') {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:C.bg }}>
        <div style={{ textAlign:'center', padding:32 }}>
          <div style={{ fontSize:56, marginBottom:16 }}>🎉</div>
          <h2 style={{ fontSize:22, fontWeight:700, marginBottom:8, color:C.text }}>{t('auth.register.success.title')}</h2>
          <p style={{ fontSize:13, color:C.muted }}>{t('auth.register.success.redirecting')}</p>
          <div style={{ marginTop:20, width:48, height:48, border:`3px solid rgba(24,95,165,0.2)`, borderTopColor:C.primary, borderRadius:'50%', animation:'spin 0.7s linear infinite', margin:'20px auto 0' }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:C.bg }}>

      {/* ── Left: Plan comparison ───────────────────────────── */}
      <div style={{
        width:400, flexShrink:0, background:C.bgSide,
        borderRight:`1px solid ${C.border}`,
        display:'flex', flexDirection:'column', padding:'48px 36px',
      }} className="auth-panel">

        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:40 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:C.primary, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:15, fontWeight:700 }}>A</div>
          <div>
            <div style={{ fontSize:15, fontWeight:600, color:C.text }}>ApplyMate AI</div>
            <div style={{ fontSize:11, color:C.muted }}>Job Copilot</div>
          </div>
        </div>

        <h2 style={{ fontSize:20, fontWeight:700, color:C.text, marginBottom:6 }}>{t('auth.register.heroTitle')}</h2>
        <p style={{ fontSize:13, color:C.muted, lineHeight:1.7, marginBottom:32 }}>{t('auth.register.heroDesc')}</p>

        {/* Plan cards */}
        {(['free', 'pro'] as const).map(plan => (
          <div key={plan} style={{
            background: plan === 'pro' ? C.primary : C.bg,
            border: `1px solid ${plan === 'pro' ? C.primary : C.border}`,
            borderRadius:10, padding:'16px 18px', marginBottom:14,
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div>
                <span style={{ fontSize:13, fontWeight:700, color: plan === 'pro' ? '#fff' : C.text }}>
                  {plan === 'free' ? t('auth.register.free') : t('auth.register.pro')}
                </span>
                {plan === 'pro' && <span style={{ fontSize:10, background:'rgba(255,255,255,0.2)', color:'#fff', borderRadius:999, padding:'2px 7px', marginLeft:8 }}>{t('auth.register.recommended')}</span>}
              </div>
              <span style={{ fontSize:14, fontWeight:700, color: plan === 'pro' ? '#fff' : C.primary }}>
                {plan === 'free' ? '¥0' : '¥39/月'}
              </span>
            </div>
            {PLAN_FEATURE_KEYS[plan].map(f => (
              <div key={f} style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:6 }}>
                <span style={{ fontSize:12, color: plan === 'pro' ? 'rgba(255,255,255,0.8)' : C.green, marginTop:1 }}>✓</span>
                <span style={{ fontSize:12, color: plan === 'pro' ? 'rgba(255,255,255,0.9)' : C.muted }}>{t(f)}</span>
              </div>
            ))}
          </div>
        ))}

        <p style={{ fontSize:11, color:C.muted, marginTop:8, lineHeight:1.6 }}>
          {t('auth.register.upgradeHint')}
        </p>
      </div>

      {/* ── Right: Register form ─────────────────────────────── */}
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'32px 24px' }}>
        <div style={{ width:'100%', maxWidth:400 }}>

          <div style={{ marginBottom:28 }}>
            <h2 style={{ fontSize:22, fontWeight:700, color:C.text, marginBottom:6 }}>{t('auth.register.createAccount')}</h2>
            <p style={{ fontSize:13, color:C.muted }}>
              {t('auth.register.hasAccount')}
              <Link href="/login" style={{ color:C.primary, marginLeft:4, textDecoration:'none', fontWeight:500 }}>{t('auth.register.loginNow')}</Link>
            </p>
          </div>

          {/* Error */}
          {error && (
            <div style={{ padding:'10px 14px', background:'rgba(163,45,45,0.08)', border:`1px solid rgba(163,45,45,0.2)`, borderRadius:8, marginBottom:18, fontSize:12, color:C.red }}>
              ⚠ {error}
            </div>
          )}

          {/* OAuth */}
          <div style={{ display:'flex', gap:10, marginBottom:22 }}>
            <OAuthBtn icon="G" label="Google" onClick={() => handleOAuth('google')} loading={loading === 'google'} />
            <OAuthBtn icon="⌥" label="GitHub" onClick={() => handleOAuth('github')} loading={loading === 'github'} dark />
          </div>

          <Divider />

          {/* Form */}
          <form onSubmit={handleRegister} style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <Field label={t("auth.register.name")}>
              <input type="text" value={name} autoComplete="name"
                placeholder="张三" onChange={e => setName(e.target.value)} className="input-base" style={inputSt} />
            </Field>
            <Field label={t("auth.register.email")}>
              <input type="email" value={email} autoComplete="email"
                placeholder="you@example.com" onChange={e => setEmail(e.target.value)} className="input-base" style={inputSt} />
            </Field>
            <Field label={t("auth.register.password")} hint={t("auth.register.passwordHint")}>
              <input type="password" value={password} autoComplete="new-password"
                placeholder="••••••••" onChange={e => setPassword(e.target.value)} className="input-base" style={inputSt} />
            </Field>
            <Field label={t("auth.register.confirmPassword")}>
              <input type="password" value={confirm} autoComplete="new-password"
                placeholder="再次输入密码" onChange={e => setConfirm(e.target.value)} className="input-base" style={inputSt} />
              {/* Password strength */}
              {password && <PasswordStrength password={password} />}
            </Field>

            <p style={{ fontSize:11, color:C.muted, lineHeight:1.6 }}>
              {t('auth.register.agreeTo')}
              <a href="#" style={{ color:C.primary, margin:'0 3px' }}>{t('auth.register.terms')}</a>和
              <a href="#" style={{ color:C.primary, marginLeft:3 }}>{t('auth.register.privacy')}</a>
            </p>

            <button type="submit" disabled={loading === 'register'} style={{
              width:'100%', padding:'11px', background:C.primary, color:'#fff', border:'none', borderRadius:8,
              fontSize:13, fontWeight:600, cursor: loading === 'register' ? 'not-allowed' : 'pointer',
              opacity: loading === 'register' ? 0.7 : 1,
              display:'flex', alignItems:'center', justifyContent:'center', gap:8,
            }}>
              {loading === 'register' && <Spinner />}
              {loading === 'register' ? t('auth.register.registering') : t('auth.register.register')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────

function OAuthBtn({ icon, label, onClick, loading, dark }: {
  icon: React.ReactNode; label: string; onClick: () => void; loading?: boolean; dark?: boolean
}) {
  return (
    <button type="button" onClick={onClick} disabled={loading} style={{
      flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8,
      padding:'9px 14px', border:`1px solid ${dark ? '#24292e' : C.border}`,
      background: dark ? '#24292e' : C.bg, color: dark ? '#fff' : C.text,
      borderRadius:8, fontSize:12, fontWeight:500, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
    }}>
      <span style={{ fontSize:14, fontWeight:700 }}>{icon}</span>{label}
    </button>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <div style={{ display:'flex', justifyContent:'space-between' }}>
        <label style={{ fontSize:12, fontWeight:500, color:C.muted }}>{label}</label>
        {hint && <span style={{ fontSize:11, color:C.muted }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Divider() {
  const { t } = useI18n()
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
      <div style={{ flex:1, height:1, background:C.border }} />
      <span style={{ fontSize:11, color:C.muted }}>{t('auth.register.orEmail')}</span>
      <div style={{ flex:1, height:1, background:C.border }} />
    </div>
  )
}

function PasswordStrength({ password }: { password: string }) {
  const { t } = useI18n()
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length

  const labels = ['', t('auth.register.pwStrength.weak'), t('auth.register.pwStrength.fair'), t('auth.register.pwStrength.good'), t('auth.register.pwStrength.strong')]
  const colors = ['', C.red, '#854F0B', C.primary, C.green]

  return (
    <div style={{ marginTop:6 }}>
      <div style={{ display:'flex', gap:4, marginBottom:4 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{
            flex:1, height:3, borderRadius:2,
            background: i <= score ? colors[score] : C.border,
            transition:'background 0.2s',
          }} />
        ))}
      </div>
      {score > 0 && <div style={{ fontSize:11, color:colors[score] }}>{labels[score]}</div>}
    </div>
  )
}

function Spinner() {
  return (
    <span style={{
      width:14, height:14, border:'2px solid rgba(255,255,255,0.3)', borderTopColor:'#fff',
      borderRadius:'50%', display:'inline-block', animation:'spin 0.7s linear infinite',
    }} />
  )
}

const inputSt: React.CSSProperties = {
  width:'100%', padding:'10px 12px', border:`1px solid ${C.border}`,
  borderRadius:8, fontSize:13, color:C.text, background:C.bg,
}
