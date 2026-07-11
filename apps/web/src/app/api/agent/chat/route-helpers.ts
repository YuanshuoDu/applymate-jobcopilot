import { MODEL_CATALOGUE, type AiConfig, type ChatMessage } from '@/lib/model-router'

export const SYSTEM_PROMPT = (ctx: {
  jobCount: number
  savedCount: number
  pendingCount: number
  config: Record<string, unknown> | null
  resumeName: string | null
  recentJobs: Array<{ company: string; role: string; score: number | null; status: string }>
  lastRunAt: string | null
}): string => `You are the ApplyMate AI Pipeline Orchestrator — a smart career assistant coordinating a team of 6 specialized AI agents.

## Current Status
- Total jobs: ${ctx.jobCount} | Saved: ${ctx.savedCount} | Pending review: ${ctx.pendingCount}
- Active resume: ${ctx.resumeName ?? 'None'}
- Pipeline last run: ${ctx.lastRunAt ?? 'Never'}
- Min match score: ${ctx.config?.minMatchScore ?? 75}% | Auto-apply: ${ctx.config?.autoApply ? 'ON' : 'OFF'}
- Daily limit: ${ctx.config?.dailyLimit ?? 10} applications/day

## Recent Jobs
${ctx.recentJobs.length === 0 ? 'No jobs yet.' : ctx.recentJobs.map(j => `- ${j.company} · ${j.role} | Score: ${j.score != null ? j.score + '%' : '-'} | ${j.status}`).join('\n')}

Action commands (at END of response, on its own line):
  ACTION:start_run
  ACTION:stop_run
  ACTION:update_config:key:value
  ACTION:navigate:path
  ACTION:open_job:<jobId>
  ACTION:toggle_agent:roleName:true/false

Rules: max 1 action per response, only when asked or obviously needed, be helpful in Chinese or English, use real data from context.`

export interface ChatRequestBody {
  sessionId?: unknown
  messages?: unknown
  model?: unknown
}

export type ParsedAgentAction =
  | { type: 'start_run'; command: string }
  | { type: 'stop_run'; command: string }
  | { type: 'toggle_agent'; role: string; enabled: boolean; command: string }
  | { type: 'update_config'; field: string; value: unknown; command: string }
  | { type: 'navigate'; path: string; command: string }
  | { type: 'open_job'; jobId: string; command: string }

export function readSessionId(body: ChatRequestBody): string | null {
  return typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : null
}

export function readChatMessages(body: ChatRequestBody): ChatMessage[] | null {
  if (!Array.isArray(body.messages)) return null
  const messages = body.messages.filter((msg): msg is ChatMessage => {
    if (!msg || typeof msg !== 'object') return false
    const row = msg as { role?: unknown; content?: unknown }
    return (row.role === 'user' || row.role === 'assistant' || row.role === 'system')
      && typeof row.content === 'string'
  })
  return messages.length > 0 ? messages : null
}

export function latestUserMessage(messages: ChatMessage[]): string {
  return [...messages].reverse().find(msg => msg.role === 'user')?.content.trim() ?? ''
}

export function sessionGoalFrom(text: string): string {
  const fallback = 'Agent chat session'
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return fallback
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact
}

export function responseMemory(text: string): string {
  const clean = text.replace(/^ACTION:.+$/gm, '').replace(/\s+/g, ' ').trim()
  if (!clean) return 'Waiting for the next user instruction.'
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean
}

export function resolveRequestedModel(body: ChatRequestBody, fallback: AiConfig): AiConfig {
  if (typeof body.model !== 'string') return fallback
  const [provider, model] = body.model.split('::')
  const option = MODEL_CATALOGUE.find(item => item.provider === provider && item.model === model)
  if (!option) return fallback
  return { provider: option.provider, model: option.model }
}

export function agentActionFromText(text: string): ParsedAgentAction | null {
  const actionMatch = text.match(/^ACTION:(.+)$/m)
  if (!actionMatch) return null
  const command = actionMatch[1]
  const parts = command.split(':')
  const type = parts[0]
  if (type === 'start_run') return { type: 'start_run', command }
  if (type === 'stop_run') return { type: 'stop_run', command }
  if (type === 'toggle_agent' && parts.length >= 3) {
    return { type: 'toggle_agent', role: parts[1], enabled: parts[2] === 'true', command }
  }
  if (type === 'update_config' && parts.length >= 3) {
    return { type: 'update_config', field: parts[1], value: parseActionValue(parts[2]), command }
  }
  if (type === 'navigate' && parts[1]) return { type: 'navigate', path: parts[1], command }
  if (type === 'open_job' && parts[1]) return { type: 'open_job', jobId: parts[1], command }
  return null
}

function parseActionValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  return !Number.isNaN(Number(value)) ? Number(value) : value
}
