'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Home, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { TopBar }              from '@/components/layout/TopBar'
import { useToast } from '@/components/ui'
import { useApi, apiMutate }   from '@/lib/hooks'
import type { AgentConfig } from '@/lib/types'
import { AddAgentModal } from '@/components/agent-workspace/AddAgentModal'
import { AgentUnifiedStream } from '@/components/agent-workspace/AgentUnifiedStream'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { AgentSessionConsole } from '@/components/agent-workspace/AgentSessionConsole'
import { sessionHeaderSubtitle, type AgentSessionsResponse } from '@/components/agent-workspace/session-view-model'
import type { AgentChatAction } from '@/components/agent-workspace/agent-chat-stream'
import type { LogEntry, QuestionOption, RunSummary } from '@/components/agent-workspace/live-run-types'
import type { SubmissionPolicySettings } from '@/components/agent-workspace/automation-policy'
import { useAgentSessionState, useAgentSessionUrl } from '@/components/agent-workspace/agent-session-state'
import { AgentTurnComposerProvider, useAgentTurnComposer } from '@/components/agent-workspace/agent-turn-commands'
import { useNav } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'

// ── Role metadata ─────────────────────────────────────────────────────────────

// ── Log entry (per-agent) ─────────────────────────────────────────────────────

// ── Chat types ────────────────────────────────────────────────────────────────

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AgentPlaygroundPage() {
  const toast = useToast()
  const { navigate } = useNav()
  const { t } = useI18n()

  const { data: jobsData }                               = useApi<{ jobs: Array<{ status: string; workflowState: string }> }>('/api/jobs?pageSize=100')
  const { data: agentConfig, refetch: refetchAgentConfig } = useApi<AgentConfig>('/api/agent')

  const [showAddModal,  setShowAddModal]  = useState(false)
  const [applyQueue,    setApplyQueue]    = useState<ApplyReadyJob[]>([])
  const { sessionId, setSessionId } = useAgentSessionUrl()
  const selectedSessionId = sessionId
  const { activeTurn, refetch: refetchTurnState } = useAgentSessionState(sessionId)
  const turnComposer = useAgentTurnComposer(sessionId, activeTurn, refetchTurnState)
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
  const initialSessionRestoredRef = useRef(false)
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
    setSessionId(null)
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
    setSessionId(sessionId)
    setConversationTitle(goal)
    setConversationSubtitle(subtitle)
    // The server owns this preference and scopes it to the authenticated user.
    void fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH' }).catch(() => undefined)
  }, [])

  const restoreLastSession = useCallback((data: AgentSessionsResponse) => {
    if (initialSessionRestoredRef.current) return
    initialSessionRestoredRef.current = true
    if (sessionId) return
    const session = data.sessions.find(item => item.id === data.lastOpenedSessionId)
    if (session) selectSession(session.id, session.goal, sessionHeaderSubtitle(session))
  }, [selectSession, sessionId])

  const handleDeletedSession = useCallback((deletedSessionId: string) => {
    // The URL is the only session identity. Clear it before another message
    // can reuse a deleted ID.
    if (deletedSessionId === sessionId) {
      resetLiveWorkspace()
    }
    setSessionsRefreshVersion(v => v + 1)
  }, [resetLiveWorkspace, sessionId])

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
      addLog({ role: d.role, type: 'role_start', message: `${d.icon} [${d.role}] ${d.label} start… (${d.model})`, time: new Date() })
    })

    listen('role_done', e => {
      const d = JSON.parse(e.data) as { role: string; icon: string; summary: string; count: number; durationMs: number }
      addLog({ role: d.role, type: 'role_done', message: `✓ ${d.summary} (${(d.durationMs / 1000).toFixed(1)}s)`, time: new Date() })
    })

    listen('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 Pipeline start — ${d.total} positions pending`, time: new Date() })
    })

    listen('job_done', e => {
      const d = JSON.parse(e.data)
      const applied = d.autoApplied ? ' ✓ Delivered' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({ role: currentRoleRef.current ?? 'analyst', type: 'job_done', message: `${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`, score: d.score, time: new Date() })
    })

    listen('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ role: currentRoleRef.current ?? 'scout', type: 'job_skip', message: `— ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
    })

    listen('orchestrator_thinking', e => {
      const d = JSON.parse(e.data)
      const modeTag = d.autonomous ? ' [autonomous mode]' : ''
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
      addLog({ type: 'orchestrator_answer', message: `✓ Answered: ${d.label}`, time: new Date() })
    })

    listen('orchestrator_plan', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_plan', message: `🧠 Orchestrator Strategy: ${d.plan}`, time: new Date() })
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
      addLog({ type: 'orchestrator_decision', message: `⚖ Orchestrator decision making [${d.stage}]: ${d.reason}`, time: new Date() })
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
      addLog({ role: 'executor', type: 'application_queued', message: `⏳ ${d.company} · ${d.role} Has been handed over to the backend Agent delivery`, time: new Date() })
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
      addLog({ type: 'done', message: `✅ Pipeline completed — ${d.processed} ratings, ${d.queued ?? 0} Distributed, ${d.applied} Confirmed delivery, ${d.pending} pending review, ${d.skipped} skipped`, time: new Date() })
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
      try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); addLog({ type: 'error', message: `✗ ${d.message ?? 'Pipeline error'}`, time: new Date() }) }
      catch { addLog({ type: 'error', message: '✗ Lost connection', time: new Date() }) }
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
    const currentSessionId = sessionId
    if (!currentSessionId) {
      addLog({ type: 'info', message: '— Frontend flow stopped; No cancelable sessions have been created for this run.', time: new Date() })
      return
    }

    const response = await fetch(`/api/agent/executions?sessionId=${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? 'Could not cancel the Agent execution.')
    }
    addLog({ type: 'info', message: '— Canceled Agent run; The background will not continue to process or submit new applications..', time: new Date() })
    window.dispatchEvent(new Event('applymate:sessions-changed'))
  }, [addLog, sessionId])

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
            toast.error('Match threshold update failed', error)
            throw new Error(error)
          }
        }
        startRun(
          typeof action.chatMessage === 'string' ? action.chatMessage : undefined,
          typeof action.sessionId === 'string' ? action.sessionId : undefined,
        )
        toast.info('Pipeline started', typeof action.minMatchScore === 'number'
          ? `match threshold: ≥${action.minMatchScore}%`
          : 'Orchestrator trigger run')
        break
      case 'stop_run':
        try {
          await stopRun()
          toast.info('Pipeline canceled', 'Background execution has stopped, New applications will not be processed further.')
        } catch (error) {
          toast.error('Cancel run failed', error instanceof Error ? error.message : 'Could not cancel the Agent execution.')
        }
        break
      case 'toggle_agent': {
        const role    = action.role    as string
        const enabled = action.enabled as boolean
        const { error } = await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
        if (error) {
          toast.error('Agent Update failed', error)
          throw new Error(error)
        }
        window.dispatchEvent(new Event('applymate:agents-changed'))
        toast.info(enabled ? `${role} Enabled` : `${role} Disabled`, '')
        break
      }
      case 'update_config': {
        const field = action.field as string
        const value = action.value
        const { error } = await apiMutate('/api/agent', 'PATCH', { [field]: value })
        if (error) {
          toast.error('Settings update failed', error)
          throw new Error(error)
        }
        await refetchAgentConfig()
        toast.success('Settings updated', `${field} → ${value}`)
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
          toast.error('Email sending failed', error)
          throw new Error(error)
        }
        toast.success('Email sent', `Rejection inquiry has been sent to ${emailData.to}`)
      }
      else {
        const { error } = await apiMutate('/api/agent', 'PATCH', { [field]: value })
        if (error) {
          toast.error('Settings update failed', error)
          throw new Error(error)
        }
      }
    }
    setRunLog(prev => prev.map(l =>
      l.questionId === entry.questionId ? { ...l, answered: true } : l
    ))
    addLog({
      type: 'question_answered',
      message: `✓ you chose"${opt.label}"${opt.action ? ', Preference saved' : ''}`,
      time: new Date(),
    })
    toast.success('Preference recorded', opt.action ? 'Settings updated, It will take effect next time it is run' : 'Already aware, continue running')
  }, [addLog, toast])

  const savedCount   = (jobsData?.jobs ?? []).filter(j => j.status === 'saved').length
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.workflowState === 'ready_to_apply').length

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
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

          .agent-session-drawer-actions {
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }

          .agent-session-drawer-collapse {
            display: inline-grid;
            width: 34px;
            height: 34px;
            place-items: center;
            border: 1px solid var(--border);
            border-radius: 10px;
            color: var(--text-muted);
            background: var(--bg);
            cursor: pointer;
          }

          .agent-session-drawer-home {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: 34px;
            padding: 0 10px;
            border: 0;
            border-radius: 10px;
            color: var(--primary);
            background: rgba(79, 70, 229, 0.08);
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 750;
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
          .agent-session-drawer-home,
          .agent-session-drawer-collapse,
          .agent-session-drawer-trigger {
            display: none;
          }

          .agent-session-drawer {
            display: contents;
          }
        }
      `}</style>
      {/* TopBar */}
      <TopBar title={t('agent.title')}>
        <button
          className="agent-session-drawer-trigger"
          type="button"
          aria-expanded={mobileSessionDrawerOpen}
          aria-controls="agent-session-drawer"
          onClick={() => setMobileSessionDrawerOpen(true)}
        >
          <PanelLeftOpen size={15} aria-hidden="true" />
          {t('agent.conversations')}
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
      <div className="agent-workspace-layout" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <button
          className={`agent-session-drawer-scrim${mobileSessionDrawerOpen ? ' is-open' : ''}`}
          type="button"
          aria-label={t('agent.closeConversations')}
          tabIndex={mobileSessionDrawerOpen ? 0 : -1}
          onClick={() => setMobileSessionDrawerOpen(false)}
        />
        <div id="agent-session-drawer" className={`agent-session-drawer${mobileSessionDrawerOpen ? ' is-open' : ''}`}>
          <div className="agent-session-drawer-header">
            <span>{t('agent.conversations')}</span>
            <div className="agent-session-drawer-actions">
              <button className="agent-session-drawer-home" type="button" aria-label={t('agent.backHome')} onClick={() => {
                setMobileSessionDrawerOpen(false)
                navigate('dashboard')
              }}>
                <Home size={15} aria-hidden="true" />
                {t('agent.backHome')}
              </button>
              <button className="agent-session-drawer-collapse" type="button" aria-label={t('agent.collapseConversations')} onClick={() => setMobileSessionDrawerOpen(false)}>
                <PanelLeftClose size={17} aria-hidden="true" />
              </button>
            </div>
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
            onSessionsLoaded={restoreLastSession}
          />
        </div>
        <AgentTurnComposerProvider value={turnComposer}>
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
            resumeSessionId={sessionId}
            conversationTitle={conversationTitle}
            conversationSubtitle={conversationSubtitle}
            onAnswerQuestion={handleAnswerQuestion}
            onAnswerOrchestrator={async (questionId, answer, options) => {
              const opt = options?.find(o => o.value === answer)
              if (opt?.action && opt.action.field !== '_navigate') {
                const { error: patchError } = await apiMutate('/api/agent', 'PATCH', { [opt.action.field]: opt.action.value })
                if (patchError) {
                  toast.error(t('agent.settingsUpdateFailed'), patchError)
                  throw new Error(patchError)
                }
              }
              // Post answer to DB so pipeline can continue
              const { error } = await apiMutate('/api/agent/answer', 'POST', { questionId, answer })
              if (error) {
                toast.error(t('agent.answerFailed'), error)
                throw new Error(error)
              }
              setWaitingQuestion(null)
              setRunLog(prev => prev.map(l => l.questionId === questionId ? { ...l, answered: true } : l))
              addLog({ type: 'user_message', message: options?.find(o => o.value === answer)?.label ?? answer, time: new Date() })
            }}
            onApplied={async (jobId, job) => {
              const { error } = await apiMutate(`/api/jobs/${jobId}/apply`, 'POST', {})
              if (error) {
                toast.error(t('agent.deliveryFailed'), error)
                throw new Error(error)
              }
              setApplyQueue(prev => prev.map(j => j.jobId === jobId ? { ...j, url: `_applied_${j.url}` } : j))
              toast.success(t('agent.markedForDelivery'), `${job.company} · ${job.role}`)
            }}
            onChatAction={handleChatAction}
            onAppendLog={addLog}
            onSessionRecorded={(recordedSessionId, goal, subtitle) => {
              setSessionId(recordedSessionId)
              if (goal) setConversationTitle(goal)
              if (subtitle) setConversationSubtitle(subtitle)
              void fetch(`/api/agent/sessions/${encodeURIComponent(recordedSessionId)}`, { method: 'PATCH' }).catch(() => undefined)
              setSessionsRefreshVersion(v => v + 1)
            }}
          />
        </AgentTurnComposerProvider>
      </div>
    </div>
  )
}
