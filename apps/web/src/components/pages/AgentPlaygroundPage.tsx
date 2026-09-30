'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useToast } from '@/components/ui'
import { useApi }   from '@/lib/hooks'
import type { AgentConfig } from '@/lib/types'
import { AgentUnifiedStream } from '@/components/agent-workspace/AgentUnifiedStream'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { AgentSessionConsole } from '@/components/agent-workspace/AgentSessionConsole'
import { AgentPlaygroundWorkspace } from './AgentPlaygroundWorkspace'
import { useAgentPlaygroundActions } from './useAgentPlaygroundActions'
import { useAgentPlaygroundRun } from './useAgentPlaygroundRun'
import { AgentSupervisorPanel } from '@/components/agent-workspace/v2/AgentSupervisorPanel'
import { sessionHeaderSubtitle, type AgentSessionsResponse } from '@/components/agent-workspace/session-view-model'
import type { LogEntry, QuestionOption } from '@/components/agent-workspace/live-run-types'
import type { SubmissionPolicySettings } from '@/components/agent-workspace/automation-policy'
import { useAgentSessionState, useAgentSessionUrl, type ActiveTurnStatus } from '@/components/agent-workspace/agent-session-state'
import { AgentTurnComposerProvider, useAgentTurnComposer } from '@/components/agent-workspace/agent-turn-commands'
import { useAgentTimeline } from '@/components/agent-workspace/v2/use-agent-timeline'

// ── Role metadata ─────────────────────────────────────────────────────────────

// ── Log entry (per-agent) ─────────────────────────────────────────────────────

// ── Chat types ────────────────────────────────────────────────────────────────

// ── Main Page ─────────────────────────────────────────────────────────────────

export function isDurableTurnRunning(status: ActiveTurnStatus | undefined): boolean {
  return status === 'queued' || status === 'in_progress'
}

const previewApplicationReviewJob: ApplyReadyJob = {
  jobId: 'fixture-application-review-job',
  company: 'Fixture Robotics',
  role: 'Backend Engineer',
  score: 92,
  url: 'https://jobs.example.test/apply',
  location: 'Dublin, IE',
  coverLetter: 'Fixture cover letter for review only. No application will be submitted.',
  matchedKeywords: ['TypeScript', 'PostgreSQL'],
  mode: 'manual',
}

