/**
 * Custom Agent Stage Runner
 *
 * Loads all enabled CustomAgentRoles with insertAfter === stageName,
 * then for each custom agent:
 *   1. Emits role_start / agent_plan
 *   2. Calls the AI model with the custom system prompt once per job
 *   3. Emits agent_action / agent_observation per job
 *   4. Emits agent_reflect / role_done
 *
 * Custom agents are advisory — they observe and comment but do NOT
 * modify job status (that's the executor's job). Their output is
 * logged as Activity entries for the user to review.
 */
import type { Job }       from '@prisma/client'
import { db }             from '@/lib/db'
import { modelChat }      from '@/lib/model-router'
import type { CustomAgentObservation, CustomAgentRunResult, PipelineCtx } from '../types'

interface CustomAgentRow {
  id:           string
  name:         string
  icon:         string
  description:  string | null
  systemPrompt: string | null
  provider:     string
  model:        string
  insertAfter:  string
  enabled:      boolean
}

export async function runCustomAgents(
  ctx:       PipelineCtx,
  jobs:      Job[],
  afterStage: string,
): Promise<CustomAgentRunResult[]> {
  const { emit, userId } = ctx

  const customAgents = await db.customAgentRole.findMany({
    where: { userId, insertAfter: afterStage, enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  }) as CustomAgentRow[]

  if (customAgents.length === 0 || jobs.length === 0) return []
  const results: CustomAgentRunResult[] = []

  for (const agent of customAgents) {
    const roleKey = `custom_${agent.id}`
    const t0 = Date.now()

    // role_start
    emit('role_start', {
      role:  roleKey,
      label: agent.name,
      model: agent.model,
      icon:  agent.icon,
      custom: true,
    })

    emit('agent_plan', {
      role: roleKey,
      plan: `计划：对 ${jobs.length} 个职位运行自定义分析「${agent.name}」${agent.description ? `（${agent.description}）` : ''}`,
    })

    const observations: CustomAgentObservation[] = []
    let processed = 0

    for (const job of jobs) {
      emit('agent_action', {
        role:   roleKey,
        action: `分析 ${job.company} · ${job.role}`,
      })

      try {
        const prompt = buildCustomPrompt(agent, job)
        const messages = [
          ...(agent.systemPrompt ? [{ role: 'system' as const, content: agent.systemPrompt }] : []),
          { role: 'user' as const, content: prompt },
        ]

        const result = await modelChat(
          messages,
          { provider: agent.provider as any, model: agent.model },
          256,
        )

        const observation = parseCustomObservation(result.text, job)
        observations.push(observation)
        processed++

        emit('agent_observation', {
          role:        roleKey,
          observation: observation.summary || '（无输出）',
        })

        // Write to activity log
        await db.activity.create({
          data: {
            userId,
            jobId: job.id,
            type:  'agent_action',
            text:  `[${agent.name}] ${job.company} · ${job.role}: ${observation.summary.slice(0, 120)}`,
            color: '#7C3AED',
          },
        }).catch(() => {})

      } catch (err) {
        emit('agent_observation', {
          role:        roleKey,
          observation: `✗ 分析失败：AI 调用异常`,
        })
      }
    }

    const durationMs = Date.now() - t0
    const summary = `${processed}/${jobs.length} jobs analyzed`

    emit('agent_reflect', {
      role:    roleKey,
      reflect: `「${agent.name}」完成：分析了 ${processed} 个职位（耗时 ${(durationMs / 1000).toFixed(1)}s）`,
    })

    emit('role_done', {
      role:      roleKey,
      icon:      agent.icon,
      summary,
      count:     processed,
      durationMs,
      custom:    true,
    })
    const runResult = { agentId: agent.id, agentName: agent.name, afterStage, observations }
    results.push(runResult)
    emit('custom_agent_result', runResult)
  }
  return results
}

function buildCustomPrompt(agent: CustomAgentRow, job: Job): string {
  return `Analyze this job for the user.

Job: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `Description: ${job.description.slice(0, 800)}` : ''}
Current score: ${job.score ?? 'not scored'}

${agent.description ? `Your focus: ${agent.description}` : 'Provide a brief, actionable insight about this job.'}

Return ONLY JSON in this exact shape:
{"summary":"one concise factual observation","risks":["zero to three concrete risks"],"recommendation":"one actionable recommendation","confidence":0.0}

Do not invent company facts or candidate facts. Use confidence 0-1 and leave risks empty when unsupported.`
}

function parseCustomObservation(raw: string, job: Job): CustomAgentObservation {
  const fallback = {
    jobId: job.id,
    company: job.company,
    role: job.role,
    summary: raw.trim().slice(0, 200) || 'No structured observation returned.',
    risks: [],
    recommendation: '',
    confidence: 0,
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return fallback
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    return {
      ...fallback,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : fallback.summary,
      risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === 'string').slice(0, 3) : [],
      recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation.slice(0, 200) : '',
      confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0,
    }
  } catch {
    return fallback
  }
}

export function summarizeCustomAgentResults(results: CustomAgentRunResult[]) {
  const byJob = new Map<string, {
    jobId: string; company: string; role: string; confidence: number; risks: Set<string>; recommendations: Set<string>
  }>()
  for (const result of results) for (const observation of result.observations) {
    const existing = byJob.get(observation.jobId) ?? {
      jobId: observation.jobId, company: observation.company, role: observation.role,
      confidence: 0, risks: new Set<string>(), recommendations: new Set<string>(),
    }
    existing.confidence = Math.max(existing.confidence, observation.confidence)
    observation.risks.forEach(risk => existing.risks.add(risk))
    if (observation.recommendation) existing.recommendations.add(observation.recommendation)
    byJob.set(observation.jobId, existing)
  }
  return [...byJob.values()]
    .map(row => ({ ...row, risks: [...row.risks], recommendations: [...row.recommendations] }))
    .sort((a, b) => b.confidence - a.confidence || a.company.localeCompare(b.company))
}
