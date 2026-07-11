'use client'

import React, { useEffect, useState } from 'react'
import { getProviders, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// ── Design tokens (identical to LoginPage) ────────────────────────────────────
const C = {
  primary:    '#4F46E5',
  text:       '#0F172A',
  muted:      '#64748B',
  subtle:     '#94A3B8',
  border:     'rgba(79,70,229,0.12)',
  red:        '#DC2626',
  green:      '#059669',
}

const FEATURES = [
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
    title: '智能职位匹配',
    desc:  'AI 实时评估每个职位与你简历的匹配程度',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    title: '简历自动定制',
    desc:  '针对每个 JD 一键优化简历关键词与格式',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
    title: 'AI Agent 自动投递',
    desc:  '设置规则后，Agent 24h 自动发现并申请职位',
  },
  {
    icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    title: 'Gmail 一站跟踪',
    desc:  '自动识别 HR 回复，汇总申请进度',
  },
]

// ── Helper components ─────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
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

function PasswordStrength({ password }: { password: string }) {
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length
  const labels = ['', '弱', '一般', '较强', '强']
  const colors = ['', C.red, '#D97706', C.primary, C.green]
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: i <= score ? colors[score] : C.border,
            transition: 'background 0.2s',
          }} />
        ))}
      </div>
      {score > 0 && <div style={{ fontSize: 11, color: colors[score] }}>{labels[score]}</div>}
    </div>
  )
}

