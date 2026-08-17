'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useI18n } from '@/lib/i18n'

const C = {
  primary: '#4F46E5',
  text: '#0F172A',
  muted: '#64748B',
  border: 'rgba(79,70,229,0.16)',
  red: '#B91C1C',
  green: '#166534',
}

function errorFromResponse(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const error = (data as Record<string, unknown>).error
  return typeof error === 'string' ? error : null
}

export function ResetPasswordPage() {
  const { t } = useI18n()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [complete, setComplete] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) {
      setError(t('auth.reset.invalid'))
      return
    }
    if (password.length < 8) {
      setError(t('auth.reset.tooShort'))
      return
    }
    if (password !== confirmation) {
      setError(t('auth.reset.mismatch'))
      return
    }

    setError('')
    setSubmitting(true)
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setError(errorFromResponse(body) ?? t('auth.reset.failed'))
        return
      }

      setPassword('')
      setConfirmation('')
      setComplete(true)
    } catch {
      setError(t('auth.register.error.networkError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(135deg, #EEF2FF, #F5F3FF 52%, #F0F9FF)' }}>
      <section style={{ width: '100%', maxWidth: 420, padding: 32, border: `1px solid ${C.border}`, borderRadius: 18, background: 'rgba(255,255,255,0.94)', boxShadow: '0 16px 40px rgba(79,70,229,0.12)' }}>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, marginBottom: 28, color: C.primary, textDecoration: 'none', fontWeight: 700 }}>
          <span style={{ display: 'grid', width: 30, height: 30, placeItems: 'center', borderRadius: 8, color: '#fff', background: C.primary }}>A</span>
          ApplyMate AI
        </Link>

        {complete ? (
          <div>
            <div style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', marginBottom: 16, borderRadius: 999, color: C.green, background: 'rgba(22,101,52,0.1)', fontSize: 24 }}>✓</div>
            <h1 style={{ margin: '0 0 10px', color: C.text, fontSize: 25 }}>{t('auth.reset.updated')}</h1>
            <p style={{ margin: '0 0 24px', color: C.muted, fontSize: 14, lineHeight: 1.65 }}>{t('auth.reset.updatedDetail')}</p>
            <Link href="/login" style={{ display: 'block', padding: '11px 14px', borderRadius: 9, color: '#fff', background: C.primary, textAlign: 'center', textDecoration: 'none', fontWeight: 600 }}>{t('auth.reset.signIn')}</Link>
          </div>
        ) : (
          <>
            <h1 style={{ margin: '0 0 8px', color: C.text, fontSize: 25 }}>{t('auth.reset.title')}</h1>
            <p style={{ margin: '0 0 24px', color: C.muted, fontSize: 14, lineHeight: 1.65 }}>{t('auth.reset.description')}</p>

            {error && <p role="alert" style={{ margin: '0 0 16px', padding: '10px 12px', borderRadius: 8, color: C.red, background: 'rgba(185,28,28,0.08)', fontSize: 13 }}>{error}</p>}

            <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'grid', gap: 6, color: C.muted, fontSize: 13, fontWeight: 600 }}>
                {t('auth.reset.newPassword')}
                <input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={submitting} style={inputStyle} />
              </label>
              <label style={{ display: 'grid', gap: 6, color: C.muted, fontSize: 13, fontWeight: 600 }}>
                {t('auth.reset.confirmPassword')}
                <input type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={submitting} style={inputStyle} />
              </label>
              <button type="submit" disabled={submitting} style={{ marginTop: 4, padding: '11px 14px', border: 0, borderRadius: 9, color: '#fff', background: C.primary, fontSize: 14, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
                {submitting ? t('auth.reset.updating') : t('auth.reset.update')}
              </button>
            </form>
          </>
        )}

        {!complete && <Link href="/forgot-password" style={{ display: 'inline-block', marginTop: 22, color: C.primary, fontSize: 13, textDecoration: 'none' }}>{t('auth.reset.requestLink')}</Link>}
      </section>
    </main>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.text,
  fontSize: 14,
}
