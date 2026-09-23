'use client'

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentConfig } from '@/lib/types'
import { useToast } from '@/components/ui'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import type { LogEntry, QuestionOption, RunSummary } from '@/components/agent-workspace/live-run-types'
import type { SubmissionPolicySettings } from '@/components/agent-workspace/automation-policy'
import { attachAgentRunEventListeners } from './agent-playground-run-events'

type WaitingQuestion = { id: string; question: string; options: QuestionOption[] }
type ToastApi = ReturnType<typeof useToast>

interface UseAgentPlaygroundRunOptions {
  agentConfig: AgentConfig | null | undefined
  toast: ToastApi
  sessionId: string | null
  setWaitingQuestion: Dispatch<SetStateAction<WaitingQuestion | null>>
  setActiveRunPolicy: Dispatch<SetStateAction<SubmissionPolicySettings | null>>
  setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>>
  setSessionsRefreshVersion: Dispatch<SetStateAction<number>>
}

export function useAgentPlaygroundRun({
  agentConfig, toast, sessionId,
  setWaitingQuestion, setActiveRunPolicy, setApplyQueue, setSessionsRefreshVersion,
}: UseAgentPlaygroundRunOptions) {
  const [currentRole, setCurrentRole] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<LogEntry[]>([])
  const [runDone, setRunDone] = useState(false)
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const currentRoleRef = useRef<string | null>(null)
  const runIdRef = useRef(0)

  const addLog = useCallback((entry: LogEntry) => { setRunLog(prev => [...prev, entry]) }, [])

  useEffect(() => () => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    currentRoleRef.current = null
  }, [])

  const resetRun = useCallback((done: boolean) => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null)
    setRunLog([])
    setApplyQueue([])
    setRunDone(done)
    setRunSummary(null)
    setWaitingQuestion(null)
    setActiveRunPolicy(null)
  }, [setActiveRunPolicy, setApplyQueue, setWaitingQuestion])

  const startRun = useCallback((initialChatMessage?: string, requestedSessionId?: string, policy?: SubmissionPolicySettings) => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    esRef.current?.close()
    setRunLog(initialChatMessage
      ? [{ type: 'user_message', message: initialChatMessage, time: new Date() }]
      : [])
    setRunDone(false)
    setRunSummary(null)
    setActiveRunPolicy(policy ?? null)
    setWaitingQuestion(null)
    currentRoleRef.current = null
    setCurrentRole(null)
    setApplyQueue([])

    void fetch('/api/agent/scout', { method: 'POST' }).catch(() => undefined)

    const query = new URLSearchParams()
    const runPolicy = policy ?? agentConfig
    const runAutonomously = Boolean(runPolicy?.autoApply && !runPolicy?.requireApproval)
    if (runAutonomously) query.set('autonomous', 'true')
    if (requestedSessionId) query.set('sessionId', requestedSessionId)
    const url = `/api/agent/run${query.size > 0 ? `?${query.toString()}` : ''}`
    const es = new EventSource(url)
    esRef.current = es
    const isCurrentRun = () => esRef.current === es && runIdRef.current === runId

    attachAgentRunEventListeners(es, isCurrentRun, {
      addLog,
      currentRoleRef,
      setCurrentRole,
      setWaitingQuestion,
      setRunLog,
      setRunSummary,
      setRunDone,
      setApplyQueue,
      onComplete: summary => {
        esRef.current = null
        setSessionsRefreshVersion(v => v + 1)
        toast.success(
          'Pipeline complete',
          summary.processed > 0
            ? `Scored ${summary.processed} jobs, dispatched ${summary.queued ?? 0}; confirmed submissions are reported by the worker.`
            : 'Done. Check Jobs — Scout may have added new discoveries.',
        )
      },
      onError: () => { esRef.current = null },
    })
  }, [addLog, agentConfig, setActiveRunPolicy, setApplyQueue, setSessionsRefreshVersion, setWaitingQuestion, toast])

  const stopRun = useCallback(async () => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null)
    setRunDone(true)
    if (!sessionId) {
      addLog({ type: 'info', message: '— Frontend flow stopped; No cancelable sessions have been created for this run.', time: new Date() })
      return
    }

    const response = await fetch(`/api/agent/executions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? 'Could not cancel the Agent execution.')
    }
    addLog({ type: 'info', message: '— Canceled Agent run; The background will not continue to process or submit new applications..', time: new Date() })
    window.dispatchEvent(new Event('applymate:sessions-changed'))
  }, [addLog, sessionId])

  return { currentRole, runLog, setRunLog, runDone, runSummary, addLog, startRun, stopRun, resetRun }
}
