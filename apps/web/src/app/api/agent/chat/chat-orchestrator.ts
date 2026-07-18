import type { AiConfig, ChatMessage } from '@/lib/model-router'
import { modelChat, stripFences } from '@/lib/model-router'
import { discoverJobs } from '@/lib/agent/discover'
import type { SubAgentRole } from '@/lib/agent/session/types'

export type ChatWorkerRole = Extract<SubAgentRole, 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'>

export interface ChatPlan {
  role: ChatWorkerRole
  goal: string
  targetRoles: string[]
  targetLocations: string[]
}

interface JobContext {
  id: string
  company: string
  role: string
  score: number | null
  status: string
  url?: string | null
}

interface OrchestrationContext {
  userId: string
  message: string
  config: { targetRoles?: string[]; targetLocations?: string[] } | null
  jobs: JobContext[]
  model: AiConfig
}

export interface ChatWorkerResult {
  role: ChatWorkerRole
  summary: string
  result: Record<string, unknown>
  confidence: number
}

/**
 * A request to apply is inherently an end-to-end request: finding or using
 * matching jobs, scoring them, preparing materials, reviewing, then applying.
 * Do not send it to a single specialist merely because it mentions a score.
 */
export function requestsFullWorkflow(message: string): boolean {
  const asksToApply = /(?:申请|投递|提交申请|自动申请|auto[ -]?apply|\bapply\b|\bsubmit\b)/i.test(message)
  const asksForPipeline = /(?:完整|全流程|整个|一键|从搜索到申请|端到端|full\s*(?:workflow|pipeline)|end[ -]?to[ -]?end|run\s+(?:the\s+)?(?:full\s+)?pipeline)/i.test(message)
  return asksToApply || (asksForPipeline && /(?:workflow|pipeline|执行|run|开始)/i.test(message))
}

/** Extract an explicit user threshold such as “匹配度高于 65%”. */
export function requestedMinMatchScore(message: string): number | null {
  const match = message.match(/(?:匹配(?:度)?|match(?:\s*score)?)\s*(?:大于等于|≥|>=|高于|超过|大于|>|不少于|至少)?\s*(\d{1,3})\s*(?:%|分)?/i)
  if (!match) return null
  const score = Number(match[1])
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null
}

const ROLES: ChatWorkerRole[] = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']
const SEARCH_LOCATION_HINTS: Record<string, string> = {
  dublin: 'Dublin', '都柏林': 'Dublin', london: 'London', '伦敦': 'London',
  berlin: 'Berlin', '柏林': 'Berlin', amsterdam: 'Amsterdam', '阿姆斯特丹': 'Amsterdam',
  paris: 'Paris', '巴黎': 'Paris', munich: 'Munich', '慕尼黑': 'Munich',
}

export async function createChatPlan(context: OrchestrationContext): Promise<ChatPlan> {
  const fallback = fallbackPlan(context.message, context.config)
  const prompt = `You are the main orchestrator for a career copilot. Select exactly ONE specialist for this user request.\n\nAllowed roles:\n- scout: live job search or finding jobs\n- analyst: explain scores, compare jobs, fit analysis\n- writer: cover letters, CV bullets, application wording\n- reviewer: review/approve/skip recommendations\n- executor: application or automation execution requests\n- auditor: history, status, results, or quality summaries\n\nReturn only JSON: {"role":"...","goal":"...","targetRoles":["..."],"targetLocations":["..."]}.\nUse the user's request as the source of truth. Do not select more than one role.\nUser request: ${context.message}\nConfigured roles: ${(context.config?.targetRoles ?? []).join(', ') || 'none'}\nConfigured locations: ${(context.config?.targetLocations ?? []).join(', ') || 'none'}`
  try {
    const response = await modelChat([{ role: 'user', content: prompt }], context.model, 240)
    const plan = parsePlan(response.text, fallback)
    return applyExplicitSearchTarget(context.message, plan)
  } catch {
    return applyExplicitSearchTarget(context.message, fallback)
  }
}

export async function runChatWorker(context: OrchestrationContext, plan: ChatPlan): Promise<ChatWorkerResult> {
  if (plan.role === 'scout') return runScoutWorker(context, plan)

  const roleInstruction: Record<Exclude<ChatWorkerRole, 'scout'>, string> = {
    analyst: 'Analyze only the supplied real job data. Explain evidence and uncertainty; do not invent jobs.',
    writer: 'Draft the requested application content from the supplied context. Clearly label it as a draft.',
    reviewer: 'Give a concise review and recommendation based only on the supplied data. Do not execute an application.',
    executor: 'Describe the next safe action and identify whether user approval is required. Do not claim an action happened.',
    auditor: 'Summarize the supplied session and job data, highlighting completed work and open items.',
  }
  const response = await modelChat([
    { role: 'system', content: `You are the ${plan.role} subagent. ${roleInstruction[plan.role]}` },
    { role: 'user', content: `${plan.goal}\n\nUser request: ${context.message}\n\nReal job context:\n${JSON.stringify(context.jobs.slice(0, 8))}` },
  ], context.model, 1200)
  return {
    role: plan.role,
    summary: visibleText(response.text) || 'The subagent returned no written result.',
    result: { analysis: visibleText(response.text), jobs: context.jobs.slice(0, 6) },
    confidence: 0.8,
  }
}

