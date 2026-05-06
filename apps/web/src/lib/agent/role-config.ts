/**
 * Agent Role Config — DB helpers
 * Ensures every user has exactly 6 AgentRole rows (one per role),
 * provides typed accessors used by the pipeline and API routes.
 */
import { db } from '@/lib/db'
import type { RoleConfigMap } from './types'

export type AgentRoleType = 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'

export const AGENT_ROLES: AgentRoleType[] = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']

export const ROLE_DEFAULTS: Record<AgentRoleType, { provider: string; model: string }> = {
  scout:    { provider: 'anthropic', model: 'claude-haiku-4-5'  },
  analyst:  { provider: 'anthropic', model: 'claude-haiku-4-5'  },
  writer:   { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  executor: { provider: 'anthropic', model: 'claude-haiku-4-5'  },
  auditor:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
}

export const DEFAULT_SYSTEM_PROMPTS: Record<AgentRoleType, string> = {
  scout:
    `You are a job discovery specialist. Your task is to filter and prioritize job candidates.
Focus on: role alignment with the candidate's background, location match, and company reputation.
Prioritize companies that are known for strong engineering culture and growth opportunities.
Always explain briefly why you include or exclude a job.`,

  analyst:
    `You are an expert ATS analyst and career coach. Your task is to score resume-job fit precisely.
When scoring, consider: technical skills match (40%), relevant experience (30%), domain knowledge (20%), soft skills (10%).
Be specific about what skills are missing and why they matter for this role.
Your recommendation should be ONE actionable sentence the candidate can act on immediately.
Score 90-100: exceptional fit. 75-89: strong fit. 60-74: moderate fit. Below 60: weak fit.`,

  writer:
    `You are an expert cover letter writer with deep knowledge of European hiring practices.
Write cover letters that: open with a compelling hook (not "I am writing to apply"), highlight 2-3 specific achievements with metrics,
show genuine interest in the company's mission, and end with a confident call to action.
Match the tone to the company culture — formal for banks/consulting, energetic for startups.
Never use generic phrases like "I am a hard worker" or "team player".
Length: 220-280 words.`,

  reviewer:
    `You are a hiring strategy advisor. Evaluate whether an application package is ready to submit.
Consider: Is the cover letter specific enough? Does the score justify applying? Is this company on the priority or exclude list?
For borderline scores (65-75%), recommend manual review so the candidate can decide.
Always explain your routing decision briefly.`,

  executor:
    `You are an application workflow manager. Record each application accurately and create meaningful activity log entries.
Include in activity notes: the match score, key matched skills, and any tailoring done.
This data will help the candidate track their application pipeline.`,

  auditor:
    `You are a quality assurance agent and career insights analyst.
After verifying all operations completed correctly, generate actionable insights:
- What skills appear most frequently in the 'missing' list across analyzed jobs?
- Which job types have the highest match rate with this candidate's profile?
- What is the most impactful change the candidate could make to their resume?
Be specific and data-driven in your recommendations.`,
}

export const ROLE_META: Record<AgentRoleType, { icon: string; label: string; zh: string; description: string }> = {
  scout:    { icon: '🔍', label: 'Scout',    zh: '侦察员', description: '过滤候选职位：排除、去重、优先公司、每日上限' },
  analyst:  { icon: '🤖', label: 'Analyst',  zh: '分析员', description: 'AI 评分 resume↔JD，提取匹配/缺失关键词' },
  writer:   { icon: '✍️', label: 'Writer',   zh: '撰写员', description: '生成求职信，定制简历关键词' },
  reviewer: { icon: '🔎', label: 'Reviewer', zh: '审核员', description: '按规则分流：auto-apply / pending-review / skip' },
  executor: { icon: '🚀', label: 'Executor', zh: '执行员', description: '更新 DB job.status=applied，写 Activity 日志' },
  auditor:  { icon: '✅', label: 'Auditor',  zh: '验收员', description: '验证 DB 状态，生成最终运行报告' },
}

export interface AgentRoleConfig {
  id:           string
  userId:       string
  role:         AgentRoleType
  enabled:      boolean
  provider:     string
  model:        string
  apiKey:       string | null
  systemPrompt: string | null
  lastRunAt:    Date | null
  lastResult:   { count: number; durationMs: number; summary: string } | null
  totalRuns:    number
  createdAt:    Date
  updatedAt:    Date
}

export type { RoleConfigMap }

/** Load all 6 role configs for a user, creating defaults for any missing ones. */
export async function loadRoleConfigs(userId: string): Promise<AgentRoleConfig[]> {
  const existing = await db.agentRole.findMany({ where: { userId } })
  const existingRoles = new Set(existing.map(r => r.role as AgentRoleType))

  // Create missing roles with defaults
  const missing = AGENT_ROLES.filter(r => !existingRoles.has(r))
  if (missing.length > 0) {
    await db.agentRole.createMany({
      data: missing.map(role => ({
        userId,
        role,
        enabled:      true,
        provider:     ROLE_DEFAULTS[role].provider,
        model:        ROLE_DEFAULTS[role].model,
        systemPrompt: DEFAULT_SYSTEM_PROMPTS[role],
      })),
    })
    return db.agentRole.findMany({ where: { userId }, orderBy: { role: 'asc' } }) as Promise<AgentRoleConfig[]>
  }

  return existing as AgentRoleConfig[]
}

/** Convert array of AgentRoleConfig to a keyed map for pipeline use. */
export function toRoleConfigMap(roles: AgentRoleConfig[]): RoleConfigMap {
  const map = {} as RoleConfigMap
  for (const role of AGENT_ROLES) {
    const cfg = roles.find(r => r.role === role)
    map[role] = {
      provider:     cfg?.provider     ?? ROLE_DEFAULTS[role].provider,
      model:        cfg?.model        ?? ROLE_DEFAULTS[role].model,
      apiKey:       cfg?.apiKey       ?? undefined,
      enabled:      cfg?.enabled      ?? true,
      systemPrompt: cfg?.systemPrompt ?? DEFAULT_SYSTEM_PROMPTS[role],
    }
  }
  return map
}

/** Upsert a single role config. */
export async function upsertRoleConfig(
  userId: string,
  role:   AgentRoleType,
  data:   Partial<Pick<AgentRoleConfig, 'enabled' | 'provider' | 'model' | 'apiKey' | 'systemPrompt'>>,
): Promise<AgentRoleConfig> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.agentRole.upsert({
    where:  { userId_role: { userId, role } },
    create: { userId, role, ...ROLE_DEFAULTS[role], ...data } as any,
    update: data as any,
  }) as unknown as Promise<AgentRoleConfig>
}

/** Record run result on a role (called after each stage completes). */
export async function recordRoleRun(
  userId:   string,
  role:     AgentRoleType,
  result:   { count: number; durationMs: number; summary: string },
): Promise<void> {
  await db.agentRole.updateMany({
    where: { userId, role },
    data:  {
      lastRunAt:  new Date(),
      lastResult: result as object,
      totalRuns:  { increment: 1 },
    },
  })
}
