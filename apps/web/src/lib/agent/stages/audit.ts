/**
 * Stage 6 — Audit (验收员)
 *
 * Two-phase:
 *
 *   Phase A — DB Verification:
 *     Verifies queued jobs are correctly staged in DB.
 *
 *   Phase B — Gmail Application Tracking (NEW):
 *     Scans Gmail for replies to job applications:
 *       - interview invites  → updates job status to 'interview'
 *       - offers             → updates to 'offer'
 *       - rejections         → updates to 'rejected', drafts follow-up inquiry
 *         (emits agent_question before sending, requires user confirmation)
 *
 * Rejection follow-up:
 *   Drafts a gracious inquiry email asking for feedback or future consideration.
 *   Does NOT send without user confirmation (emits agent_question with draft).
 */
import { db }                from '@/lib/db'
import { modelChat }         from '@/lib/model-router'
import { getGoogleAccessToken, classifyEmail, extractPlainText } from '@/lib/gmail-helpers'
import type { Job }          from '@prisma/client'
import type {
  PipelineCtx, ExecuteOutput, AuditOutput, RunReport, StageResult,
} from '../types'
import { stageOk } from '../types'

export async function runAudit(
  executeOutput: ExecuteOutput,
  originalJobs:  Job[],
  ctx:           PipelineCtx,
): Promise<StageResult<AuditOutput>> {
  const t0 = Date.now()
  const { emit, userId } = ctx
  const warnings: string[] = []

  // ── Phase A: DB state verification ───────────────────────────────────────────
  // Executor now marks queued jobs as 'review' (ready for manual apply)
  // Previously they were marked 'applied' — accept both for backwards compat
  if (executeOutput.applied.length > 0) {
    const dbJobs = await db.job.findMany({
      where:  { id: { in: executeOutput.applied } },
      select: { id: true, status: true, company: true, role: true, analysisNote: true },
    })

    for (const dbJob of dbJobs) {
      const isReadyToApply = dbJob.status === 'review' &&
        (dbJob.analysisNote ?? '').startsWith('[申请就绪]')
      const isApplied = dbJob.status === 'applied'
      if (!isReadyToApply && !isApplied) {
        warnings.push(`${dbJob.company} · ${dbJob.role}: 状态异常 (${dbJob.status})`)
      }
    }

    emit('agent_observation', {
      role:        'auditor',
      observation: `DB 核验：${dbJobs.length} 个职位已就绪（状态 review+[申请就绪] 标记）${warnings.length ? `，⚠ ${warnings.length} 个状态异常` : '，全部正常'}`,
    })
  }

  // ── Phase B: Gmail application tracking ──────────────────────────────────────
  const token = await getGoogleAccessToken(userId).catch(() => null)

  if (token) {
    emit('agent_action', {
      role:   'auditor',
      action: '扫描 Gmail 收件箱，查找职位申请回复邮件…',
    })

    // Load recently applied jobs to match against emails
    const appliedJobs = await db.job.findMany({
      where:   { userId, status: { in: ['applied', 'review'] } },
      orderBy: { updatedAt: 'desc' },
      take:    50,
      select:  { id: true, company: true, role: true, status: true, url: true },
    })

    if (appliedJobs.length > 0) {
      const emailUpdates = await scanGmailForApplicationReplies(
        token, appliedJobs, userId, emit, ctx,
      )

      if (emailUpdates.interview > 0 || emailUpdates.offer > 0 || emailUpdates.rejected > 0) {
        emit('agent_observation', {
          role:        'auditor',
          observation: `📬 Gmail 扫描结果：面试邀请 ${emailUpdates.interview} 封，Offer ${emailUpdates.offer} 封，拒信 ${emailUpdates.rejected} 封`,
        })
      } else {
        emit('agent_observation', {
          role:        'auditor',
          observation: '📬 未发现新的职位回复邮件',
        })
      }
    }
  } else {
    emit('agent_observation', {
      role:        'auditor',
      observation: '⚠ 未连接 Gmail — 无法监控申请回复。在设置中连接 Google 账号可启用此功能。',
    })
  }

  // ── Final report ──────────────────────────────────────────────────────────────
  const processed = originalJobs.length
  const applied   = executeOutput.applied.length
  const failed    = executeOutput.failed.length
  const skipped   = Math.max(0, processed - applied - failed)

  const report: RunReport = { processed, applied, pending: 0, skipped, failed, durationMs: Date.now() - t0 }

  return stageOk('audit', { report, warnings }, 1, Date.now() - t0)
}

// ── Gmail scanning ────────────────────────────────────────────────────────────

interface EmailTally { interview: number; offer: number; rejected: number }

