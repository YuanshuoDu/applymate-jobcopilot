/**
 * Email notification when an auto-apply task completes.
 * Sends via Resend API. No-op if RESEND_API_KEY is not set.
 * Non-throwing — email failure never blocks apply result.
 */
import { getPool } from '../db/apply-results.js'

export interface NotifyApplyResultParams {
  userId: string
  jobTitle: string
  jobCompany: string
  status: 'submitted' | 'manual' | 'failed'
  error?: string | null
  flowUsed?: string | null
  jobUrl?: string | null
}

export async function notifyApplyResult(p: NotifyApplyResultParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return  // not configured — silently skip

  // Load user email from DB
  const res = await getPool().query(
    'SELECT email, name FROM "User" WHERE id = $1 LIMIT 1',
    [p.userId]
  )
  const user = res.rows[0] as { email: string; name: string | null } | undefined
  if (!user?.email) return

  const subject =
    p.status === 'submitted' ? `✅ Applied to ${p.jobCompany} — ${p.jobTitle}` :
    p.status === 'manual'    ? `⚠️ Action needed: ${p.jobCompany} — ${p.jobTitle}` :
                               `❌ Apply failed: ${p.jobCompany} — ${p.jobTitle}`

  const flowLabel = p.flowUsed === 'programmatic' ? 'Pre-programmed flow'
                  : p.flowUsed === 'llm'           ? 'AI agent'
                  : null

  const html = [
    `<h2 style="margin:0 0 16px">${subject}</h2>`,
    p.status === 'submitted'
      ? `<p>Your application was submitted successfully via ApplyMate.</p>`
      : '',
    p.status === 'manual'
      ? `<p>The agent could not complete the application automatically and needs your attention.</p>
         ${p.jobUrl ? `<p><a href="${p.jobUrl}" style="color:#185FA5">Complete application manually →</a></p>` : ''}`
      : '',
    p.status === 'failed' && p.error
      ? `<p style="color:#ef4444">Error: ${p.error.slice(0, 300)}</p>`
      : '',
    flowLabel
      ? `<p style="color:#888;font-size:13px">Applied via: ${flowLabel}</p>`
      : '',
    `<hr style="margin:24px 0;border:none;border-top:1px solid #eee"/>`,
    `<p><a href="https://applymate.dev/apply-history" style="color:#185FA5">View full apply history →</a></p>`,
  ].join('\n')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ApplyMate <noreply@applymate.dev>',
      to: user.email,
      subject,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err: Error) => {
    console.warn('[notify] fetch failed:', err.message)
    return null
  })

  if (response && !response.ok) {
    console.warn('[notify] Resend returned', response.status)
  }
}
