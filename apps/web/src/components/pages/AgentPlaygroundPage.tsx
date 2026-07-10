'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TopBar }              from '@/components/layout/TopBar'
import { useToast } from '@/components/ui'
import type { AgentRole } from '@/lib/types'
import { useApi, apiMutate }   from '@/lib/hooks'
import type { AiConfig }       from '@/lib/model-router'
import { AddAgentModal, type CustomAgentRow } from '@/components/agent-workspace/AddAgentModal'
import { AgentUnifiedStream } from '@/components/agent-workspace/AgentUnifiedStream'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { AgentSessionConsole } from '@/components/agent-workspace/AgentSessionConsole'
import { AgentSessionTranscript } from '@/components/agent-workspace/AgentSessionTranscript'
import type { AgentChatAction } from '@/components/agent-workspace/agent-chat-stream'
import type { LogEntry, QuestionOption, RunSummary } from '@/components/agent-workspace/live-run-types'

// ── Role metadata ─────────────────────────────────────────────────────────────

// ── Log entry (per-agent) ─────────────────────────────────────────────────────

// ── Chat types ────────────────────────────────────────────────────────────────

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AgentPlaygroundPage() {
  const toast = useToast()

  const { refetch: refetchRoles }                        = useApi<AgentRole[]>('/api/agent/roles')
  const { data: jobsData }                               = useApi<{ jobs: Array<{ status: string }> }>('/api/jobs?pageSize=100')
  const { refetch: refetchCustom }                       = useApi<CustomAgentRow[]>('/api/agent/roles/custom')

  const [showAddModal,  setShowAddModal]  = useState(false)
  const [applyQueue,    setApplyQueue]    = useState<ApplyReadyJob[]>([])
  const [autonomousMode,setAutonomousMode]= useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sessionsRefreshVersion, setSessionsRefreshVersion] = useState(0)
  const [chatResetVersion, setChatResetVersion] = useState(0)
  const [waitingQuestion, setWaitingQuestion] = useState<{ id: string; question: string; options: QuestionOption[] } | null>(null)

  const [currentRole,   setCurrentRole]   = useState<string | null>(null)
  const [runLog,        setRunLog]        = useState<LogEntry[]>([])
  const [runDone,       setRunDone]       = useState(false)
  const [runSummary,    setRunSummary]    = useState<RunSummary | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const currentRoleRef = useRef<string | null>(null)
  const runIdRef = useRef(0)

  const addLog = useCallback((entry: LogEntry) => { setRunLog(prev => [...prev, entry]) }, [])
  useEffect(() => {
    return () => {
      runIdRef.current += 1
      esRef.current?.close()
      esRef.current = null
      currentRoleRef.current = null
    }
  }, [])

  const resetLiveWorkspace = useCallback(() => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    setSelectedSessionId(null)
    currentRoleRef.current = null
    setCurrentRole(null)
    setRunLog([])
    setApplyQueue([])
    setRunDone(false)
    setRunSummary(null)
    setWaitingQuestion(null)
    setChatResetVersion(v => v + 1)
  }, [])
  const selectReplaySession = useCallback((sessionId: string) => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null)
    setWaitingQuestion(null)
    setRunDone(true)
    setSelectedSessionId(sessionId)
  }, [])

  // ── SSE Run ────────────────────────────────────────────────────────────────

  const startRun = useCallback(() => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    if (esRef.current) esRef.current.close()
    setRunLog([])
    setRunDone(false)
    setRunSummary(null)
    currentRoleRef.current = null
    setCurrentRole(null)
    setApplyQueue([])

    // Fire-and-forget: warm the discovery queue before the pipeline runs.
    void fetch('/api/agent/scout', { method: 'POST' }).catch(() => undefined)

    const url = `/api/agent/run${autonomousMode ? '?autonomous=true' : ''}`
    const es  = new EventSource(url)
    esRef.current = es
    const isCurrentRun = () => esRef.current === es && runIdRef.current === runId
    const listen = (type: string, handler: (event: MessageEvent) => void) => {
      es.addEventListener(type, event => {
        if (!isCurrentRun()) return
        handler(event as MessageEvent)
      })
    }

    listen('role_start', e => {
      const d = JSON.parse(e.data) as { role: string; label: string; model: string; icon: string }
      currentRoleRef.current = d.role
      setCurrentRole(d.role)
      addLog({ role: d.role, type: 'role_start', message: `${d.icon} [${d.role}] ${d.label} 开始… (${d.model})`, time: new Date() })
    })

    listen('role_done', e => {
      const d = JSON.parse(e.data) as { role: string; icon: string; summary: string; count: number; durationMs: number }
      addLog({ role: d.role, type: 'role_done', message: `✓ ${d.summary} (${(d.durationMs / 1000).toFixed(1)}s)`, time: new Date() })
    })

    listen('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 流水线启动 — ${d.total} 个职位待处理`, time: new Date() })
    })

    listen('job_done', e => {
      const d = JSON.parse(e.data)
      const applied = d.autoApplied ? ' ✓ 已投递' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({ role: currentRoleRef.current ?? 'analyst', type: 'job_done', message: `${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`, score: d.score, time: new Date() })
    })

    listen('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ role: currentRoleRef.current ?? 'scout', type: 'job_skip', message: `— ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
    })

    listen('orchestrator_thinking', e => {
      const d = JSON.parse(e.data)
      const modeTag = d.autonomous ? ' [自主模式]' : ''
      addLog({ type: 'orchestrator_thinking', message: d.thinking + modeTag, time: new Date() })
    })

    // True pause question — pipeline is waiting for this answer
    listen('orchestrator_question', e => {
      const d = JSON.parse(e.data) as { id: string; stage: string; question: string; options: QuestionOption[] }
      setWaitingQuestion({ id: d.id, question: d.question, options: d.options })
      addLog({ type: 'orchestrator_question', questionId: d.id, question: d.question, options: d.options, answered: false, message: d.question, time: new Date() })
    })

    listen('orchestrator_answer_received', e => {
      const d = JSON.parse(e.data)
      setWaitingQuestion(null)
      setRunLog(prev => prev.map(l => l.questionId === d.id ? { ...l, answered: true } : l))
      addLog({ type: 'orchestrator_answer', message: `✓ 已回答：${d.label}`, time: new Date() })
    })

    listen('orchestrator_plan', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_plan', message: `🧠 Orchestrator 策略：${d.plan}`, time: new Date() })
    })
    listen('orchestrator_fix', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.stage, type: 'orchestrator_fix', message: d.message, time: new Date() })
    })
    listen('orchestrator_retry', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.stage, type: 'orchestrator_retry', message: d.message, time: new Date() })
    })
    listen('orchestrator_decision', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_decision', message: `⚖ Orchestrator 决策 [${d.stage}]：${d.reason}`, time: new Date() })
    })
    listen('orchestrator_complete', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_complete', message: `🧠 ${d.message}`, time: new Date() })
    })

    listen('apply_ready', e => {
      const d = JSON.parse(e.data) as ApplyReadyJob
      setApplyQueue(prev => [...prev, d])
    })

    listen('agent_question', e => {
      const d = JSON.parse(e.data)
      addLog({
        role: d.role, type: 'agent_question', message: d.question,
        questionId: d.questionId, question: d.question, options: d.options,
        answered: false, time: new Date(),
      })
    })

    listen('agent_plan', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_plan', message: d.plan, time: new Date() })
    })

    listen('agent_action', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_action', message: d.action, time: new Date() })
    })

    listen('agent_observation', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_observation', message: d.observation, time: new Date() })
    })

    listen('agent_reflect', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_reflect', message: d.reflect, time: new Date() })
    })

    listen('info', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: `ℹ ${d.message}`, time: new Date() })
    })

    listen('done', e => {
      const d = JSON.parse(e.data)
      setRunSummary(d)
      setRunDone(true)
      currentRoleRef.current = null
      setCurrentRole(null)
      addLog({ type: 'done', message: `✅ 流水线完成 — ${d.processed} 个评分，${d.applied} 个投递，${d.pending} 个待审核，${d.skipped} 个跳过`, time: new Date() })
      es.close(); esRef.current = null
      setSessionsRefreshVersion(v => v + 1)
      refetchRoles()
      toast.success(
        'Pipeline complete',
        d.processed > 0
          ? `Scored ${d.processed} jobs, applied to ${d.applied}. New jobs from Scout may appear in Jobs list.`
          : 'Done. Check Jobs — Scout may have added new discoveries.'
      )
    })

    listen('error', e => {
      try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); addLog({ type: 'error', message: `✗ ${d.message ?? '流水线错误'}`, time: new Date() }) }
      catch { addLog({ type: 'error', message: '✗ 连接断开', time: new Date() }) }
      currentRoleRef.current = null
      setCurrentRole(null); setRunDone(true)
      es.close(); esRef.current = null
    })
  }, [addLog, autonomousMode, refetchRoles, toast])

  const stopRun = useCallback(() => {
    runIdRef.current += 1
    esRef.current?.close(); esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null); setRunDone(true)
    addLog({ type: 'info', message: '— 用户停止运行', time: new Date() })
  }, [addLog])

  const isRunning = !!currentRole || (runLog.length > 0 && !runDone)

  // ── Chat action handler ────────────────────────────────────────────────────

  const handleChatAction = useCallback(async (action: { type: string; [k: string]: unknown }) => {
    switch (action.type) {
      case 'start_run':
        startRun()
        toast.info('流水线已启动', 'Orchestrator 触发运行')
        break
      case 'stop_run':
        stopRun()
        toast.info('流水线已停止', '')
        break
      case 'toggle_agent': {
        const role    = action.role    as string
        const enabled = action.enabled as boolean
        const { error } = await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
        if (error) {
          toast.error('Agent 更新失败', error)
          throw new Error(error)
        }
        await refetchRoles()
        window.dispatchEvent(new Event('applymate:agents-changed'))
        toast.info(enabled ? `${role} 已启用` : `${role} 已禁用`, '')
        break
      }
      case 'update_config': {
        const field = action.field as string
        const value = action.value
        const { error } = await apiMutate('/api/agent', 'PATCH', { [field]: value })
        if (error) {
          toast.error('设置更新失败', error)
          throw new Error(error)
        }
        toast.success('设置已更新', `${field} → ${value}`)
        break
      }
      case 'navigate':
        if (action.path === 'jobs') window.location.href = '/?page=jobs'
        break
    }
  }, [refetchRoles, startRun, stopRun, toast])

  const handleAnswerQuestion = useCallback(async (entry: LogEntry, opt: QuestionOption) => {
    // Apply action
    if (opt.action) {
      const { field, value } = opt.action
      if (field === '_navigate') {
        window.location.href = `/?page=${value}`
        return
      }
      if (field === '_send_email') {
        const emailData = JSON.parse(value as string) as { to: string; draft: string; subject: string; jobId: string }
        const { error } = await apiMutate('/api/gmail/send-draft', 'POST', emailData)
        if (error) {
          toast.error('邮件发送失败', error)
          throw new Error(error)
        }
        toast.success('邮件已发送', `拒信问询已发送至 ${emailData.to}`)
      }
      else {
        const { error } = await apiMutate('/api/agent', 'PATCH', { [field]: value })
        if (error) {
          toast.error('设置更新失败', error)
          throw new Error(error)
        }
      }
    }
    setRunLog(prev => prev.map(l =>
      l.questionId === entry.questionId ? { ...l, answered: true } : l
    ))
    addLog({
      type: 'question_answered',
      message: `✓ 你选择了「${opt.label}」${opt.action ? '，偏好已保存' : ''}`,
      time: new Date(),
    })
    toast.success('偏好已记录', opt.action ? '设置已更新，下次运行生效' : '已知悉，继续运行')
  }, [addLog, toast])

  const savedCount   = (jobsData?.jobs ?? []).filter(j => j.status === 'saved').length
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.status === 'review').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <style>{`
        @media (max-width: 760px) {
          .agent-workspace-layout {
            flex-direction: column !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
          }

          .agent-session-console {
            width: 100% !important;
            height: min(42vh, 360px) !important;
            border-right: none !important;
            border-bottom: 1px solid var(--border) !important;
          }

          .agent-live-stream,
          .agent-transcript-pane {
            flex: 0 0 auto !important;
            min-height: 620px !important;
            width: 100% !important;
          }
        }
      `}</style>
      {/* TopBar */}
      <TopBar title="AI Agent" />

      {/* Add Agent Modal */}
      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onCreated={async () => {
            await refetchCustom()
            window.dispatchEvent(new Event('applymate:agents-changed'))
          }}
        />
      )}

      {/* Unified Stream — Chat + Execution in one panel (like Claude) */}
      <div className="agent-workspace-layout" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AgentSessionConsole
          selectedSessionId={selectedSessionId}
          onSelectSession={selectReplaySession}
          onAddAgent={() => setShowAddModal(true)}
          onNewChat={resetLiveWorkspace}
          onBackToLive={() => setSelectedSessionId(null)}
          refreshVersion={sessionsRefreshVersion}
        />
        {selectedSessionId ? (
          <AgentSessionTranscript
            sessionId={selectedSessionId}
            onBackToLive={() => setSelectedSessionId(null)}
          />
        ) : (
          <AgentUnifiedStream
            log={runLog}
            running={isRunning}
            summary={runSummary}
            applyQueue={applyQueue}
            waitingQuestion={waitingQuestion}
            savedCount={savedCount}
            pendingCount={pendingCount}
            autonomousMode={autonomousMode}
            resetVersion={chatResetVersion}
            onAnswerQuestion={handleAnswerQuestion}
            onAnswerOrchestrator={async (questionId, answer, options) => {
              const opt = options?.find(o => o.value === answer)
              if (opt?.action && opt.action.field !== '_navigate') {
                const { error: patchError } = await apiMutate('/api/agent', 'PATCH', { [opt.action.field]: opt.action.value })
                if (patchError) {
                  toast.error('设置更新失败', patchError)
                  throw new Error(patchError)
                }
              }
              // Post answer to DB so pipeline can continue
              const { error } = await apiMutate('/api/agent/answer', 'POST', { questionId, answer })
              if (error) {
                toast.error('回答提交失败', error)
                throw new Error(error)
              }
              setWaitingQuestion(null)
              setRunLog(prev => prev.map(l => l.questionId === questionId ? { ...l, answered: true } : l))
              addLog({ type: 'user_message', message: options?.find(o => o.value === answer)?.label ?? answer, time: new Date() })
            }}
            onApplied={async (jobId, job) => {
              const { error } = await apiMutate(`/api/jobs/${jobId}/apply`, 'POST', {})
              if (error) {
                toast.error('标记投递失败', error)
                throw new Error(error)
              }
              setApplyQueue(prev => prev.map(j => j.jobId === jobId ? { ...j, url: `_applied_${j.url}` } : j))
              toast.success('已标记为投递', `${job.company} · ${job.role}`)
            }}
            onChatAction={handleChatAction}
            onAppendLog={addLog}
            onSessionRecorded={() => setSessionsRefreshVersion(v => v + 1)}
          />
        )}
      </div>
    </div>
  )
}
