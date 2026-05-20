/**
 * POST /api/gmail/ai-reply
 * Body: { emailBody, subject, senderName, senderEmail, tag }
 * Returns: { reply, hrEmail, hrName }
 *
 * Generates a professional follow-up reply to a job-related email.
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, err, ok } from '@/lib/api-helpers'
import { modelChat } from '@/lib/model-router'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'coverLetter')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { emailBody, subject, senderName, senderEmail, tag, jobId } = body as {
    emailBody:   string
    subject:     string
    senderName:  string
    senderEmail: string
    tag:         string
    jobId?:      string
  }

  if (!subject && !emailBody) return err('subject or emailBody is required')

  const contextHints: Record<string, string> = {
    interview: 'The sender has invited me to an interview or wants to schedule a call. I want to confirm availability and express enthusiasm.',
    offer:     'I received a job offer. I want to express gratitude, enthusiasm, and ask about next steps.',
    rejected:  'I received a rejection. I want to respond graciously, thank them for their consideration, and optionally ask for feedback.',
    review:    'My application is under review. I want to politely follow up on my application status.',
    received:  'My application was acknowledged. I want to follow up and reiterate my strong interest in the position.',
    viewed:    'My profile was viewed. I want to proactively reach out and express interest.',
  }
  const context = contextHints[tag] ?? 'This is a job-related email. I want to send a professional follow-up reply.'

  const prompt = `You are a professional job application assistant. Write a concise, professional reply email.

Context: ${context}

Original email:
From: ${senderName} <${senderEmail}>
Subject: ${subject}
Body:
${(emailBody ?? '').slice(0, 2000)}

Instructions:
- Write ONLY the email body (no Subject: line, no headers)
- Start with an appropriate greeting (e.g., "Dear ${senderName || 'Hiring Manager'},")
- Keep it to 2–3 short paragraphs, professional and warm
- End with a sign-off (e.g., "Best regards,") but leave name blank for the user to fill
- If the original email is not in English, reply in the same language
- Do NOT include placeholder text like [Your Name] or [Position]

Write the reply now:`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], prep.cfg, 600)
    const reply  = result.text.trim()

    // Log this reply action so Auditor won't draft a duplicate follow-up
    if (jobId) {
      await db.activity.create({
        data: {
          userId: prep.userId,
          jobId,
          type:   'agent_action',
          text:   `[Gmail] 已为 ${tag} 邮件起草回复（发送至 ${senderEmail}）`,
          color:  '#7C3AED',
        },
      }).catch(() => {})
    }

    return ok({ reply, hrEmail: senderEmail, hrName: senderName })
  } catch (e) {
    console.error('[gmail/ai-reply] error:', e)
    return err('Failed to generate reply', 500)
  }
}