export function RegisterPage() {
  const router = useRouter()
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState<string | null>(null)
  const [focused,  setFocused]  = useState<string | null>(null)
  const [step,     setStep]     = useState<'form' | 'success'>('form')

  type Providers = Awaited<ReturnType<typeof getProviders>>
  const [oauthProviders, setOauthProviders] = useState<Providers>(null)
  useEffect(() => { getProviders().then(setOauthProviders) }, [])
  const providersLoaded = oauthProviders !== null
  const googleAvailable = Boolean(oauthProviders?.google)

  function validate(): string | null {
    if (!name.trim())                  return '请填写姓名'
    if (!email.trim())                 return '请填写邮箱'
    if (!/\S+@\S+\.\S+/.test(email))  return '邮箱格式不正确'
    if (password.length < 8)          return '密码至少 8 位'
    if (password !== confirm)         return '两次密码输入不一致'
    return null
  }

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
      const data = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) {
        setError(data.error ?? (res.status >= 500 ? '服务器配置错误，请检查数据库连接' : '注册失败'))
        setLoading(null)
        return
      }
      const login = await signIn('credentials', { email, password, redirect: false })
      setLoading(null)
      if (login?.error) { router.push('/login') }
      else { setStep('success'); setTimeout(() => { router.push('/'); router.refresh() }, 1800) }
    } catch {
      setLoading(null)
      setError('网络错误，请重试')
    }
  }

  async function handleGoogle() {
    if (!googleAvailable) {
      setError('Google 登录尚未配置，请先使用邮箱注册或登录。')
      return
    }
    setLoading('google')
    await signIn('google', { callbackUrl: '/' })
  }

  // ── Success screen ────────────────────────────────────────────────────────────
  if (step === 'success') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 35%, #EDE9FE 65%, #F0F9FF 100%)' }}>
        <div style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, color: C.text }}>账号创建成功！</h2>
          <p style={{ fontSize: 13, color: C.muted }}>正在跳转到你的 Dashboard…</p>
          <div style={{ marginTop: 20, width: 28, height: 28, border: `3px solid rgba(79,70,229,0.20)`, borderTopColor: C.primary, borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '20px auto 0' }} />
        </div>
      </div>
    )
  }

  const inputStyle = (name: string): React.CSSProperties => ({
    width: '100%', padding: '10px 13px',
    background: focused === name ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.65)',
    border: focused === name ? '1.5px solid rgba(79,70,229,0.55)' : '1px solid rgba(79,70,229,0.18)',
    borderRadius: 9, fontSize: 13, color: C.text, outline: 'none',
    boxShadow: focused === name ? '0 0 0 3px rgba(79,70,229,0.12)' : '0 1px 2px rgba(0,0,0,0.04)',
    transition: 'all 0.18s', backdropFilter: 'blur(8px)',
    boxSizing: 'border-box',
  })

  return (
    <div style={{
      display: 'flex', minHeight: '100vh',
      background: 'linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 35%, #EDE9FE 65%, #F0F9FF 100%)',
      backgroundAttachment: 'fixed', position: 'relative', overflow: 'hidden',
    }}>
      {/* Decorative blobs */}
      <div style={{ position: 'absolute', top: '-15%', left: '-10%', width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, rgba(79,70,229,0.18) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(40px)' }} />
      <div style={{ position: 'absolute', bottom: '-20%', right: '-5%', width: 700, height: 700, borderRadius: '50%', background: 'radial-gradient(circle, rgba(124,58,237,0.14) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(50px)' }} />

      {/* ── Left brand panel ──────────────────────────────────── */}
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
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 52, textDecoration: 'none' }}>
          <div style={{
            width: 38, height: 38, borderRadius: 11,
            background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 16, fontWeight: 700,
            boxShadow: '0 4px 14px rgba(79,70,229,0.40), inset 0 1px 0 rgba(255,255,255,0.25)',
          }}>A</div>
          <div>
            <div style={{
              fontSize: 16, fontWeight: 700,
              background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>ApplyMate AI</div>
            <div style={{ fontSize: 11, color: C.subtle }}>Job Copilot · Europe</div>
          </div>
        </Link>

        {/* Hero text */}
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1.25, marginBottom: 14, letterSpacing: '-0.02em' }}>
            开始你的<br />AI 求职之旅
          </h1>
          <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.75 }}>
            免费注册，立即使用 ApplyMate AI——从发现职位到投递简历，全程 AI 驱动。
          </p>
        </div>

        {/* Features */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: 'linear-gradient(135deg, rgba(79,70,229,0.09) 0%, rgba(124,58,237,0.07) 100%)',
                border: '1px solid rgba(79,70,229,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: C.primary,
              }}>{f.icon}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 3 }}>{f.title}</div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.65 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Testimonial */}
        <div style={{ marginTop: 'auto', paddingTop: 28, borderTop: `1px solid ${C.border}` }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(79,70,229,0.06) 0%, rgba(124,58,237,0.04) 100%)',
            border: '1px solid rgba(79,70,229,0.12)', borderRadius: 12, padding: '16px 18px',
          }}>
            <div style={{ fontSize: 24, lineHeight: 1, color: C.primary, opacity: 0.28, fontFamily: 'Georgia,serif', marginBottom: 4, userSelect: 'none' }}>&ldquo;</div>
            <p style={{ fontSize: 12, color: C.text, lineHeight: 1.80, margin: '0 0 12px' }}>
              用 ApplyMate 两周内拿到了 Adyen、Booking.com 的面试，省了我大量整理简历的时间。
            </p>
            <div style={{ fontSize: 11, color: C.muted }}>
              — <span style={{ fontWeight: 600, color: C.text }}>Zhang Li</span>，Backend Engineer · Amsterdam
            </div>
          </div>
        </div>
      </div>

      {/* ── Right form panel ──────────────────────────────────── */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', position: 'relative', zIndex: 1,
      }}>
        <div style={{
          width: '100%', maxWidth: 420,
          background: 'rgba(255,255,255,0.80)',
          backdropFilter: 'blur(24px) saturate(200%)',
          WebkitBackdropFilter: 'blur(24px) saturate(200%)',
          border: '1px solid rgba(255,255,255,0.92)',
          borderRadius: 20, padding: '36px 32px',
          boxShadow: '0 8px 40px rgba(79,70,229,0.12), 0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.95)',
        }}>
          {/* Header */}
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 6, letterSpacing: '-0.02em' }}>创建你的账号 👋</h2>
            <p style={{ fontSize: 13, color: C.muted }}>
              已有账号？{' '}
              <Link href="/login" style={{
                color: C.primary, textDecoration: 'none', fontWeight: 600,
                background: 'linear-gradient(135deg, #4F46E5, #7C3AED)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>立即登录</Link>
            </p>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              padding: '10px 14px', background: 'rgba(220,38,38,0.08)',
              border: '1px solid rgba(220,38,38,0.22)', borderRadius: 10, marginBottom: 20,
              fontSize: 12, color: C.red, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          {providersLoaded ? (
            <>
              {/* Google OAuth */}
              <div style={{ marginBottom: 22 }}>
                <button
                  type="button"
                  onClick={handleGoogle}
                  disabled={loading === 'google'}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                    width: '100%', padding: '11px 16px',
                    background: loading === 'google' ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.90)',
                    border: '1px solid rgba(79,70,229,0.18)',
                    borderRadius: 10, fontSize: 13, fontWeight: 500,
                    color: C.text, cursor: loading === 'google' ? 'not-allowed' : 'pointer',
                    opacity: loading === 'google' ? 0.7 : 1,
                    transition: 'all 0.15s',
                    boxShadow: '0 1px 4px rgba(79,70,229,0.08)',
                  }}
                >
                  {loading === 'google' ? <Spinner /> : <GoogleIcon />}
                  {googleAvailable ? '使用 Google 登录' : 'Google 登录未配置'}
                </button>
              </div>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
                <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
                <span style={{ fontSize: 11, color: C.subtle, whiteSpace: 'nowrap' }}>或填写邮箱注册</span>
                <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
              </div>
            </>
          ) : (
            <div style={{ marginBottom: 22 }}>
              <div style={{ height: 46, borderRadius: 10, background: 'rgba(79,70,229,0.06)' }} />
            </div>
          )}

          {/* Register form */}
          <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
            {/* Name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>姓名</label>
              <input
                type="text" value={name} autoComplete="name" placeholder="张三"
                onFocus={() => setFocused('name')} onBlur={() => setFocused(null)}
                onChange={e => setName(e.target.value)}
                style={inputStyle('name')}
              />
            </div>
            {/* Email */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>邮箱</label>
              <input
                type="email" value={email} autoComplete="email" placeholder="you@example.com"
                onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
                onChange={e => setEmail(e.target.value)}
                style={inputStyle('email')}
              />
            </div>
            {/* Password */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>密码</label>
                <span style={{ fontSize: 11, color: C.subtle }}>至少 8 位</span>
              </div>
              <input
                type="password" value={password} autoComplete="new-password" placeholder="••••••••"
                onFocus={() => setFocused('password')} onBlur={() => setFocused(null)}
                onChange={e => setPassword(e.target.value)}
                style={inputStyle('password')}
              />
              {password && <PasswordStrength password={password} />}
            </div>
            {/* Confirm */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>确认密码</label>
              <input
                type="password" value={confirm} autoComplete="new-password" placeholder="再次输入密码"
                onFocus={() => setFocused('confirm')} onBlur={() => setFocused(null)}
                onChange={e => setConfirm(e.target.value)}
                style={inputStyle('confirm')}
              />
            </div>

            {/* Terms */}
            <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, margin: 0 }}>
              注册即表示同意我们的{' '}
              <a href="#" style={{ color: C.primary, textDecoration: 'none', fontWeight: 500 }}>服务条款</a>
              {' '}和{' '}
              <a href="#" style={{ color: C.primary, textDecoration: 'none', fontWeight: 500 }}>隐私政策</a>
            </p>

            {/* Submit */}
            <button
              type="submit" disabled={!!loading}
              style={{
                width: '100%', padding: '12px', marginTop: 4, border: 'none',
                background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
                color: '#fff', borderRadius: 10, fontSize: 13, fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.85 : 1,
                transition: 'all 0.18s cubic-bezier(.4,0,.2,1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                boxShadow: '0 4px 14px rgba(79,70,229,0.38), inset 0 1px 0 rgba(255,255,255,0.20)',
                letterSpacing: '0.01em',
              }}
            >
              {loading === 'register' && <Spinner />}
              {loading === 'register' ? '注册中…' : '免费注册'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
