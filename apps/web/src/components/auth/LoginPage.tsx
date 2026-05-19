'use client'

import React, { useState, useEffect } from 'react'
import { signIn, getProviders } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  primary:    '#4F46E5',
  text:       '#0F172A',
  muted:      '#64748B',
  subtle:     '#94A3B8',
  border:     'rgba(79,70,229,0.12)',
  red:        '#DC2626',
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

function mapOAuthError(err: string): string {
  const MAP: Record<string, string> = {
    OAuthAccountNotLinked: '该邮箱已用其他方式注册，请使用原登录方式',
    OAuthCallbackError:    'OAuth 登录失败，请重试',
    AccessDenied:          '登录被拒绝',
    Verification:          '验证链接已过期',
  }
  return MAP[err] ?? `登录出错：${err}`
}

export function LoginPage() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl  = searchParams.get('callbackUrl') ?? '/'
  const urlError     = searchParams.get('error')

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState(urlError ? mapOAuthError(urlError) : '')
  const [loading,  setLoading]  = useState<string | null>(null)
  const [focused,  setFocused]  = useState<string | null>(null)

  type Providers = Awaited<ReturnType<typeof getProviders>>
  const [oauthProviders, setOauthProviders] = useState<Providers>(null)
  useEffect(() => { getProviders().then(setOauthProviders) }, [])

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('请填写邮箱和密码'); return }
    setError('')
    setLoading('credentials')
    const result = await signIn('credentials', { email, password, redirect: false })
    setLoading(null)
    if (result?.error) { setError('邮箱或密码不正确') }
    else { router.push(callbackUrl); router.refresh() }
  }

  async function handleOAuth(provider: 'google' | 'github') {
    setLoading(provider)
    await signIn(provider, { callbackUrl })
  }

  return (
    <div style={{
      display: 'flex', minHeight: '100vh',
      background: 'linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 35%, #EDE9FE 65%, #F0F9FF 100%)',
      backgroundAttachment: 'fixed', position: 'relative', overflow: 'hidden',
    }}>
      {/* Decorative blobs */}
      <div style={{ position:'absolute', top:'-15%', left:'-10%', width:600, height:600, borderRadius:'50%', background:'radial-gradient(circle, rgba(79,70,229,0.18) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(40px)' }} />
      <div style={{ position:'absolute', bottom:'-20%', right:'-5%', width:700, height:700, borderRadius:'50%', background:'radial-gradient(circle, rgba(124,58,237,0.14) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(50px)' }} />
      <div style={{ position:'absolute', top:'40%', left:'35%', width:400, height:400, borderRadius:'50%', background:'radial-gradient(circle, rgba(2,132,199,0.08) 0%, transparent 70%)', pointerEvents:'none', filter:'blur(30px)' }} />

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
        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:52 }}>
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
            <div style={{ fontSize:11, color:C.subtle }}>Job Copilot · Europe</div>
          </div>
        </div>

        {/* Hero text */}
        <div style={{ marginBottom:40 }}>
          <h1 style={{ fontSize:28, fontWeight:800, color:C.text, lineHeight:1.25, marginBottom:14, letterSpacing:'-0.02em' }}>
            让 AI 帮你<br />找到理想的工作
          </h1>
          <p style={{ fontSize:13, color:C.muted, lineHeight:1.75 }}>
            ApplyMate AI 自动化你的求职流程——从发现职位到投递简历，全程 AI 驱动。
          </p>
        </div>

        {/* Features */}
        <div style={{ display:'flex', flexDirection:'column', gap:22 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
              <div style={{
                width:36, height:36, borderRadius:10, flexShrink:0,
                background:'linear-gradient(135deg, rgba(79,70,229,0.09) 0%, rgba(124,58,237,0.07) 100%)',
                border:'1px solid rgba(79,70,229,0.15)',
                display:'flex', alignItems:'center', justifyContent:'center',
                color:C.primary,
              }}>{f.icon}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:3 }}>{f.title}</div>
                <div style={{ fontSize:11, color:C.muted, lineHeight:1.65 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Testimonial */}
        <div style={{ marginTop:'auto', paddingTop:28, borderTop:`1px solid ${C.border}` }}>
          <div style={{
            background:'linear-gradient(135deg, rgba(79,70,229,0.06) 0%, rgba(124,58,237,0.04) 100%)',
            border:'1px solid rgba(79,70,229,0.12)', borderRadius:12, padding:'16px 18px',
          }}>
            <div style={{ fontSize:24, lineHeight:1, color:C.primary, opacity:0.28, fontFamily:'Georgia,serif', marginBottom:4, userSelect:'none' }}>&ldquo;</div>
            <p style={{ fontSize:12, color:C.text, lineHeight:1.80, margin:'0 0 12px' }}>
              用 ApplyMate 两周内拿到了 Adyen、Booking.com 的面试，省了我大量整理简历的时间。
            </p>
            <div style={{ fontSize:11, color:C.muted }}>
              — <span style={{ fontWeight:600, color:C.text }}>Zhang Li</span>，Backend Engineer · Amsterdam
            </div>
          </div>
        </div>
      </div>

      {/* ── Right form panel ────────────────────────────────── */}
      <div style={{
        flex:1, display:'flex', alignItems:'center', justifyContent:'center',
        padding:'32px 24px', position:'relative', zIndex:1,
      }}>
        <div style={{
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
            <h2 style={{ fontSize:22, fontWeight:800, color:C.text, marginBottom:6, letterSpacing:'-0.02em' }}>欢迎回来 👋</h2>
            <p style={{ fontSize:13, color:C.muted }}>
              还没有账号？{' '}
              <Link href="/register" style={{
                color:C.primary, textDecoration:'none', fontWeight:600,
                background:'linear-gradient(135deg, #4F46E5, #7C3AED)',
                WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
              }}>免费注册</Link>
            </p>
          </div>

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
          {oauthProviders && (oauthProviders.google || oauthProviders.github) ? (
            <>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:22 }}>
                {oauthProviders.google && <OAuthBtn icon={<GoogleIcon />} label="使用 Google 登录" onClick={() => handleOAuth('google')} loading={loading === 'google'} />}
                {oauthProviders.github && <OAuthBtn icon={<GitHubIcon />} label="使用 GitHub 登录" onClick={() => handleOAuth('github')} loading={loading === 'github'} dark />}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:22 }}>
                <div style={{ flex:1, height:1, background:'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
                <span style={{ fontSize:11, color:C.subtle, whiteSpace:'nowrap' }}>或使用邮箱登录</span>
                <div style={{ flex:1, height:1, background:'linear-gradient(90deg, transparent, rgba(79,70,229,0.20), transparent)' }} />
              </div>
            </>
          ) : oauthProviders === null ? (
            <div style={{ marginBottom:22 }}>
              <div style={{ height:46, borderRadius:10, marginBottom:10, background:'rgba(79,70,229,0.06)' }} />
              <div style={{ height:46, borderRadius:10, background:'rgba(79,70,229,0.04)' }} />
            </div>
          ) : null}

          {/* Credentials form */}
          <form onSubmit={handleCredentials} style={{ display:'flex', flexDirection:'column', gap:15 }}>
            {/* Email */}
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <label style={{ fontSize:12, fontWeight:500, color:C.muted }}>邮箱</label>
              <input
                type="email" value={email} autoComplete="email" placeholder="you@example.com"
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
                <label style={{ fontSize:12, fontWeight:500, color:C.muted }}>密码</label>
                <Link href="/forgot-password" style={{ fontSize:11, color:C.primary, textDecoration:'none', fontWeight:500 }}>忘记密码？</Link>
              </div>
              <input
                type="password" value={password} autoComplete="current-password" placeholder="••••••••"
                onFocus={() => setFocused('password')} onBlur={() => setFocused(null)}
                onChange={e => setPassword(e.target.value)}
                style={{
                  width:'100%', padding:'10px 13px',
                  background: focused === 'password' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.65)',
                  border: focused === 'password' ? '1.5px solid rgba(79,70,229,0.55)' : '1px solid rgba(79,70,229,0.18)',
                  borderRadius:9, fontSize:13, color:C.text, outline:'none',
                  boxShadow: focused === 'password' ? '0 0 0 3px rgba(79,70,229,0.12)' : '0 1px 2px rgba(0,0,0,0.04)',
                  transition:'all 0.18s', backdropFilter:'blur(8px)',
                }}
              />
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
              {loading === 'credentials' ? '登录中…' : '登录'}
            </button>
          </form>

          {/* Demo hint */}
          <div style={{
            marginTop: 20, padding: '10px 14px',
            background: 'rgba(79,70,229,0.05)', borderRadius: 10,
            border: '1px solid rgba(79,70,229,0.12)',
          }}>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
              <span style={{ fontWeight: 600, color: C.primary }}>Demo：</span>
              {' '}使用 <code style={{ background: 'rgba(79,70,229,0.08)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>demo@applymate.ai</code>
              {' '}+ 任意密码体验完整功能。
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}