export function AgentPlaygroundPage({ seedApplicationReviewQueue = false }: { seedApplicationReviewQueue?: boolean }) {
  const toast = useToast()

  const { data: jobsData }                               = useApi<{ jobs: Array<{ status: string; workflowState: string }> }>('/api/jobs?pageSize=100')
  const { data: agentConfig } = useApi<AgentConfig>('/api/agent')

  const [showAddModal,  setShowAddModal]  = useState(false)
  const [applyQueue,    setApplyQueue]    = useState<ApplyReadyJob[]>(() => seedApplicationReviewQueue ? [previewApplicationReviewJob] : [])
  const { sessionId, setSessionId } = useAgentSessionUrl()
  const selectedSessionId = sessionId
  const timeline = useAgentTimeline(selectedSessionId)
  const { activeTurn, refetch: refetchTurnState } = useAgentSessionState(sessionId)
  const turnComposer = useAgentTurnComposer(sessionId, activeTurn, refetchTurnState)
  const [conversationTitle, setConversationTitle] = useState<string | null>(null)
  const [conversationSubtitle, setConversationSubtitle] = useState<string | null>(null)
  const [sessionsRefreshVersion, setSessionsRefreshVersion] = useState(0)
  const [chatResetVersion, setChatResetVersion] = useState(0)
  const [mobileSessionDrawerOpen, setMobileSessionDrawerOpen] = useState(false)
  const [waitingQuestion, setWaitingQuestion] = useState<{ id: string; question: string; options: QuestionOption[] } | null>(null)
  const [activeRunPolicy, setActiveRunPolicy] = useState<SubmissionPolicySettings | null>(null)

  const initialSessionRestoredRef = useRef(false)
  const {
    currentRole, runLog, setRunLog, runDone, runSummary, addLog, startRun, stopRun, resetRun,
  } = useAgentPlaygroundRun({
    agentConfig,
    toast,
    sessionId,
    setWaitingQuestion,
    setActiveRunPolicy,
    setApplyQueue,
    setSessionsRefreshVersion,
  })
  const autonomousMode = Boolean(
    (activeRunPolicy ?? agentConfig)?.autoApply && !(activeRunPolicy ?? agentConfig)?.requireApproval,
  )

  useEffect(() => {
    if (!selectedSessionId || timeline.lifecycleRevision === 0) return
    // The canonical timeline is the live source for Turn lifecycle changes.
    // Refresh the command projection so Stop and steer controls do not lag it.
    refetchTurnState()
  }, [refetchTurnState, selectedSessionId, timeline.lifecycleRevision])

  const { handleAnswerQuestion, handleAnswerOrchestrator, handleApplied } = useAgentPlaygroundActions({
    toast,
    addLog,
    setRunLog,
    setWaitingQuestion,
    setApplyQueue,
  })

  useEffect(() => {
    if (!mobileSessionDrawerOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileSessionDrawerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileSessionDrawerOpen])

  const resetLiveWorkspace = useCallback(() => {
    resetRun(false)
    setSessionId(null)
    setConversationTitle(null)
    setConversationSubtitle(null)
    setChatResetVersion(v => v + 1)
  }, [resetRun, setSessionId])
  const selectSession = useCallback((sessionId: string, goal = 'Automation run', subtitle = 'Automation run') => {
    resetRun(true)
    setSessionId(sessionId)
    setConversationTitle(goal)
    setConversationSubtitle(subtitle)
    // The server owns this preference and scopes it to the authenticated user.
    void fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH' }).catch(() => undefined)
  }, [resetRun, setSessionId])

  const selectAutomationSession = useCallback((sessionId: string, policy: SubmissionPolicySettings) => {
    // The automation route has already enqueued the canonical Worker task.
    // Attach the UI to that durable session instead of starting a legacy SSE run.
    selectSession(sessionId)
    setActiveRunPolicy(policy)
  }, [selectSession])

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

  // Waiting gates remain in activeTurn for Stop/Steer/approval controls, but
  // the header should reserve Running for work that is actively progressing.
  const isRunning = isDurableTurnRunning(activeTurn?.status) || !!currentRole || (runLog.length > 0 && !runDone)
  const visibleWaitingQuestion = waitingQuestion && runLog.some(entry =>
    entry.type === 'orchestrator_question'
      && entry.questionId === waitingQuestion.id
      && !entry.answered,
  ) ? waitingQuestion : null

  const savedCount   = (jobsData?.jobs ?? []).filter(j => j.status === 'saved').length
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.workflowState === 'ready_to_apply').length

  const sessionProps: React.ComponentProps<typeof AgentSessionConsole> = {
    selectedSessionId,
    onSelectSession: (id, goal, subtitle) => {
      selectSession(id, goal, subtitle)
      setMobileSessionDrawerOpen(false)
    },
    onRunSession: (id, policy) => {
      selectAutomationSession(id, policy)
      setMobileSessionDrawerOpen(false)
    },
    onAddAgent: () => setShowAddModal(true),
    onNewChat: () => {
      resetLiveWorkspace()
      setMobileSessionDrawerOpen(false)
    },
    onDeletedSession: handleDeletedSession,
    refreshVersion: sessionsRefreshVersion,
    onSessionsLoaded: restoreLastSession,
  }

  return (
    <AgentPlaygroundWorkspace
      showAddModal={showAddModal}
      setShowAddModal={setShowAddModal}
      mobileSessionDrawerOpen={mobileSessionDrawerOpen}
      setMobileSessionDrawerOpen={setMobileSessionDrawerOpen}
      sessionProps={sessionProps}
    >
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
            timeline={timeline}
            conversationTitle={conversationTitle}
            conversationSubtitle={conversationSubtitle}
            onAnswerQuestion={handleAnswerQuestion}
            onAnswerOrchestrator={handleAnswerOrchestrator}
            onApplied={handleApplied}
            onSessionRecorded={(recordedSessionId, goal, subtitle) => {
              setSessionId(recordedSessionId)
              if (goal) setConversationTitle(goal)
              if (subtitle) setConversationSubtitle(subtitle)
              void fetch(`/api/agent/sessions/${encodeURIComponent(recordedSessionId)}`, { method: 'PATCH' }).catch(() => undefined)
              setSessionsRefreshVersion(v => v + 1)
            }}
          />
        </AgentTurnComposerProvider>
        <AgentSupervisorPanel sessionId={selectedSessionId} timeline={timeline} />
    </AgentPlaygroundWorkspace>
  )
}
