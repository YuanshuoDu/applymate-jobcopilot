'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { PanelLeftOpen, X } from 'lucide-react'
import { TopBar }              from '@/components/layout/TopBar'
import { useToast } from '@/components/ui'
import { useApi, apiMutate }   from '@/lib/hooks'
import type { AgentConfig } from '@/lib/types'
import { AddAgentModal } from '@/components/agent-workspace/AddAgentModal'
import { AgentUnifiedStream } from '@/components/agent-workspace/AgentUnifiedStream'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { AgentSessionConsole } from '@/components/agent-workspace/AgentSessionConsole'
import type { AgentChatAction } from '@/components/agent-workspace/agent-chat-stream'
import type { LogEntry, QuestionOption, RunSummary } from '@/components/agent-workspace/live-run-types'
import type { SubmissionPolicySettings } from '@/components/agent-workspace/automation-policy'

// ── Role metadata ─────────────────────────────────────────────────────────────

// ── Log entry (per-agent) ─────────────────────────────────────────────────────

// ── Chat types ────────────────────────────────────────────────────────────────

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AgentPlaygroundPage() {
  const toast = useToast()

  const { data: jobsData }                               = useApi<{ jobs: Array<{ status: string; workflowState: string }> }>('/api/jobs?pageSize=100')
  const { data: agentConfig, refetch: refetchAgentConfig } = useApi<AgentConfig>('/api/agent')

  const [showAddModal,  setShowAddModal]  = useState(false)
  const [applyQueue,    setApplyQueue]    = useState<ApplyReadyJob[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
  const [conversationTitle, setConversationTitle] = useState<string | null>(null)
  const [conversationSubtitle, setConversationSubtitle] = useState<string | null>(null)
  const [sessionsRefreshVersion, setSessionsRefreshVersion] = useState(0)
  const [chatResetVersion, setChatResetVersion] = useState(0)
  const [mobileSessionDrawerOpen, setMobileSessionDrawerOpen] = useState(false)
  const [waitingQuestion, setWaitingQuestion] = useState<{ id: string; question: string; options: QuestionOption[] } | null>(null)
  const [activeRunPolicy, setActiveRunPolicy] = useState<SubmissionPolicySettings | null>(null)

  const [currentRole,   setCurrentRole]   = useState<string | null>(null)
  const [runLog,        setRunLog]        = useState<LogEntry[]>([])
  const [runDone,       setRunDone]       = useState(false)
  const [runSummary,    setRunSummary]    = useState<RunSummary | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const currentRoleRef = useRef<string | null>(null)
  const runIdRef = useRef(0)
  const autonomousMode = Boolean(
    (activeRunPolicy ?? agentConfig)?.autoApply && !(activeRunPolicy ?? agentConfig)?.requireApproval,
  )

  const addLog = useCallback((entry: LogEntry) => { setRunLog(prev => [...prev, entry]) }, [])

  useEffect(() => {
    if (!mobileSessionDrawerOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileSessionDrawerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileSessionDrawerOpen])

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
    setLiveSessionId(null)
    setConversationTitle(null)
    setConversationSubtitle(null)
    currentRoleRef.current = null
    setCurrentRole(null)
    setRunLog([])
    setApplyQueue([])
    setRunDone(false)
    setRunSummary(null)
    setWaitingQuestion(null)
    setActiveRunPolicy(null)
    setChatResetVersion(v => v + 1)
  }, [])
  const selectSession = useCallback((sessionId: string, goal = 'Automation run', subtitle = 'Automation run') => {
    runIdRef.current += 1
    esRef.current?.close()
    esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null)
    setWaitingQuestion(null)
    setRunDone(true)
    setRunLog([])
    setApplyQueue([])
    setRunSummary(null)
    setActiveRunPolicy(null)
    setLiveSessionId(sessionId)
    setSelectedSessionId(sessionId)
    setConversationTitle(goal)
    setConversationSubtitle(subtitle)
  }, [])

  const handleDeletedSession = useCallback((sessionId: string) => {
    // A chat session is writable through liveSessionId even when it was never
    // selected in the sidebar. Clear either reference before another message
    // can reuse the deleted ID.
    if (sessionId === selectedSessionId || sessionId === liveSessionId) {
      resetLiveWorkspace()
    }
    setSessionsRefreshVersion(v => v + 1)
  }, [liveSessionId, resetLiveWorkspace, selectedSessionId])

  // ── SSE Run ────────────────────────────────────────────────────────────────

  const startRun = useCallback((initialChatMessage?: string, sessionId?: string, policy?: SubmissionPolicySettings) => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    if (esRef.current) esRef.current.close()
    setRunLog(initialChatMessage
      ? [{ type: 'user_message', message: initialChatMessage, time: new Date() }]
      : [])
    setRunDone(false)
    setRunSummary(null)
    setActiveRunPolicy(policy ?? null)
    // A previous pipeline may have left a paused question behind. A new run
    // must not show the composer as blocked until this run emits its own
    // visible `orchestrator_question` event.
    setWaitingQuestion(null)
    currentRoleRef.current = null
    setCurrentRole(null)
    setApplyQueue([])

    // Fire-and-forget: warm the discovery queue before the pipeline runs.
    void fetch('/api/agent/scout', { method: 'POST' }).catch(() => undefined)

    const query = new URLSearchParams()
    const runAutonomously = Boolean(
      (policy ?? agentConfig)?.autoApply && !(policy ?? agentConfig)?.requireApproval,
    )
    if (runAutonomously) query.set('autonomous', 'true')
    if (sessionId) query.set('sessionId', sessionId)
    const url = `/api/agent/run${query.size > 0 ? `?${query.toString()}` : ''}`
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

    listen('application_queued', e => {
      const d = JSON.parse(e.data) as ApplyReadyJob
      setApplyQueue(prev => prev.some(job => job.jobId === d.jobId)
        ? prev
        : [...prev, { ...d, mode: 'queued' }])
      addLog({ role: 'executor', type: 'application_queued', message: `⏳ ${d.company} · ${d.role} 已交给后台 Agent 投递`, time: new Date() })
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
      addLog({ type: 'done', message: `✅ 流水线完成 — ${d.processed} 个评分，${d.queued ?? 0} 个已派发，${d.applied} 个确认投递，${d.pending} 个待审核，${d.skipped} 个跳过`, time: new Date() })
      es.close(); esRef.current = null
      setSessionsRefreshVersion(v => v + 1)
      toast.success(
        'Pipeline complete',
        d.processed > 0
          ? `Scored ${d.processed} jobs, dispatched ${d.queued ?? 0}; confirmed submissions are reported by the worker.`
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
  }, [addLog, agentConfig, toast])

  const stopRun = useCallback(async () => {
    runIdRef.current += 1
    esRef.current?.close(); esRef.current = null
    currentRoleRef.current = null
    setCurrentRole(null); setRunDone(true)
    const sessionId = liveSessionId ?? selectedSessionId
    if (!sessionId) {
      addLog({ type: 'info', message: '— 已停止前端流；本次运行尚未创建可取消的会话。', time: new Date() })
      return
    }

    const response = await fetch(`/api/agent/executions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? 'Could not cancel the Agent execution.')
    }
    addLog({ type: 'info', message: '— 已取消 Agent 运行；后台不会继续处理或提交新的申请。', time: new Date() })
    window.dispatchEvent(new Event('applymate:sessions-changed'))
  }, [addLog, liveSessionId, selectedSessionId])

  const isRunning = !!currentRole || (runLog.length > 0 && !runDone)
  const visibleWaitingQuestion = waitingQuestion && runLog.some(entry =>
    entry.type === 'orchestrator_question'
      && entry.questionId === waitingQuestion.id
      && !entry.answered,
  ) ? waitingQuestion : null

  // ── Chat action handler ────────────────────────────────────────────────────

  const handleChatAction = useCallback(async (action: { type: string; [k: string]: unknown }) => {
    switch (action.type) {
      case 'start_run':
        if (typeof action.minMatchScore === 'number' && Number.isInteger(action.minMatchScore)
          && action.minMatchScore >= 0 && action.minMatchScore <= 100) {
          const { error } = await apiMutate('/api/agent', 'PATCH', { minMatchScore: action.minMatchScore })
          if (error) {
            toast.error('匹配阈值更新失败', error)
            throw new Error(error)
          }
        }
        startRun(
          typeof action.chatMessage === 'string' ? action.chatMessage : undefined,
          typeof action.sessionId === 'string' ? action.sessionId : undefined,
        )
        toast.info('流水线已启动', typeof action.minMatchScore === 'number'
          ? `匹配阈值：≥${action.minMatchScore}%`
          : 'Orchestrator 触发运行')
        break
      case 'stop_run':
        try {
          await stopRun()
          toast.info('流水线已取消', '后台执行已停止，不会继续处理新的申请。')
        } catch (error) {
          toast.error('取消运行失败', error instanceof Error ? error.message : 'Could not cancel the Agent execution.')
        }
        break
      case 'toggle_agent': {
        const role    = action.role    as string
        const enabled = action.enabled as boolean
        const { error } = await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
        if (error) {
          toast.error('Agent 更新失败', error)
          throw new Error(error)
        }
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
        await refetchAgentConfig()
        toast.success('设置已更新', `${field} → ${value}`)
        break
      }
      case 'navigate':
        if (action.path === 'jobs') window.location.href = '/?page=jobs'
        break
    }
  }, [refetchAgentConfig, startRun, stopRun, toast])

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
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.workflowState === 'ready_to_apply').length

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <style>{`
        @media (max-width: 900px) {
          .agent-workspace-layout {
            position: relative;
            min-height: 0 !important;
            overflow: hidden !important;
          }

          .agent-session-drawer-trigger {
            display: inline-flex !important;
            align-items: center;
            gap: 6px;
            min-height: 34px;
            padding: 0 10px;
            border: 1px solid var(--border);
            border-radius: 9px;
            color: var(--text);
            background: var(--bg);
            font: inherit;
            font-size: 11px;
            font-weight: 650;
            cursor: pointer;
          }

          .agent-session-drawer-scrim {
            position: absolute;
            inset: 0;
            z-index: 29;
            border: 0;
            background: rgba(15, 23, 42, 0.34);
            opacity: 0;
            pointer-events: none;
            transition: opacity 180ms ease;
          }

          .agent-session-drawer-scrim.is-open {
            opacity: 1;
            pointer-events: auto;
          }

          .agent-session-drawer {
            position: absolute;
            inset: 0 auto 0 0;
            z-index: 30;
            width: min(calc(100vw - 44px), 360px);
            display: flex;
            flex-direction: column;
            transform: translateX(-104%);
            pointer-events: none;
            transition: transform 180ms ease;
          }

          .agent-session-drawer.is-open {
            transform: translateX(0);
            pointer-events: auto;
          }

          .agent-session-drawer > .agent-session-console {
            flex: 1;
            min-height: 0;
            width: 100% !important;
            height: auto !important;
            border-right: 1px solid var(--border) !important;
            box-shadow: 14px 0 32px rgba(15, 23, 42, 0.18);
          }

          .agent-session-drawer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 48px;
            padding: 8px 10px 8px 14px;
            border-bottom: 1px solid var(--border);
            color: var(--text);
            background: var(--bg);
            font-size: 13px;
            font-weight: 750;
          }

          .agent-session-drawer-close {
            display: inline-grid;
            width: 28px;
            height: 28px;
            place-items: center;
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text-muted);
            background: var(--bg);
            cursor: pointer;
          }

          .agent-live-stream {
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }

          .agent-live-stream-body {
            min-height: 0 !important;
            overflow-y: auto !important;
            overscroll-behavior-y: contain !important;
            -webkit-overflow-scrolling: touch;
          }

          .agent-composer,
          .agent-composer-add-menu,
          .agent-composer-model-dialog {
            min-width: 0 !important;
            max-width: calc(100vw - 32px) !important;
          }

          .agent-new-chat-starters {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }

        @media (min-width: 901px) {
          .agent-session-drawer-scrim,
          .agent-session-drawer-header,
          .agent-session-drawer-close,
          .agent-session-drawer-trigger {
            display: none;
          }

          .agent-session-drawer {
            display: contents;
          }
        }
      `}</style>
      {/* TopBar */}
      <TopBar title="AI Agent">
        <button
          className="agent-session-drawer-trigger"
          type="button"
          aria-expanded={mobileSessionDrawerOpen}
          aria-controls="agent-session-drawer"
          onClick={() => setMobileSessionDrawerOpen(true)}
        >
          <PanelLeftOpen size={15} aria-hidden="true" />
          Conversations
        </button>
      </TopBar>

      {/* Add Agent Modal */}
      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => {
            window.dispatchEvent(new Event('applymate:agents-changed'))
          }}
        />
      )}

      {/* Unified Stream — Chat + Execution in one panel (like Claude) */}
      <div className="agent-workspace-layout" style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <button
          className={`agent-session-drawer-scrim${mobileSessionDrawerOpen ? ' is-open' : ''}`}
          type="button"
          aria-label="Close conversations"
          tabIndex={mobileSessionDrawerOpen ? 0 : -1}
          onClick={() => setMobileSessionDrawerOpen(false)}
        />
        <div id="agent-session-drawer" className={`agent-session-drawer${mobileSessionDrawerOpen ? ' is-open' : ''}`}>
          <div className="agent-session-drawer-header">
            <span>Conversations</span>
            <button className="agent-session-drawer-close" type="button" aria-label="Close conversations" onClick={() => setMobileSessionDrawerOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <AgentSessionConsole
            selectedSessionId={selectedSessionId}
            onSelectSession={(sessionId, goal, subtitle) => {
              selectSession(sessionId, goal, subtitle)
              setMobileSessionDrawerOpen(false)
            }}
            onRunSession={(sessionId, policy) => {
              selectSession(sessionId)
              setMobileSessionDrawerOpen(false)
              startRun(undefined, sessionId, policy)
            }}
            onAddAgent={() => setShowAddModal(true)}
            onNewChat={() => {
              resetLiveWorkspace()
              setMobileSessionDrawerOpen(false)
            }}
            onDeletedSession={handleDeletedSession}
            refreshVersion={sessionsRefreshVersion}
          />
        </div>
        <AgentUnifiedStream
            log={runLog}
            running={isRunning}
            summary={runSummary}
            applyQueue={applyQueue}
            waitingQuestion={visibleWaitingQuestion}
            savedCount={savedCount}
            pendingCount={pendingCount}
            autonomousMode={autonomousMode}
            resetVersion={chatResetVersion}
            resumeSessionId={liveSessionId}
            conversationTitle={conversationTitle}
            conversationSubtitle={conversationSubtitle}
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
            onSessionRecorded={(sessionId, goal, subtitle) => {
              setLiveSessionId(sessionId)
              setSelectedSessionId(sessionId)
              if (goal) setConversationTitle(goal)
              if (subtitle) setConversationSubtitle(subtitle)
              setSessionsRefreshVersion(v => v + 1)
            }}
        />
      </div>
    </div>
  )
}
