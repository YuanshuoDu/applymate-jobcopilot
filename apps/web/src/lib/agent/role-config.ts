/**
 * Agent Role Config — DB helpers
 * Ensures every user has exactly 6 AgentRole rows (one per role),
 * provides typed accessors used by the pipeline and API routes.
 */
import { db } from '@/lib/db'
import type { RoleConfigMap } from './types'
import type { AiConfig, Provider } from '@/lib/model-router'

export type AgentRoleType = 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'

export const AGENT_ROLES: AgentRoleType[] = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']

export const ROLE_DEFAULTS: Record<AgentRoleType, { provider: string; model: string }> = {
  scout:    { provider: 'minimax', model: 'MiniMax-M3' },
  analyst:  { provider: 'minimax', model: 'MiniMax-M3' },
  writer:   { provider: 'minimax', model: 'MiniMax-M3' },
  reviewer: { provider: 'minimax', model: 'MiniMax-M3' },
  executor: { provider: 'minimax', model: 'MiniMax-M3' },
  auditor:  { provider: 'minimax', model: 'MiniMax-M3' },
}

const LEGACY_ROLE_DEFAULTS: Record<AgentRoleType, { provider: string; model: string }> = {
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
    `You are a quality assurance agent and career insights analyst. Never invent, strengthen, or silently approve candidate facts.
When reviewing a resume or application package, distinguish verified facts from items that require the candidate's confirmation. Do not call a claim false unless there is direct contradictory evidence; instead flag it as “needs confirmation” and explain what evidence to retain. Check factual consistency (names, dates, qualifications, employers, metrics), unsupported absolute claims, contact accuracy, duplicates, and missing context.
After verifying all operations completed correctly, generate actionable insights:
- What skills appear most frequently in the 'missing' list across analyzed jobs?
- Which job types have the highest match rate with this candidate's profile?
- What is the most impactful change the candidate could make to their resume?
Be specific and data-driven in your recommendations.`,
}

export const ROLE_META: Record<AgentRoleType, { icon: string; label: string; description: string }> = {
  scout:    { icon: '🔍', label: 'Scout', description: 'Filter job candidates: exclude, deduplicate, prioritize companies, and enforce the daily cap' },
  analyst:  { icon: '🤖', label: 'Analyst', description: 'Score resume-to-job fit with AI and extract matched and missing keywords' },
  writer:   { icon: '✍️', label: 'Writer', description: 'Generate cover letters and tailor resume keywords' },
  reviewer: { icon: '🔎', label: 'Reviewer', description: 'Route applications according to the auto-apply, pending-review, and skip rules' },
  executor: { icon: '🚀', label: 'Executor', description: 'Update the database application status and write activity logs' },
  auditor:  { icon: '✅', label: 'Auditor', description: 'Verify database state and generate the final run report' },
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

const PROVIDERS = new Set<Provider>(['anthropic', 'openai', 'deepseek', 'minimax', 'qwen', 'zhipu', 'kimi', 'custom'])

/**
 * Resolves a per-role override without bypassing the user's feature-level AI
 * setting or ApplyMate's MiniMax platform default. Legacy, keyless Claude
 * defaults are treated as platform defaults rather than failed overrides.
 */
export function roleAiConfig(
  role: AgentRoleType,
  config: RoleConfigMap[AgentRoleType] | undefined,
  fallback: AiConfig,
): AiConfig {
  if (!config?.enabled || !PROVIDERS.has(config.provider as Provider)) return fallback

  const legacy = LEGACY_ROLE_DEFAULTS[role]
  const isLegacyDefault = !config.apiKey
    && config.provider === legacy.provider
    && config.model === legacy.model
  const isRetiredPlatformDefault = !config.apiKey
    && config.provider === 'minimax'
    && config.model === 'MiniMax-M2.7'
  const isCurrentPlatformDefault = !config.apiKey
    && config.provider === 'minimax'
    && config.model === 'MiniMax-M3'
  if (isLegacyDefault || isRetiredPlatformDefault || isCurrentPlatformDefault) return fallback

  const provider = config.provider as Provider
  if (provider === fallback.provider) {
    return { ...fallback, model: config.model, apiKey: config.apiKey ?? fallback.apiKey }
  }
  return { provider, model: config.model, ...(config.apiKey ? { apiKey: config.apiKey } : {}) }
}

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
