'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

export default function AdminInvitationPage() {
  const { status } = useSession()
  const [message, setMessage] = useState('Checking invitation…')
  useEffect(() => {
    if (status === 'loading') return
    const token = new URLSearchParams(window.location.search).get('token') ?? ''
    if (status !== 'authenticated') { setMessage('Sign in with the invited email to accept this invitation.'); return }
    void fetch('/api/admin/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(async response => { const payload = await response.json().catch(() => null) as { error?: string } | null; setMessage(response.ok ? 'Invitation accepted. You can now open the administrator console.' : payload?.error ?? 'Invitation could not be accepted.') }).catch(() => setMessage('Invitation could not be accepted.'))
  }, [status])
  const callbackUrl = typeof window === 'undefined'
    ? '/invite/admin'
    : `${window.location.pathname}${window.location.search}`
  return <main style={{ maxWidth: 520, margin: '15vh auto', padding: 24, fontFamily: 'system-ui' }}><h1>ApplyMate administrator invitation</h1><p>{message}</p>{status !== 'authenticated' && <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Sign in</Link>}{status === 'authenticated' && <Link href="/admin">Open admin console</Link>}</main>
}