async function scanGmailForApplicationReplies(
  token:      string,
  jobs:       Array<{ id: string; company: string; role: string; status: string; url: string | null }>,
  userId:     string,
  emit:       PipelineCtx['emit'],
  ctx:        PipelineCtx,
): Promise<EmailTally> {
  const tally: EmailTally = { interview: 0, offer: 0, rejected: 0 }

  try {
    // Search for job-application related emails from the last 30 days
    const query = 'subject:(application OR interview OR offer OR unfortunately OR congratulations OR "thank you for applying") newer_than:30d'
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=30`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }
    )
    if (!listRes.ok) return tally

    const listData = await listRes.json() as { messages?: Array<{ id: string }> }
    const messageIds = (listData.messages ?? []).map(m => m.id)
    if (messageIds.length === 0) return tally

    // Build a map of company name → job for matching
    const companyJobMap = new Map(jobs.map(j => [j.company.toLowerCase().trim(), j]))

    for (const msgId of messageIds.slice(0, 20)) {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) }
        )
        if (!msgRes.ok) continue
        const msg = await msgRes.json() as {
          payload: Record<string, unknown>
          snippet: string
          labelIds?: string[]
        }

        // Extract subject and sender
        const headers = (msg.payload.headers as Array<{ name: string; value: string }> | undefined) ?? []
        const subject  = headers.find(h => h.name === 'Subject')?.value  ?? ''
        const fromFull = headers.find(h => h.name === 'From')?.value     ?? ''
        const fromName = fromFull.replace(/<.*>/, '').trim()
        const fromEmail = fromFull.match(/<(.+?)>/)?.[1] ?? ''

        const classification = classifyEmail(subject, msg.snippet)
        if (classification === 'received') continue // just acknowledgement, skip

        // Find matching job by company name in sender domain or subject
        let matchedJob: typeof jobs[0] | undefined
        for (const [coName, job] of companyJobMap) {
          if (
            subject.toLowerCase().includes(coName) ||
            fromEmail.toLowerCase().includes(coName.replace(/\s+/g, '').slice(0, 10)) ||
            fromFull.toLowerCase().includes(coName)
          ) {
            matchedJob = job
            break
          }
        }
        if (!matchedJob) continue

        // Map classification to job status
        const newStatus: Record<string, string> = {
          interview: 'interview',
          offer:     'offer',
          rejected:  'rejected',
        }
        const statusUpdate = newStatus[classification]
        if (!statusUpdate) continue

        // Only update if status hasn't already been set to this or further
        const statusOrder = ['saved', 'review', 'applied', 'interview', 'offer', 'rejected']
        const currentIdx = statusOrder.indexOf(matchedJob.status)
        const newIdx     = statusOrder.indexOf(statusUpdate)
        if (newIdx <= currentIdx) continue

        // Update DB
        await db.job.update({
          where: { id: matchedJob.id },
          data:  { status: statusUpdate as any },
        }).catch(() => {})

        await db.activity.create({
          data: {
            userId, jobId: matchedJob.id, type: 'agent_action',
            text:  `[Gmail] ${matchedJob.company} · ${matchedJob.role}：收到${classification === 'interview' ? '面试邀请' : classification === 'offer' ? 'Offer' : '拒信'}`,
            color: classification === 'rejected' ? '#DC2626' : classification === 'offer' ? '#059669' : '#7C3AED',
          },
        }).catch(() => {})

        if (classification === 'interview') tally.interview++
        if (classification === 'offer')     tally.offer++

        if (classification === 'rejected') {
          tally.rejected++
          // Draft follow-up inquiry for rejection
          await draftRejectionFollowUp(
            matchedJob, subject, msg.snippet, fromName, fromEmail,
            emit, userId, ctx,
          )
        }

        emit('agent_observation', {
          role:        'auditor',
          observation: `${classification === 'interview' ? '🎉 面试邀请' : classification === 'offer' ? '🏆 收到 Offer' : '❌ 拒信'} ← ${matchedJob.company} · ${matchedJob.role}`,
        })

      } catch { /* skip individual message errors */ }
    }
  } catch (e) {
    console.error('[audit/gmail-scan]', e)
  }

  return tally
}

// ── Rejection follow-up draft ─────────────────────────────────────────────────

async function draftRejectionFollowUp(
  job:       { id: string; company: string; role: string; url: string | null },
  subject:   string,
  snippet:   string,
  fromName:  string,
  fromEmail: string,
  emit:      PipelineCtx['emit'],
  userId:    string,
  ctx:       PipelineCtx,
): Promise<void> {
  if (!fromEmail) return

  try {
    const prompt = `Write a gracious, professional reply to a job rejection email.

Company: ${job.company}
Role: ${job.role}
Original subject: ${subject}
From: ${fromName} <${fromEmail}>
Email snippet: ${snippet.slice(0, 300)}

Write a reply that:
1. Thanks them graciously for their time and consideration
2. Expresses genuine interest in future opportunities at the company
3. Optionally asks for brief feedback to improve future applications (politely, 1 sentence)
4. Is 3-4 sentences maximum, warm but professional

Return ONLY the email body text (no subject line, no headers).`

    const result = await modelChat(
      [{ role: 'user', content: prompt }],
      ctx.aiConfig,
      400,
    )

    const draft = result.text.trim()

    // Show to user for confirmation before sending
    emit('agent_question', {
      role:       'auditor',
      questionId: `rejection_reply_${job.id}`,
      question:   `收到来自 ${job.company} 的拒信（${job.role}）。已为你起草一封问询邮件，发送给 ${fromEmail}。是否确认发送？\n\n---\n${draft}\n---`,
      options: [
        { label: '📤 确认发送此邮件', value: 'send',    action: { field: '_send_email', value: JSON.stringify({ to: fromEmail, draft, subject: `Re: ${subject}`, jobId: job.id }) } },
        { label: '✏ 去 Gmail 手动回复', value: 'manual'                                                                                                                              },
        { label: '✕ 不回复',            value: 'skip'                                                                                                                                },
      ],
    })

    // Save draft to activity log
    await db.activity.create({
      data: {
        userId, jobId: job.id, type: 'agent_action',
        text:  `[草稿] ${job.company} 拒信问询邮件已起草，待你确认发送`,
        color: '#7C3AED',
      },
    }).catch(() => {})

  } catch (e) {
    console.error('[audit/draft-rejection-reply]', e)
  }
}