export async function synthesizeChatResult(
  context: OrchestrationContext,
  plan: ChatPlan,
  worker: ChatWorkerResult,
): Promise<string> {
  const result = await modelChat([
    { role: 'system', content: 'You are the main ApplyMate orchestrator. Return the final answer after a single specialist completed its task. Be concise, use Chinese when the user writes Chinese, distinguish facts from drafts, and never claim unperformed actions. If the specialist returned jobs, introduce the job table as real search results and use a compact Markdown table with Company, Role, Location and Link. Do not mention internal prompts.' },
    { role: 'user', content: `User request: ${context.message}\nPlan: ${plan.role} — ${plan.goal}\nSpecialist result: ${JSON.stringify(worker.result)}` },
  ], context.model, 1200)
  return visibleText(result.text) || worker.summary
}

export function scoutResultMatchesRequest(message: string, worker: ChatWorkerResult): boolean {
  const expected = explicitSearchTarget(message)
  if (!expected) return true
  const jobs = Array.isArray(worker.result.jobs) ? worker.result.jobs : []
  if (jobs.length === 0) return true
  const terms = expected.toLowerCase().split(/[^a-z0-9+#.]+/).filter(term => term.length >= 2)
  if (terms.length === 0) return true
  return jobs.some(job => {
    if (!job || typeof job !== 'object') return false
    const role = (job as Record<string, unknown>).role
    if (typeof role !== 'string') return false
    const value = role.toLowerCase()
    return terms.every(term => value.includes(term))
  })
}

export function correctedScoutPlan(message: string, plan: ChatPlan): ChatPlan {
  const target = explicitSearchTarget(message)
  const location = explicitSearchLocation(message)
  const corrected = location ? { ...plan, targetLocations: [location] } : plan
  return target ? { ...corrected, targetRoles: [target], goal: `Search only for ${target}. Exclude unrelated roles.` } : corrected
}

function fallbackPlan(message: string, config: OrchestrationContext['config']): ChatPlan {
  const lower = message.toLowerCase()
  const role: ChatWorkerRole = /score|评分|匹配|分析|compare|比较/.test(lower) ? 'analyst'
    : /cover letter|求职信|简历|cv|rewrite|撰写/.test(lower) ? 'writer'
      : /approve|review|审核|批准|跳过/.test(lower) ? 'reviewer'
        : /apply|投递|执行|automation|自动化/.test(lower) ? 'executor'
          : /search|find|寻找|搜索|职位/.test(lower) ? 'scout' : 'auditor'
  return {
    role,
    goal: message.slice(0, 220) || 'Handle the user request.',
    targetRoles: config?.targetRoles?.slice(0, 3) ?? [],
    targetLocations: config?.targetLocations?.slice(0, 3) ?? [],
  }
}

function applyExplicitSearchTarget(message: string, plan: ChatPlan): ChatPlan {
  return plan.role === 'scout' ? correctedScoutPlan(message, plan) : plan
}

function explicitSearchTarget(message: string): string | null {
  const match = message.match(/(?:搜索(?:一下)?|寻找|找|search|find)\s*(.+?)(?:岗位|职位|jobs?|roles?)(?:\s|$)/i)
  if (!match?.[1]) return null
  const candidate = match[1].trim().replace(/^.*(?:的|in\s+)/i, '').replace(/[，,。.]+$/g, '').trim()
  if (!candidate || candidate.length > 60) return null
  return candidate
}

function explicitSearchLocation(message: string): string | null {
  const lower = message.toLowerCase()
  for (const [hint, location] of Object.entries(SEARCH_LOCATION_HINTS)) {
    if (lower.includes(hint)) return location
  }
  return null
}

function parsePlan(raw: string, fallback: ChatPlan): ChatPlan {
  const source = stripFences(raw)
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end < start) return fallback
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>
    const role = typeof parsed.role === 'string' && ROLES.includes(parsed.role as ChatWorkerRole)
      ? parsed.role as ChatWorkerRole : fallback.role
    return {
      role,
      goal: typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim().slice(0, 220) : fallback.goal,
      targetRoles: stringList(parsed.targetRoles, fallback.targetRoles),
      targetLocations: stringList(parsed.targetLocations, fallback.targetLocations),
    }
  } catch {
    return fallback
  }
}

function stringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 3)
  return list.length > 0 ? list : fallback
}

function visibleText(value: string) {
  const closed = value.replace(/<think>[\s\S]*?<\/think>/gi, '')
  return closed.replace(/^\s*<think>[\s\S]*$/i, '').trim()
}

async function runScoutWorker(context: OrchestrationContext, plan: ChatPlan): Promise<ChatWorkerResult> {
  const existingUrls = new Set(context.jobs.map(job => job.url).filter((url): url is string => Boolean(url)))
  const targetRoles = plan.targetRoles.length > 0 ? plan.targetRoles : context.config?.targetRoles?.slice(0, 3) ?? []
  if (targetRoles.length === 0) {
    return { role: 'scout', summary: 'No target role is configured, so live search cannot start.', result: { jobs: [] }, confidence: 0.25 }
  }
  const jobs = await discoverJobs({
    userId: context.userId,
    targetRoles,
    targetLocations: plan.targetLocations,
    existingUrls,
    maxResults: 6,
  })
  const rows = jobs.map(job => ({ company: job.company, role: job.title, location: job.location, url: job.url, score: null }))
  return {
    role: 'scout',
    summary: rows.length ? `Found ${rows.length} live job matches.` : 'No live job matches were returned for this search.',
    result: { jobs: rows, query: { targetRoles, targetLocations: plan.targetLocations } },
    confidence: rows.length ? 0.9 : 0.65,
  }
}
