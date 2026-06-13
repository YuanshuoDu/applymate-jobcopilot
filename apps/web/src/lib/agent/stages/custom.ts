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
import type { PipelineCtx } from '../types'

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
): Promise<void> {
  const { emit, userId } = ctx

  const customAgents = await db.customAgentRole.findMany({
    where: { userId, insertAfter: afterStage, enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  }) as CustomAgentRow[]

  if (customAgents.length === 0) return
  if (jobs.length === 0) return

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

    const observations: string[] = []
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

        const observation = result.text.trim().slice(0, 200)
        observations.push(observation)
        processed++

        emit('agent_observation', {
          role:        roleKey,
          observation: observation || '（无输出）',
        })

        // Write to activity log
        await db.activity.create({
          data: {
            userId,
            jobId: job.id,
            type:  'agent_action',
            text:  `[${agent.name}] ${job.company} · ${job.role}: ${observation.slice(0, 120)}`,
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
  }
}

function buildCustomPrompt(agent: CustomAgentRow, job: Job): string {
  return `Analyze this job for the user.

Job: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `Description: ${job.description.slice(0, 800)}` : ''}
Current score: ${job.score ?? 'not scored'}

${agent.description ? `Your focus: ${agent.description}` : 'Provide a brief, actionable insight about this job.'}

Respond in 1-2 sentences. Be specific and actionable.`
}
