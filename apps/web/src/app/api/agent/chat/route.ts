/**
 * POST /api/agent/chat
 *
 * Returns SSE:
 *   event: text   data: { delta: "..." }   — streaming text token
 *   event: action data: { type, ...params } — action to execute on client
 *   event: done   data: {}
 * Actions the orchestrator can trigger:
 *   start_run                     — launch the pipeline
 *   update_config  field  value   — change a pipeline setting
 *   navigate       path           — navigate to a page
 */
import { NextRequest }                                from 'next/server'
import type { Prisma }                                from '@prisma/client'
import { db }                                          from '@/lib/db'
import { prepareAiRoute, sseResponse, err }             from '@/lib/api-helpers'
import { modelChatStream } from '@/lib/model-router'
import { appendTranscriptEvent, createAgentSession, updateAgentSession } from '@/lib/agent/session/repository'
import { approvalRequestFrom, automationDraftFrom } from './blocks'
import {
  SYSTEM_PROMPT,
  agentActionFromText,
  latestUserMessage,
  readChatMessages,
  readSessionId,
  resolveRequestedModel,
  responseMemory,
  sessionGoalFrom,
  type ChatRequestBody,
} from './route-helpers'

async function resolveChatSession(userId: string, body: ChatRequestBody, goal: string) {
  const sessionId = readSessionId(body)
  if (sessionId) {
    const existing = await db.agentSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    })
    if (!existing) return err('Session not found', 404)
    return { id: existing.id, created: false }
  }

  const created = await createAgentSession(db, {
    userId,
    goal: sessionGoalFrom(goal),
    source: 'chat',
  }) as { id: string }
  return { id: created.id, created: true }
}

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'agent')
  if ('error' in prep) return prep.error

  const body = (await req.json().catch(() => null)) as ChatRequestBody | null
  if (!body) return new Response('Missing messages', { status: 400 })

  const bodyMessages = readChatMessages(body)
  if (!bodyMessages) return new Response('Missing messages', { status: 400 })

  const userMessage = latestUserMessage(bodyMessages)
  const session = await resolveChatSession(prep.userId, body, userMessage)
  if (session instanceof Response) return session

  const [agentCfg, jobs, resume, lastActivity] = await Promise.all([
    db.agentConfig.findUnique({ where: { userId: prep.userId } }),
    db.job.findMany({ where: { userId: prep.userId }, orderBy: { updatedAt: 'desc' }, take: 15, select: { id: true, company: true, role: true, score: true, status: true } }),
    db.resume.findFirst({ where: { userId: prep.userId, isDefault: true }, select: { name: true } })
      ?? db.resume.findFirst({ where: { userId: prep.userId }, orderBy: { createdAt: 'desc' }, select: { name: true } }),
    db.activity.findFirst({ where: { userId: prep.userId, type: 'agent_action' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])

  const ctxData = {
    jobCount: jobs.length, savedCount: jobs.filter(j => j.status === 'saved').length,
    pendingCount: jobs.filter(j => j.status === 'review').length,
    config: agentCfg as Record<string, unknown> | null, resumeName: resume?.name ?? null,
    recentJobs: jobs.slice(0, 8).map(j => ({ company: j.company, role: j.role, score: j.score, status: j.status })),
    lastRunAt: lastActivity?.createdAt.toLocaleDateString('zh') ?? null,
  }

  const messages = [{ role: 'system' as const, content: SYSTEM_PROMPT(ctxData) }, ...bodyMessages]

  if (userMessage) {
    await appendTranscriptEvent(db, {
      sessionId: session.id,
      type: 'user_message',
      speaker: 'You',
      title: 'Message',
      body: userMessage,
    })
  }

  return sseResponse(async send => {
    send('session', { sessionId: session.id, created: session.created })

    let fullText = ''
    try {
      for await (const delta of modelChatStream(messages, resolveRequestedModel(body, prep.cfg), 4096)) {
        fullText += delta
        send('text', { delta })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent chat failed.'
      send('error', { message })
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'error',
        speaker: 'System',
        title: 'Chat failed',
        body: message,
        data: { reason: 'model_stream_error' },
      })
      await updateAgentSession(db, {
        sessionId: session.id,
        status: 'failed',
        memorySummary: responseMemory(message),
      })
      return
    }

    const automationDraft = automationDraftFrom(userMessage)
    if (automationDraft) {
      const body = 'I drafted an automation from your request. Please confirm before I save it.'
      send('block', { type: 'automation_draft', draft: automationDraft })
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'automation_draft',
        speaker: 'Orchestrator',
        title: 'Automation draft',
        body,
        data: { draft: automationDraft },
      })
    }

    const approvalDraft = approvalRequestFrom(userMessage, ctxData)
    if (approvalDraft) {
      const approval = await db.agentApproval.create({
        data: {
          sessionId: session.id,
          userId: prep.userId,
          type: approvalDraft.type,
          status: 'pending',
          title: approvalDraft.title,
          body: approvalDraft.body,
          impact: approvalDraft.impact as Prisma.InputJsonValue,
          payload: approvalDraft.payload as Prisma.InputJsonValue,
        },
      })
      const approvalPayload = { id: approval.id, ...approvalDraft, status: 'pending' }
      send('block', { type: 'approval_request', approval: approvalPayload })
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'approval_request',
        speaker: 'Executor',
        title: approvalDraft.title,
        body: approvalDraft.body,
        data: { approval: approvalPayload },
      })
    }

    const action = agentActionFromText(fullText)
    if (action) {
      const { command, ...clientAction } = action
      send('action', clientAction)
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'orchestrator_plan',
        speaker: 'Orchestrator',
        title: 'Action',
        body: `ACTION:${command}`,
        data: { action: command },
      })
    }

    const assistantText = fullText.replace(/^ACTION:.+$/gm, '').trim()
    if (assistantText) {
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'orchestrator_plan',
        speaker: 'Orchestrator',
        title: 'Response',
        body: assistantText,
      })
    }
    await updateAgentSession(db, {
      sessionId: session.id,
      status: 'running',
      memorySummary: responseMemory(fullText),
    })
    send('done', {})
  })
}
