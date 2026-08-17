export interface AutomationDraft {
  name: string
  trigger: string
  triggerType: string
  cron: string | null
  timezone: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

export interface ApprovalRequestDraft {
  type: string
  title: string
  body: string
  impact: Record<string, string | number | boolean>
  payload: Record<string, unknown>
}

export function automationDraftFrom(text: string): AutomationDraft | null {
  const lower = text.toLowerCase()
  const asksAutomation = lower.includes('automation') || text.includes('automation') || text.includes('timing')
  if (!asksAutomation) return null
  const targetLocations = /berlin/i.test(text) ? ['Berlin'] : []
  const targetRoles = /\b(swe|software engineer)\b/i.test(text) || text.includes('software engineering') ? ['SWE'] : []
  const scoreMatch = text.match(/(\d{2,3})\s*(?:point|score|above|\+)/i)
  const minScore = scoreMatch ? Math.min(100, Math.max(0, Number(scoreMatch[1]))) : 85
  const triggerType = text.includes('every day') || lower.includes('daily') ? 'daily' : text.includes('working days') || lower.includes('weekday') ? 'weekdays' : 'manual'
  const hourMatch = text.match(/(?:Morning|morning|at\s*)?(\d{1,2})\s*(?:point|:00)/i)
  const hour = hourMatch ? Math.min(23, Math.max(0, Number(hourMatch[1]))) : 9
  return {
    name: `${targetLocations[0] ?? 'Job'} ${targetRoles[0] ?? 'search'} automation`,
    trigger: triggerType === 'manual' ? 'Manual' : `${triggerType === 'daily' ? 'Daily' : 'Weekdays'} ${String(hour).padStart(2, '0')}:00`,
    triggerType,
    cron: triggerType === 'manual' ? null : `0 ${hour} * * ${triggerType === 'weekdays' ? '1-5' : '*'}`,
    timezone: 'Europe/Berlin',
    targetRoles,
    targetLocations,
    minScore,
    dailyCap: 8,
    requireApproval: true,
    autoApply: true,
  }
}

export function approvalRequestFrom(
  text: string,
  context: { pendingCount: number; savedCount: number },
): ApprovalRequestDraft | null {
  const lower = text.toLowerCase()
  const asksApply = /apply|submit|approve/.test(lower) || text.includes('delivery') || text.includes('submit') || text.includes('approve')
  if (!asksApply) return null

  const requestedCount = countFrom(text) ?? Math.max(context.pendingCount, context.savedCount, 1)
  return {
    type: 'apply_jobs',
    title: 'Approval required',
    body: `Ready to continue with ${requestedCount} application${requestedCount === 1 ? '' : 's'}. Please approve before any external submission.`,
    impact: {
      applications: requestedCount,
      coverLetters: requestedCount,
      linkedinActions: false,
    },
    payload: {
      requestedCount,
      source: 'agent_chat',
      requireApproval: true,
    },
  }
}

export function resumeTailoringApprovalFrom(
  text: string,
  context: { resumeId: string | null; jobs: Array<{ id: string; company: string; role: string }> },
): ApprovalRequestDraft | null {
  const asksForTailoring = /tailor|tailored|optim(?:ize|ized|ization).*\b(?:resume|CV)\b|custom(?:ize|ized|ization).*\b(?:resume|CV)\b|revise.*\b(?:resume|CV)\b/i.test(text)
  if (!asksForTailoring || !context.resumeId) return null
  const lower = text.toLowerCase()
  const explicitJob = context.jobs.find(job => lower.includes(job.company.toLowerCase()) || lower.includes(job.role.toLowerCase()))
  const job = explicitJob ?? (context.jobs.length === 1 ? context.jobs[0] : null)
  if (!job) return null
  return {
    type: 'tailor_resume',
    title: 'Apply AI resume changes',
    body: `Writer will tailor your resume for ${job.company} · ${job.role}, preserve truthful facts, keep the selected template, and create a reviewable version. Continue?`,
    impact: { resumeChanges: true, job: `${job.company} · ${job.role}`, externalSubmission: false },
    payload: { resumeId: context.resumeId, jobId: job.id, requireApproval: true },
  }
}

function countFrom(text: string): number | null {
  const match = text.match(/(\d{1,2})\s*(?:individual|share|applications?|jobs?|positions?)/i)
  if (!match) return null
  return Math.min(50, Math.max(1, Number(match[1])))
}
