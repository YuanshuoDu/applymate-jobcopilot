'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useI18n } from '@/lib/i18n'

export default function AdminInvitationPage() {
  const { status } = useSession()
  const { lang } = useI18n()
  const copy = lang === 'zh'
    ? { checking: '正在检查邀请……', signIn: '请使用受邀邮箱登录以接受邀请。', accepted: '邀请已接受。现在可以打开管理员控制台。', failed: '无法接受邀请。', signInLink: '登录', console: '打开管理员控制台', title: 'ApplyMate 管理员邀请' }
    : { checking: 'Checking invitation…', signIn: 'Sign in with the invited email to accept this invitation.', accepted: 'Invitation accepted. You can now open the administrator console.', failed: 'Invitation could not be accepted.', signInLink: 'Sign in', console: 'Open admin console', title: 'ApplyMate administrator invitation' }
  const [message, setMessage] = useState(copy.checking)
  useEffect(() => {
    if (status === 'loading') return
    const token = new URLSearchParams(window.location.search).get('token') ?? ''
    if (status !== 'authenticated') { setMessage(copy.signIn); return }
    void fetch('/api/admin/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(async response => { const payload = await response.json().catch(() => null) as { error?: string } | null; setMessage(response.ok ? copy.accepted : lang === 'zh' ? copy.failed : payload?.error ?? copy.failed) }).catch(() => setMessage(copy.failed))
  }, [status, copy.accepted, copy.failed, copy.signIn, lang])
  const callbackUrl = typeof window === 'undefined'
    ? '/invite/admin'
    : `${window.location.pathname}${window.location.search}`
  return <main style={{ maxWidth: 520, margin: '15vh auto', padding: 24, fontFamily: 'system-ui' }}><h1>{copy.title}</h1><p>{message}</p>{status !== 'authenticated' && <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}>{copy.signInLink}</Link>}{status === 'authenticated' && <Link href="/admin">{copy.console}</Link>}</main>
}
