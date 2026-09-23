import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import type { LogEntry, QuestionOption, RunSummary } from '@/components/agent-workspace/live-run-types'

export interface AgentRunEventHandlers {
  addLog: (entry: LogEntry) => void
  currentRoleRef: MutableRefObject<string | null>
  setCurrentRole: Dispatch<SetStateAction<string | null>>
  setWaitingQuestion: Dispatch<SetStateAction<{ id: string; question: string; options: QuestionOption[] } | null>>
  setRunLog: Dispatch<SetStateAction<LogEntry[]>>
  setRunSummary: Dispatch<SetStateAction<RunSummary | null>>
  setRunDone: Dispatch<SetStateAction<boolean>>
  setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>>
  onComplete: (summary: RunSummary) => void
  onError: () => void
}

export function attachAgentRunEventListeners(
  es: EventSource,
  isCurrentRun: () => boolean,
  handlers: AgentRunEventHandlers,
) {
  const listen = (type: string, handler: (event: MessageEvent) => void) => {
    es.addEventListener(type, event => {
      if (!isCurrentRun()) return
      handler(event as MessageEvent)
    })
  }

  listen('role_start', e => {
    const d = JSON.parse(e.data) as { role: string; label: string; model: string; icon: string }
    handlers.currentRoleRef.current = d.role
    handlers.setCurrentRole(d.role)
    handlers.addLog({ role: d.role, type: 'role_start', message: `${d.icon} [${d.role}] ${d.label} start… (${d.model})`, time: new Date() })
  })

  listen('role_done', e => {
    const d = JSON.parse(e.data) as { role: string; icon: string; summary: string; count: number; durationMs: number }
    handlers.addLog({ role: d.role, type: 'role_done', message: `✓ ${d.summary} (${(d.durationMs / 1000).toFixed(1)}s)`, time: new Date() })
  })

  listen('start', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ type: 'start', message: `🚀 Pipeline start — ${d.total} positions pending`, time: new Date() })
  })

  listen('job_done', e => {
    const d = JSON.parse(e.data)
    const applied = d.autoApplied ? ' ✓ Delivered' : ''
    const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
    handlers.addLog({ role: handlers.currentRoleRef.current ?? 'analyst', type: 'job_done', message: `${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`, score: d.score, time: new Date() })
  })

  listen('job_skip', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: handlers.currentRoleRef.current ?? 'scout', type: 'job_skip', message: `— ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
  })

  listen('orchestrator_thinking', e => {
    const d = JSON.parse(e.data)
    const modeTag = d.autonomous ? ' [autonomous mode]' : ''
    handlers.addLog({ type: 'orchestrator_thinking', message: d.thinking + modeTag, time: new Date() })
  })

  listen('orchestrator_question', e => {
    const d = JSON.parse(e.data) as { id: string; stage: string; question: string; options: QuestionOption[] }
    handlers.setWaitingQuestion({ id: d.id, question: d.question, options: d.options })
    handlers.addLog({ type: 'orchestrator_question', questionId: d.id, question: d.question, options: d.options, answered: false, message: d.question, time: new Date() })
  })

  listen('orchestrator_answer_received', e => {
    const d = JSON.parse(e.data)
    handlers.setWaitingQuestion(null)
    handlers.setRunLog(prev => prev.map(l => l.questionId === d.id ? { ...l, answered: true } : l))
    handlers.addLog({ type: 'orchestrator_answer', message: `✓ Answered: ${d.label}`, time: new Date() })
  })

  listen('orchestrator_plan', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ type: 'orchestrator_plan', message: `🧠 Orchestrator Strategy: ${d.plan}`, time: new Date() })
  })
  listen('orchestrator_fix', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.stage, type: 'orchestrator_fix', message: d.message, time: new Date() })
  })
  listen('orchestrator_retry', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.stage, type: 'orchestrator_retry', message: d.message, time: new Date() })
  })
  listen('orchestrator_decision', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ type: 'orchestrator_decision', message: `⚖ Orchestrator decision making [${d.stage}]: ${d.reason}`, time: new Date() })
  })
  listen('orchestrator_complete', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ type: 'orchestrator_complete', message: `🧠 ${d.message}`, time: new Date() })
  })

  listen('apply_ready', e => {
    const d = JSON.parse(e.data) as ApplyReadyJob
    handlers.setApplyQueue(prev => [...prev, d])
  })

  listen('application_queued', e => {
    const d = JSON.parse(e.data) as ApplyReadyJob
    handlers.setApplyQueue(prev => prev.some(job => job.jobId === d.jobId)
      ? prev
      : [...prev, { ...d, mode: 'queued' }])
    handlers.addLog({ role: 'executor', type: 'application_queued', message: `⏳ ${d.company} · ${d.role} Has been handed over to the backend Agent delivery`, time: new Date() })
  })

  listen('agent_question', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({
      role: d.role, type: 'agent_question', message: d.question,
      questionId: d.questionId, question: d.question, options: d.options,
      answered: false, time: new Date(),
    })
  })

  listen('agent_plan', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.role, type: 'agent_plan', message: d.plan, time: new Date() })
  })

  listen('agent_action', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.role, type: 'agent_action', message: d.action, time: new Date() })
  })

  listen('agent_observation', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.role, type: 'agent_observation', message: d.observation, time: new Date() })
  })

  listen('agent_reflect', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ role: d.role, type: 'agent_reflect', message: d.reflect, time: new Date() })
  })

  listen('info', e => {
    const d = JSON.parse(e.data)
    handlers.addLog({ type: 'info', message: `ℹ ${d.message}`, time: new Date() })
  })

  listen('done', e => {
    const d = JSON.parse(e.data) as RunSummary
    handlers.setRunSummary(d)
    handlers.setRunDone(true)
    handlers.currentRoleRef.current = null
    handlers.setCurrentRole(null)
    handlers.addLog({ type: 'done', message: `✅ Pipeline completed — ${d.processed} ratings, ${d.queued ?? 0} Distributed, ${d.applied} Confirmed delivery, ${d.pending} pending review, ${d.skipped} skipped`, time: new Date() })
    es.close()
    handlers.onComplete(d)
  })

  listen('error', e => {
    try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); handlers.addLog({ type: 'error', message: `✗ ${d.message ?? 'Pipeline error'}`, time: new Date() }) }
    catch { handlers.addLog({ type: 'error', message: '✗ Lost connection', time: new Date() }) }
    handlers.currentRoleRef.current = null
    handlers.setCurrentRole(null)
    handlers.setRunDone(true)
    es.close()
    handlers.onError()
  })
}
