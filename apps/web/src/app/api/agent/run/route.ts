/**
 * GET /api/agent/run
 *
 * Server-Sent Events stream. Scores all "saved" jobs for the user against
 * their default resume using Claude Haiku, optionally auto-applies jobs that
 * meet the configured threshold, and streams progress events to the client.
 *
 * Event types:
 *   start     — { total, resumeName }
 *   job_start — { jobId, company, role }
 *   job_done  — { jobId, company, role, score, autoApplied, recommendation, matchedKeywords, missingKeywords }
 *   job_skip  — { jobId, company, role, reason }
 *   job_error — { jobId, company, role, error }
 *   info      — { message }
 *   done      — { processed, applied, skipped }
 *   error     — { message }
 */
import { NextRequest } from 'next/server'
import Anthropic        from '@anthropic-ai/sdk'
import { db }           from '@/lib/db'
import { requireAuth, isErrorResponse } from '@/lib/api-helpers'
import type { ResumeContent }           from '@/lib/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Helpers ───────────────────────────────────────────────────────────────────

function resumeToText(r: ResumeContent): string {
  const lines: string[] = []
  if (r.contact?.name) lines.push(`Name: ${r.contact.name}`)
  if (r.summary)        lines.push(`\nSUMMARY:\n${r.summary}`)
  if (r.skills?.length) lines.push(`\nSKILLS: ${r.skills.join(', ')}`)
  if (r.experience?.length) {
    lines.push('\nEXPERIENCE:')
    for (const e of r.experience) {
      lines.push(`${e.role} at ${e.company} (${e.period})`)
      for (const b of (e.bullets ?? [])) lines.push(`  • ${b}`)
    }
  }
  if (r.education?.length) {
    lines.push('\nEDUCATION:')
    for (const e of r.education) lines.push(`${e.degree} — ${e.institution} (${e.year})`)
  }
  return lines.join('\n')
}

function scoreColor(s: number) {
  if (s >= 80) return '#3B6D11'
  if (s >= 60) return '#854F0B'
  return '#6B7280'
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        } catch { /* stream closed */ }
      }

      try {
        // ── 1. Guard: agent must be running ──
        const agentCfg = await db.agentConfig.findUnique({ where: { userId: auth.userId } })

        if (!agentCfg) {
          send('error', { message: 'Agent not configured. Save settings first.' })
          controller.close()
          return
        }

        // ── 2. Load default resume ──
        const resume =
          await db.resume.findFirst({ where: { userId: auth.userId, isDefault: true } }) ??
          await db.resume.findFirst({ where: { userId: auth.userId }, orderBy: { createdAt: 'desc' } })

        if (!resume) {
          send('error', { message: 'No resume found. Create a resume in the Resume tab first.' })
          controller.close()
          return
        }

        // ── 3. Load saved jobs ──
        const savedJobs = await db.job.findMany({
          where:   { userId: auth.userId, status: 'saved' },
          orderBy: { createdAt: 'desc' },
          take:    Math.min(agentCfg.dailyLimit, 30), // respect daily limit
        })

        if (savedJobs.length === 0) {
          send('info', { message: 'No saved jobs to process. Use the Chrome Extension or Add Job to save positions first.' })
          send('done', { processed: 0, applied: 0, skipped: 0 })
          controller.close()
          return
        }

        send('start', { total: savedJobs.length, resumeName: resume.name })

        const content = resume.content as unknown as ResumeContent
        const resumeText = resumeToText(content).slice(0, 2500)

        let processed = 0
        let applied   = 0
        let skipped   = 0

        // ── 4. Process each job ──
        for (const job of savedJobs) {
          send('job_start', { jobId: job.id, company: job.company, role: job.role })

          // Skip jobs that have no description and no role context
          if (!job.description && !job.role) {
            send('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'No job description available' })
            skipped++
            continue
          }

          try {
            const prompt = `You are an expert ATS analyzer. Score this resume against this job posting.
Return ONLY valid JSON — no markdown, no preamble.

RESUME:
${resumeText}

JOB: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `DESCRIPTION:\n${job.description.slice(0, 1200)}` : ''}

JSON format:
{
  "score": <integer 0-100>,
  "matchedKeywords": [<up to 6 strings>],
  "missingKeywords": [<up to 4 strings>],
  "recommendation": "<one actionable sentence to improve this application>"
}`

            const message = await anthropic.messages.create({
              model:     'claude-haiku-4-5-20251001', // fast + cheap for batch
              max_tokens: 512,
              messages:  [{ role: 'user', content: prompt }],
            })

            const raw    = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
            const json   = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
            const result = JSON.parse(json)
            const score: number = Math.min(100, Math.max(0, Number(result.score) || 0))

            // Persist score to job record
            await db.job.update({ where: { id: job.id }, data: { score } })

            // Log agent action
            await db.activity.create({
              data: {
                userId: auth.userId,
                jobId:  job.id,
                type:   'agent_action',
                text:   `Agent scored ${job.company} · ${job.role}: ${score}% match`,
                color:  scoreColor(score),
              },
            })

            // Auto-apply if configured and score is above threshold
            let autoApplied = false
            if (
              agentCfg.autoApply &&
              !agentCfg.requireApproval &&
              score >= agentCfg.minMatchScore
            ) {
              await db.job.update({
                where: { id: job.id },
                data:  { status: 'applied', appliedAt: new Date() },
              })
              await db.activity.create({
                data: {
                  userId: auth.userId,
                  jobId:  job.id,
                  type:   'applied',
                  text:   `Agent auto-applied to ${job.company} · ${job.role} (score: ${score}%)`,
                  color:  '#185FA5',
                },
              })
              autoApplied = true
              applied++
            }

            processed++
            send('job_done', {
              jobId:           job.id,
              company:         job.company,
              role:            job.role,
              score,
              autoApplied,
              recommendation:  result.recommendation ?? '',
              matchedKeywords: result.matchedKeywords ?? [],
              missingKeywords: result.missingKeywords ?? [],
            })
          } catch (e) {
            console.error('[agent/run] scoring error:', e)
            send('job_error', { jobId: job.id, company: job.company, role: job.role, error: 'AI scoring failed' })
          }

          // Throttle: 300ms between calls to avoid Anthropic rate limits
          await new Promise(r => setTimeout(r, 300))
        }

        send('done', { processed, applied, skipped })
      } catch (e) {
        console.error('[agent/run] fatal error:', e)
        send('error', { message: 'Agent run failed unexpectedly' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx buffering
    },
  })
}
