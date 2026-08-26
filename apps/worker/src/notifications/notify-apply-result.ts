/**
 * Email notification when an auto-apply task completes.
 * Sends via Resend API. No-op if RESEND_API_KEY is not set.
 * Non-throwing — email failure never blocks apply result.
 */
import { pinnedFetch } from '@jobcopilot/shared'
import { getPool } from '../db/apply-results.js'
import { recordWorkerExternalApiUsage } from '../api-usage/external-api-usage.js'

export interface NotifyApplyResultParams {
  userId: string
  jobTitle: string
  jobCompany: string
  status: 'submitted' | 'manual' | 'failed'
  error?: string | null
  flowUsed?: string | null
  jobUrl?: string | null
}

type PreferenceKey = 'apply' | 'reject'

function preferenceKey(status: NotifyApplyResultParams['status']): PreferenceKey {
  // A failed automated attempt is operational feedback, not an employer
  // rejection. Keep it under the auto-apply result preference.
  void status
  return 'apply'
}

function preferenceEnabled(value: unknown, key: PreferenceKey): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  const prefs = (value as Record<string, unknown>).notificationPreferences
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return true
  const configured = (prefs as Record<string, unknown>)[key]
  return typeof configured === 'boolean' ? configured : true
}

export async function notifyApplyResult(p: NotifyApplyResultParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return  // not configured — silently skip

  // Load user email from DB
  const res = await getPool().query(
    'SELECT email, name, preferences FROM "User" WHERE id = $1 LIMIT 1',
    [p.userId]
  )
  const user = res.rows[0] as { email: string; name: string | null; preferences?: unknown } | undefined
  if (!user?.email) return
  if (!preferenceEnabled(user.preferences, preferenceKey(p.status))) return

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

  const startedAt = Date.now()
  const response = await pinnedFetch('https://api.resend.com/emails', {
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
  }).then(async result => {
    if (process.env.NODE_ENV !== 'test') await recordWorkerExternalApiUsage({ pool: getPool(), userId: p.userId, provider: 'resend', operation: 'apply_result', status: result.ok ? 'success' : 'error', httpStatus: result.status, errorCode: result.ok ? undefined : result.status === 429 ? 'http_429' : result.status >= 500 ? 'http_5xx' : 'http_4xx', latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(JSON.stringify({ to: user.email, subject })) })
    return result
  }).catch(async (err: Error) => {
    if (process.env.NODE_ENV !== 'test') await recordWorkerExternalApiUsage({ pool: getPool(), userId: p.userId, provider: 'resend', operation: 'apply_result', status: 'error', errorCode: isTimeoutError(err) ? 'timeout' : 'network_error', latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(JSON.stringify({ to: user.email, subject })) })
    console.warn('[notify] fetch failed:', err.message)
    return null
  })

  if (response && !response.ok) {
    console.warn('[notify] Resend returned', response.status)
  }
}

function isTimeoutError(error: unknown): boolean {
  return (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && error.name.toLowerCase() === 'timeouterror')
}
