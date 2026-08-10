import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { sanitizeUserPreferences } from '@/lib/settings-preferences'
import { sanitizeExportValue } from '@/lib/export-sanitizer'

// Keep the export useful for GDPR portability while excluding password, OAuth
// tokens, provider API keys, and other server-only credentials.
const USER_EXPORT_SELECT = {
  id: true, email: true, name: true, image: true, phone: true, location: true, linkedin: true, github: true,
  preferences: true, personaFields: true, personaFacts: true, personaEvidenceChunks: true,
  onboardingGoals: true, onboardedAt: true, defaultTemplateId: true, defaultAccentColor: true,
  defaultFontFamily: true, aiAutoPilot: true,
  accounts: { select: { provider: true, providerAccountId: true, type: true, scope: true } },
  apiKeys: { select: {
    adzunaAppId: true, adzunaAppIdEnc: true,
    adzunaAppKey: true, adzunaAppKeyEnc: true,
    rapidapiKey: true, rapidapiKeyEnc: true,
    createdAt: true, updatedAt: true,
  } },
  resumes: { select: { id: true, name: true, content: true, templateId: true, templateOptions: true, isDefault: true, kind: true, targetJobId: true, origin: true, createdAt: true, updatedAt: true } },
  resumeVersions: { select: { id: true, resumeId: true, content: true, name: true, createdAt: true } },
  jobs: { select: { id: true, company: true, logo: true, role: true, location: true, status: true, score: true, url: true, description: true, salary: true, source: true, notes: true, coverLetter: true, analysisNote: true, keywords: true, appliedAt: true, followUpAt: true, workflowState: true, createdAt: true, updatedAt: true, finalResumeId: true, finalCoverLetterId: true } },
  coverLetters: { select: { id: true, jobId: true, resumeId: true, content: true, tone: true, templateId: true, templateOptions: true, origin: true, isFinal: true, createdAt: true, updatedAt: true } },
  activities: { select: { id: true, jobId: true, type: true, text: true, color: true, createdAt: true } },
  directions: { select: { id: true, name: true, color: true, icon: true, sortOrder: true, createdAt: true, updatedAt: true } },
  notifications: { select: { id: true, type: true, title: true, body: true, read: true, jobId: true, createdAt: true } },
  applicationTasks: { select: { id: true, jobId: true, sessionId: true, status: true, checkpoint: true, question: true, sensitiveFlags: true, confirmedAnswers: true, resumeId: true, coverLetterId: true, error: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true } },
  agentConfig: { select: { isRunning: true, dailyLimit: true, minMatchScore: true, autoApply: true, requireApproval: true, targetLocations: true, targetRoles: true, excludeCompanies: true, priorityCompanies: true, autoCoverLetter: true, coverTone: true, useTailoredCV: true, salaryMin: true, salaryMax: true, notifyApply: true, notifyReject: true, weeklySummary: true, followUpReminder: true, followUpDays: true, model: true, createdAt: true, updatedAt: true } },
  agentRoles: { select: { id: true, role: true, enabled: true, provider: true, model: true, systemPrompt: true, lastRunAt: true, lastResult: true, totalRuns: true, createdAt: true, updatedAt: true } },
  customAgentRoles: { select: { id: true, name: true, icon: true, description: true, systemPrompt: true, provider: true, model: true, insertAfter: true, enabled: true, sortOrder: true, createdAt: true, updatedAt: true } },
  agentRunQuestions: { select: { id: true, runId: true, stage: true, question: true, options: true, answer: true, autonomous: true, createdAt: true, answeredAt: true } },
  agentRuns: { select: { id: true, status: true, durationMs: true, stagesCompleted: true, jobsFound: true, report: true, log: true, createdAt: true, updatedAt: true } },
  agentExecutions: { select: { id: true, sessionId: true, status: true, checkpoint: true, state: true, error: true, attemptCount: true, startedAt: true, completedAt: true, cancelledAt: true, createdAt: true, updatedAt: true } },
  agentSessions: { select: { id: true, goal: true, status: true, source: true, memorySummary: true, qualityScore: true, currentTaskId: true, completedAt: true, createdAt: true, updatedAt: true } },
  agentAutomations: { select: { id: true, name: true, enabled: true, triggerType: true, cron: true, timezone: true, targetRoles: true, targetLocations: true, minScore: true, dailyCap: true, requireApproval: true, autoApply: true, createdBy: true, lastRunAt: true, nextRunAt: true, createdAt: true, updatedAt: true } },
  gmailSyncState: { select: { lastSyncedAt: true, lastError: true, createdAt: true, updatedAt: true } },
  gmailMessages: { select: { id: true, gmailMessageId: true, gmailThreadId: true, kind: true, senderEmail: true, senderName: true, subject: true, excerpt: true, inferredCompany: true, inferredRole: true, receivedAt: true, scheduledAt: true, jobId: true, matchConfidence: true, manuallyLinked: true, processedAt: true, createdAt: true, updatedAt: true } },
  gmailRecommendations: { select: { id: true, sourceMessageId: true, platform: true, company: true, role: true, location: true, salary: true, url: true, description: true, status: true, savedJobId: true, createdAt: true, updatedAt: true } },
} satisfies Prisma.UserSelect

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({ where: { id: auth.userId }, select: USER_EXPORT_SELECT })
  if (!user) return err('User not found', 404)

  const { apiKeys, accounts, preferences, ...profile } = user
  const safeAccounts = (accounts ?? []).map(account => ({
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    type: account.type,
    scope: account.scope,
  }))
  const safeProfile = sanitizeExportValue({ ...profile, preferences: sanitizeUserPreferences(preferences) })
  const response = ok({
    exportedAt: new Date().toISOString(),
    profile: safeProfile,
    accounts: safeAccounts,
    apiKeys: {
      hasAdzuna: Boolean((apiKeys?.adzunaAppId || apiKeys?.adzunaAppIdEnc) && (apiKeys?.adzunaAppKey || apiKeys?.adzunaAppKeyEnc)),
      hasRapidapi: Boolean(apiKeys?.rapidapiKey || apiKeys?.rapidapiKeyEnc),
    },
  })
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('Content-Disposition', 'attachment; filename="applymate-data.json"')
  return response
}
