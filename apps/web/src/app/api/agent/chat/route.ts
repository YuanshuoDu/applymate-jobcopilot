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
import { appendTranscriptEvent, createAgentSession, updateAgentSession } from '@/lib/agent/session/repository'
import { runSubAgentTask } from '@/lib/agent/session/subagent-task-runner'
import { approvalRequestFrom, automationDraftFrom, resumeTailoringApprovalFrom } from './blocks'
import { correctedScoutPlan, createChatPlan, requestedMinMatchScore, requestsFullWorkflow, runChatWorker, scoutResultMatchesRequest, synthesizeChatResult, type ChatPlan, type ChatWorkerResult } from './chat-orchestrator'
import {
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
    await updateAgentSession(db, {
      sessionId: existing.id,
      status: 'running',
      completedAt: null,
    })
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
    db.job.findMany({ where: { userId: prep.userId }, orderBy: { updatedAt: 'desc' }, take: 15, select: { id: true, company: true, role: true, score: true, status: true, url: true } }),
    db.resume.findFirst({ where: { userId: prep.userId, isDefault: true }, select: { id: true, name: true } })
      ?? db.resume.findFirst({ where: { userId: prep.userId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true } }),
    db.activity.findFirst({ where: { userId: prep.userId, type: 'agent_action' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])

  const ctxData = {
    jobCount: jobs.length, savedCount: jobs.filter(j => j.status === 'saved').length,
    pendingCount: jobs.filter(j => j.status === 'review').length,
    config: agentCfg as Record<string, unknown> | null, resumeName: resume?.name ?? null,
    recentJobs: jobs.slice(0, 8).map(j => ({ company: j.company, role: j.role, score: j.score, status: j.status })),
    lastRunAt: lastActivity?.createdAt.toLocaleDateString('zh') ?? null,
  }


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
      const model = resolveRequestedModel(body, prep.cfg)
      const workflowRequested = requestsFullWorkflow(userMessage)
      if (workflowRequested) {
        const requestedScore = requestedMinMatchScore(userMessage)
        const thresholdText = requestedScore === null ? '当前配置的阈值' : `≥${requestedScore}%`
        const workflowBody = `已启动完整 Harness 工作流：Scout → Analyst → Writer → Reviewer → Executor → Auditor。将筛选匹配度 ${thresholdText} 的职位；任何外部投递仍会经过确认关卡。`
        send('action', { type: 'start_run', ...(requestedScore === null ? {} : { minMatchScore: requestedScore }) })
        send('block', { type: 'orchestrator_plan', speaker: 'Orchestrator', title: 'Full workflow', body: workflowBody, data: { workflow: true, minMatchScore: requestedScore } })
        await appendTranscriptEvent(db, {
          sessionId: session.id, type: 'orchestrator_plan', speaker: 'Orchestrator',
          title: 'Full workflow', body: workflowBody, data: { workflow: true, minMatchScore: requestedScore },
        })
        fullText = '工作流已经开始。Scout 会先查找或读取职位，Analyst 仅保留达到阈值的匹配，Writer 生成材料，Reviewer 审核后才交给 Executor；实际提交前会向你确认。'
        send('text', { delta: fullText })
        await appendTranscriptEvent(db, {
          sessionId: session.id, type: 'orchestrator_plan', speaker: 'Orchestrator', title: 'Response', body: fullText,
        })
        // The browser now starts the pipeline with this exact session ID. Its
        // recorder owns the terminal status so chat and pipeline never split
        // into two sessions.
        await updateAgentSession(db, {
          sessionId: session.id, status: 'running', memorySummary: responseMemory(fullText), completedAt: null,
        })
        send('done', {})
        return
      }

      let plan = await createChatPlan({
        userId: prep.userId,
        message: userMessage,
        config: agentCfg,
        jobs,
        model,
      })
      const planBody = `主 Agent 计划：只调用 ${plan.role} 子 Agent。目标：${plan.goal}`
      send('block', { type: 'orchestrator_plan', speaker: 'Orchestrator', title: 'Plan', body: planBody, data: { plan } })
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'orchestrator_plan',
        speaker: 'Orchestrator',
        title: 'Plan',
        body: planBody,
        data: { plan },
      })

      const dispatch = (assignedPlan: ChatPlan) => runSubAgentTask(db, {
        sessionId: session.id, role: assignedPlan.role, taskType: 'chat_request', goal: assignedPlan.goal,
        constraints: ['Work only on the assigned specialty.', 'Use only the supplied user context and connected sources.'],
        successCriteria: ['Return a concise, structured result for the orchestrator.'],
        allowedActions: assignedPlan.role === 'scout' ? ['live_job_search', 'read_context'] : ['read_context', 'generate_result'],
        context: { userMessage, jobs: ctxData.recentJobs }, expectedOutputSchema: { type: 'object', required: ['summary', 'result'] },
      }, async () => {
        const worker = await runChatWorker({ userId: prep.userId, message: userMessage, config: agentCfg, jobs, model }, assignedPlan)
        return {
          result: worker,
          confidence: worker.confidence,
          summary: worker.summary,
        }
      })
      send('block', { type: 'subagent_task_started', speaker: plan.role, title: 'Task started', body: plan.goal, data: { role: plan.role } })
      let task = await dispatch(plan)

      let worker: ChatWorkerResult = task.status === 'passed' && task.result && typeof task.result === 'object'
        ? task.result as ChatWorkerResult
        : { role: plan.role, summary: task.failureReason ?? 'The assigned subagent could not finish.', result: { jobs: [] }, confidence: 0 }
      if (plan.role === 'scout' && task.status === 'passed' && !scoutResultMatchesRequest(userMessage, worker)) {
        plan = correctedScoutPlan(userMessage, plan)
        const correction = `Scout returned roles that do not match the request. Correcting the search target to: ${plan.targetRoles.join(', ')}.`
        send('block', { type: 'quality_gate', speaker: 'Orchestrator', title: 'Result mismatch', body: correction, data: { status: 'failed', retryRecommended: true } })
        await appendTranscriptEvent(db, { sessionId: session.id, type: 'quality_gate', speaker: 'Orchestrator', title: 'Result mismatch', body: correction, data: { status: 'failed', retryRecommended: true } })
        send('block', { type: 'subagent_task_started', speaker: 'scout', title: 'Corrected retry', body: plan.goal, data: { role: 'scout' } })
        task = await dispatch(plan)
        worker = task.status === 'passed' && task.result && typeof task.result === 'object'
          ? task.result as ChatWorkerResult
          : { role: 'scout', summary: task.failureReason ?? 'The corrected search could not finish.', result: { jobs: [] }, confidence: 0 }
      }
      send('block', { type: 'subagent_result', speaker: plan.role, title: 'Task completed', body: worker.summary, data: worker })
      const jobRows = Array.isArray(worker.result.jobs) ? worker.result.jobs : []
      if (jobRows.length > 0) {
        send('block', { type: 'job_results', speaker: plan.role, title: 'Structured results', body: '子 Agent 返回的结构化结果', data: { jobs: jobRows } })
        await appendTranscriptEvent(db, {
          sessionId: session.id,
          type: 'job_results',
          speaker: plan.role === 'scout' ? 'Scout' : 'Analyst',
          title: 'Structured results',
          body: '子 Agent 返回的结构化结果',
          data: { jobs: jobRows },
        })
      }
      fullText = await synthesizeChatResult({ userId: prep.userId, message: userMessage, config: agentCfg, jobs, model }, plan, worker)
      send('text', { delta: fullText })
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

    const approvalDraft = resumeTailoringApprovalFrom(userMessage, {
      resumeId: resume?.id ?? null,
      jobs: jobs.map(job => ({ id: job.id, company: job.company, role: job.role })),
    }) ?? approvalRequestFrom(userMessage, ctxData)
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

    if (fullText) {
      await appendTranscriptEvent(db, {
        sessionId: session.id,
        type: 'orchestrator_plan',
        speaker: 'Orchestrator',
        title: 'Response',
        body: fullText,
      })
    }
    await updateAgentSession(db, {
      sessionId: session.id,
      status: approvalDraft || automationDraft ? 'waiting_for_user' : 'completed',
      memorySummary: responseMemory(fullText),
      completedAt: approvalDraft || automationDraft ? null : new Date(),
    })
    send('done', {})
  })
}
