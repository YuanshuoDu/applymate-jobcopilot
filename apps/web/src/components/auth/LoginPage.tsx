'use client'

import { useState, useEffect } from 'react'
import React from 'react'
import { useI18n } from '@/lib/i18n'
import { signIn, getProviders } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

// ── Colour tokens ─────────────────────────────────────────────
const C = {
  primary:  '#185FA5',
  green:    '#3B6D11',
  red:      '#A32D2D',
  border:   'rgba(0,0,0,0.08)',
  text:     '#0f0f10',
  muted:    '#6b7280',
  bg:       '#ffffff',
  bgSide:   '#f0f5fb',
}

const FEATURES = [
  { icon: '🎯', title: '智能职位匹配',    desc: 'AI 实时评估每个职位与你简历的匹配程度' },
  { icon: '📄', title: '简历自动定制',    desc: '针对每个 JD 一键优化简历关键词与格式' },
  { icon: '🤖', title: 'AI Agent 自动投递', desc: '设置规则后，Agent 24h 自动发现并申请职位' },
  { icon: '📬', title: 'Gmail 一站跟踪',  desc: '自动识别 HR 回复，汇总申请进度' },
]

export function LoginPage() {
  const router      = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') ?? '/'
  const urlError    = searchParams.get('error')

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState(urlError ? mapOAuthError(urlError) : '')
  const [loading,  setLoading]  = useState<string | null>(null)  // 'credentials' | 'google' | 'github'

  const { t } = useI18n()

  // Detect which OAuth providers are actually configured
  type Providers = Awaited<ReturnType<typeof getProviders>>
  const [oauthProviders, setOauthProviders] = useState<Providers>(null)
  useEffect(() => {
    getProviders().then(setOauthProviders)
  }, [])

  // ── Credentials login ────────────────────────────────────────
  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError(t('auth.login.error.emailPasswordRequired')); return }
    setError('')
    setLoading('credentials')
    const result = await signIn('credentials', { email, password, redirect: false })
    setLoading(null)
    if (result?.error) {
      setError(t('auth.login.error.invalidCredentials'))
    } else {
      router.push(callbackUrl)
      router.refresh()
    }
  }

  // ── OAuth ─────────────────────────────────────────────────────
  async function handleOAuth(provider: 'google' | 'github') {
    setLoading(provider)
    await signIn(provider, { callbackUrl })
  }

  return (
    <div style={{ display:'flex', minHeight:'100vh', background: C.bg }}>

      {/* ── Left brand panel ────────────────────────────────── */}
      <div style={{
        width: 440, flexShrink: 0, background: C.bgSide,
        borderRight: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', padding: '48px 40px',
        // hide on small screens via class
      }} className="auth-panel">

        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:48 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:C.primary, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:15, fontWeight:700 }}>A</div>
          <div>
            <div style={{ fontSize:15, fontWeight:600, color:C.text }}>ApplyMate AI</div>
            <div style={{ fontSize:11, color:C.muted }}>Job Copilot</div>
          </div>
        </div>

        <div style={{ marginBottom:36 }}>
          <h1 style={{ fontSize:24, fontWeight:700, color:C.text, lineHeight:1.3, marginBottom:10 }}>
            {t('auth.login.heroTitle').split('\n').map((line, i) => <React.Fragment key={i}>{line}{i === 0 && <br />}</React.Fragment>)}
          </h1>
          <p style={{ fontSize:13, color:C.muted, lineHeight:1.7 }}>
            {t('auth.login.heroDesc')}
          </p>
        </div>

        {/* Feature list */}
        <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ display:'flex', gap:14 }}>
              <div style={{ fontSize:20, flexShrink:0, marginTop:1 }}>{f.icon}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:500, color:C.text, marginBottom:3 }}>{f.title}</div>
                <div style={{ fontSize:11, color:C.muted, lineHeight:1.6 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Testimonial */}
        <div style={{ marginTop:'auto', paddingTop:28, borderTop:`1px solid ${C.border}` }}>
          <blockquote style={{ margin:0 }}>
            {/* Large decorative quote mark */}
            <div style={{ fontSize:64, lineHeight:1, color:C.primary, opacity:0.18, fontFamily:'Georgia, serif', marginBottom:-8, userSelect:'none' }}>&ldquo;</div>
            <p style={{ fontSize:13, color:C.text, lineHeight:1.75, margin:'0 0 14px' }}>
              {t('auth.login.testimonial')}
            </p>
            <div style={{ fontSize:12, color:C.muted, fontStyle:'normal' }}>
              — <span style={{ fontWeight:500, color:C.text }}>Zhang Li</span>, Backend Engineer · Amsterdam
            </div>
          </blockquote>
        </div>
      </div>

      {/* ── Right form panel ────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'32px 24px' }}>
        <div style={{ width:'100%', maxWidth:400 }}>

          {/* Header */}
          <div style={{ marginBottom:32 }}>
            <h2 style={{ fontSize:22, fontWeight:700, color:C.text, marginBottom:6 }}>{t('auth.login.welcomeBack')}</h2>
            <p style={{ fontSize:13, color:C.muted }}>
              {t('auth.login.noAccount')}
              <Link href="/register" style={{ color:C.primary, marginLeft:4, textDecoration:'none', fontWeight:500 }}>{t('auth.login.signUp')}</Link>
            </p>
          </div>

          {/* Error banner */}
          {error && (
            <div style={{ padding:'10px 14px', background:'rgba(163,45,45,0.08)', border:`1px solid rgba(163,45,45,0.2)`, borderRadius:8, marginBottom:20, fontSize:12, color:C.red }}>
              ⚠ {error}
            </div>
          )}

          {/* OAuth buttons — only show configured providers */}
          {oauthProviders && (oauthProviders.google || oauthProviders.github) ? (
            <>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:24 }}>
                {oauthProviders.google && (
                  <OAuthBtn
                    icon={<GoogleIcon />}
                    label={t('auth.login.googleLogin')}
                    onClick={() => handleOAuth('google')}
                    loading={loading === 'google'}
                  />
                )}
                {oauthProviders.github && (
                  <OAuthBtn
                    icon={<GitHubIcon />}
                    label={t('auth.login.githubLogin')}
                    onClick={() => handleOAuth('github')}
                    loading={loading === 'github'}
                    dark
                  />
                )}
              </div>

              {/* Divider */}
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
                <div style={{ flex:1, height:1, background:C.border }} />
                <span style={{ fontSize:11, color:C.muted }}>{t('auth.login.orEmail')}</span>
                <div style={{ flex:1, height:1, background:C.border }} />
              </div>
            </>
          ) : oauthProviders === null ? (
            /* Still loading providers — show skeleton */
            <div style={{ marginBottom:24 }}>
              <div style={{ height:44, background:C.border, borderRadius:8, opacity:0.3, marginBottom:10 }} />
              <div style={{ height:44, background:C.border, borderRadius:8, opacity:0.2 }} />
            </div>
          ) : null /* No OAuth providers configured — skip directly to email form */}

          {/* Credentials form */}
          <form onSubmit={handleCredentials} style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <FormField label={t("auth.login.email")}>
              <input
                type="email" value={email} autoComplete="email"
                placeholder="you@example.com"
                onChange={e => setEmail(e.target.value)}
                className="input-base"
                style={inputStyle}
              />
            </FormField>

            <FormField
              label={t("auth.login.password")}
              right={<Link href="/forgot-password" style={{ fontSize:11, color:C.primary, textDecoration:'none' }}>{t('auth.login.forgotPassword')}</Link>}
            >
              <input
                type="password" value={password} autoComplete="current-password"
                placeholder="••••••••"
                onChange={e => setPassword(e.target.value)}
                className="input-base"
                style={inputStyle}
              />
            </FormField>

            <SubmitBtn loading={loading === 'credentials'}>{t('auth.login.login')}</SubmitBtn>
          </form>

          {/* Demo hint */}
          <div style={{ marginTop:20, padding:'10px 14px', background:'rgba(24,95,165,0.06)', borderRadius:8, fontSize:11, color:C.muted, lineHeight:1.6 }}>
            {t('auth.login.demoAccount')} <span style={{ fontFamily:'monospace', color:C.text }}>demo@applymate.ai</span> / <span style={{ fontFamily:'monospace', color:C.text }}>demo1234</span>
          </div>

          {/* Dev hint: OAuth not configured */}
          {oauthProviders && !oauthProviders.google && !oauthProviders.github && (
            <div style={{ marginTop:12, padding:'10px 14px', background:'rgba(133,79,11,0.08)', border:'1px solid rgba(133,79,11,0.2)', borderRadius:8, fontSize:11, color:'#854F0B', lineHeight:1.6 }}>
              ⚙ Google / GitHub 登录未启用<br />
              <span style={{ fontSize:10, opacity:0.75 }}>在 <code style={{ background:'rgba(0,0,0,0.06)', padding:'1px 4px', borderRadius:3 }}>.env.local</code> 中配置 <code style={{ background:'rgba(0,0,0,0.06)', padding:'1px 4px', borderRadius:3 }}>AUTH_GOOGLE_ID</code> / <code style={{ background:'rgba(0,0,0,0.06)', padding:'1px 4px', borderRadius:3 }}>AUTH_GITHUB_ID</code></span>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// ── Shared sub-components ────────────────────────────────────

function OAuthBtn({ icon, label, onClick, loading, dark }: {
  icon: React.ReactNode; label: string; onClick: () => void; loading?: boolean; dark?: boolean
}) {
  const { t } = useI18n()
  return (
    <button
      type="button" onClick={onClick} disabled={loading}
      style={{
        display:'flex', alignItems:'center', justifyContent:'center', gap:10,
        width:'100%', padding:'10px 16px',
        background: dark ? '#24292e' : C.bg,
        color: dark ? '#fff' : C.text,
        border: `1px solid ${dark ? '#24292e' : C.border}`,
        borderRadius:8, fontSize:13, fontWeight:500, cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1, transition:'all 0.15s',
      }}
    >
      {loading ? <Spinner /> : icon}
      {loading ? t('auth.login.redirecting') : label}
    </button>
  )
}

function FormField({ label, children, right }: { label: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <label style={{ fontSize:12, fontWeight:500, color:C.muted }}>{label}</label>
        {right}
      </div>
      {children}
    </div>
  )
}

function SubmitBtn({ children, loading }: { children: React.ReactNode; loading?: boolean }) {
  const { t } = useI18n()
  return (
    <button
      type="submit" disabled={loading}
      style={{
        width:'100%', padding:'11px', marginTop:4,
        background: C.primary, color:'#fff', border:'none', borderRadius:8,
        fontSize:13, fontWeight:600, cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1, transition:'all 0.15s',
        display:'flex', alignItems:'center', justifyContent:'center', gap:8,
      }}
    >
      {loading && <Spinner light />}
      {loading ? t('auth.login.loggingIn') : children}
    </button>
  )
}

function Spinner({ light }: { light?: boolean }) {
  return (
    <span style={{
      width:14, height:14, border:`2px solid ${light ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.15)'}`,
      borderTopColor: light ? '#fff' : C.primary,
      borderRadius:'50%', display:'inline-block',
      animation:'spin 0.7s linear infinite',
    }} />
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  )
}

const inputStyle: React.CSSProperties = {
  width:'100%', padding:'10px 12px',
  border:`1px solid ${C.border}`, borderRadius:8,
  fontSize:13, color:C.text, background:C.bg,
  transition:'border-color 0.15s',
}

function mapOAuthError(code: string): string {
  const map: Record<string, string> = {
    OAuthSignin:       'OAuth 登录初始化失败，请重试',
    OAuthCallback:     'OAuth 回调出错，请重试',
    OAuthCreateAccount:'无法创建账号，该邮箱可能已注册',
    OAuthAccountNotLinked:'该邮箱已绑定其他登录方式',
    Callback:          '登录过程出错，请重试',
    AccessDenied:      '访问被拒绝',
    Verification:      '验证链接已过期，请重新请求',
  }
  return map[code] ?? '登录出错，请重试'
}
