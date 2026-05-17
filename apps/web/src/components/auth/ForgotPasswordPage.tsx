'use client'

import { useState } from 'react'
import Link from 'next/link'

const C = {
  primary: '#185FA5',
  red: '#A32D2D',
  green: '#3B6D11',
  border: 'rgba(0,0,0,0.08)',
  text: '#0f0f10',
  muted: '#6b7280',
  bg: '#ffffff',
  bgSide: '#f0f5fb',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  fontSize: 13,
  color: C.text,
  background: C.bg,
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState('')

  function validateEmail(value: string): string | null {
    if (!value.trim()) return '请填写邮箱'
    if (!/\S+@\S+\.\S+/.test(value)) return '邮箱格式不正确'
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const nextError = validateEmail(email)
    if (nextError) {
      setError(nextError)
      return
    }

    setError('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? '请求失败，请稍后重试')
        setSubmitting(false)
        return
      }

      setSubmittedEmail(email.trim())
      setSubmitting(false)
    } catch {
      setError('网络错误，请稍后重试')
      setSubmitting(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bgSide, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
      <div style={{ width: '100%', maxWidth: 420, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: '0 16px 40px rgba(15,15,16,0.06)', padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, fontWeight: 700 }}>A</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>ApplyMate AI</div>
            <div style={{ fontSize: 11, color: C.muted }}>Job Copilot</div>
          </div>
        </div>

        {!submittedEmail ? (
          <>
            <div style={{ marginBottom: 24 }}>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 8 }}>Reset your password</h1>
              <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
                Enter the email address tied to your account and we will send you a reset link.
              </p>
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: 'rgba(163,45,45,0.08)', border: '1px solid rgba(163,45,45,0.2)', borderRadius: 8, marginBottom: 18, fontSize: 12, color: C.red }}>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>Email</label>
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  placeholder="you@example.com"
                  onChange={e => setEmail(e.target.value)}
                  className="input-base"
                  style={inputStyle}
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: '100%',
                  padding: '11px',
                  marginTop: 4,
                  background: C.primary,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ width: 56, height: 56, borderRadius: 999, background: 'rgba(59,109,17,0.12)', color: C.green, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>
              ✓
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 10 }}>Check your inbox</h1>
            <p style={{ fontSize: 14, color: C.text, lineHeight: 1.7 }}>
              {`Check your inbox — we sent a reset link to ${submittedEmail}`}
            </p>
          </div>
        )}

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.border}` }}>
          <Link href="/login" style={{ fontSize: 13, color: C.primary, textDecoration: 'none', fontWeight: 500 }}>
            Back to login
          </Link>
        </div>
      </div>
    </div>
  )
}
