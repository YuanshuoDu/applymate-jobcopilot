'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { signIn, signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { useI18n } from '@/lib/i18n'

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '10px 12px',
  border: '1px solid #CBD5E1',
  borderRadius: 8,
  fontSize: 14,
}

export default function AdminInvitationPage() {
  const { data: session, status } = useSession()
  const { lang } = useI18n()
  const token = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('token') ?? ''
  const copy = lang === 'zh'
    ? {
        checking: '正在检查登录状态……', accepted: '邀请已接受。现在可以打开管理员控制台。', failed: '无法接受邀请。', invalid: '邀请链接无效或已过期。', emailMismatch: '当前登录账号与受邀邮箱不一致。', sessionStale: '当前登录状态已失效，请切换到受邀账号后重试。', switchHint: '请先退出当前账号，再使用受邀邮箱登录，然后重新打开此邀请链接。', switchAccount: '退出并切换账号',
        signInLink: '已有账号？登录', console: '打开管理员控制台', title: 'ApplyMate 管理员邀请', createTitle: '创建受邀账号', email: '受邀邮箱', name: '姓名', password: '密码', confirm: '确认密码', create: '创建账号并接受邀请', creating: '正在创建账号……', mismatch: '两次输入的密码不一致。', createFailed: '无法创建账号。', exists: '该邮箱已有账号，请先登录后再接受邀请。', security: '创建后请使用你自己的设备注册 WebAuthn 安全密钥。',
      }
    : {
        checking: 'Checking sign-in status…', accepted: 'Invitation accepted. You can now open the administrator console.', failed: 'Invitation could not be accepted.', invalid: 'This invitation link is invalid or expired.', emailMismatch: 'The currently signed-in account does not match the invited email.', sessionStale: 'The current sign-in session is no longer valid. Switch to the invited account and try again.', switchHint: 'Sign out of the current account, sign in with the invited email, and then reopen this invitation link.', switchAccount: 'Sign out and switch account',
        signInLink: 'Already have an account? Sign in', console: 'Open admin console', title: 'ApplyMate administrator invitation', createTitle: 'Create your invited account', email: 'Invited email', name: 'Name', password: 'Password', confirm: 'Confirm password', create: 'Create account and accept invitation', creating: 'Creating account…', mismatch: 'The passwords do not match.', createFailed: 'Unable to create the account.', exists: 'An account already exists for this email. Sign in first, then accept the invitation.', security: 'After creating the account, register your own WebAuthn security key.',
      }
  const [message, setMessage] = useState(copy.checking)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (status === 'loading') return
    if (status !== 'authenticated') return
    void fetch('/api/admin/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(async response => {
      const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null
      if (response.ok) {
        setMessage(copy.accepted)
      } else if (payload?.code === 'INVITATION_EMAIL_MISMATCH') {
        setMessage(copy.emailMismatch)
      } else if (payload?.code === 'SESSION_REQUIRED' || payload?.code === 'SESSION_EXPIRED' || response.status === 401) {
        setMessage(copy.sessionStale)
      } else if (payload?.code === 'INVITATION_INVALID') {
        setMessage(copy.invalid)
      } else {
        setMessage(copy.failed)
      }
    }).catch(() => setMessage(copy.failed))
  }, [status, token, copy.accepted, copy.emailMismatch, copy.failed, copy.invalid, copy.sessionStale])

  async function createInvitedAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (password !== confirm) { setError(copy.mismatch); return }
    setCreating(true)
    try {
      const response = await fetch('/api/admin/invitations/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, name, password }),
      })
      const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null
      if (!response.ok) {
        setError(payload?.code === 'ACCOUNT_EXISTS' ? copy.exists : payload?.error ?? copy.createFailed)
        setCreating(false)
        return
      }
      const login = await signIn('credentials', { email, password, redirect: false })
      if (login?.error) { setError(copy.createFailed); setCreating(false); return }
      window.location.reload()
    } catch {
      setError(copy.createFailed)
      setCreating(false)
    }
  }

  const callbackUrl = typeof window === 'undefined' ? '/invite/admin' : `${window.location.pathname}${window.location.search}`
  return (
    <main style={{ maxWidth: 520, margin: '10vh auto', padding: 24, fontFamily: 'system-ui', color: '#0F172A' }}>
      <h1>{copy.title}</h1>
      {status === 'loading' ? (
        <p>{copy.checking}</p>
      ) : status === 'authenticated' ? (
        <>
          <p>{message}</p>
          {message === copy.accepted && <Link href="/admin">{copy.console}</Link>}
          {(message === copy.emailMismatch || message === copy.sessionStale) && (
            <>
              <p style={{ color: '#475569', fontSize: 13 }}>{copy.switchHint}</p>
              {session?.user?.email && <p style={{ color: '#475569', fontSize: 13 }}>Current account: {session.user.email}</p>}
              <button type="button" onClick={() => void signOut({ callbackUrl })} style={{ padding: '10px 12px', border: '1px solid #CBD5E1', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>{copy.switchAccount}</button>
            </>
          )}
        </>
      ) : (
        <>
          <p>{copy.createTitle}</p>
          <p style={{ color: '#475569', fontSize: 13 }}>{copy.security}</p>
          {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}
          <form onSubmit={createInvitedAccount} style={{ display: 'grid', gap: 12 }}>
            <label>{copy.email}<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} style={inputStyle} /></label>
            <label>{copy.name}<input required type="text" autoComplete="name" value={name} onChange={event => setName(event.target.value)} style={inputStyle} /></label>
            <label>{copy.password}<input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} style={inputStyle} /></label>
            <label>{copy.confirm}<input required minLength={8} type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} style={inputStyle} /></label>
            <button type="submit" disabled={creating} style={{ padding: '11px 14px', border: 0, borderRadius: 8, background: '#4F46E5', color: '#fff', cursor: creating ? 'wait' : 'pointer' }}>{creating ? copy.creating : copy.create}</button>
          </form>
          <p style={{ marginTop: 16 }}><Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}>{copy.signInLink}</Link></p>
        </>
      )}
    </main>
  )
}
