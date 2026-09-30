'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { ComposerAttachment, ComposerResume } from './AgentComposer'
import { AgentUnifiedStreamComposer } from './AgentUnifiedStreamComposer'
import { AgentLiveStreamBody } from './AgentLiveStreamBody'
import { AgentUnifiedStreamHeader } from './AgentUnifiedStreamHeader'
import { sessionSubmissionPolicy } from './automation-policy'
import type { TranscriptAction } from './TranscriptSpecialBlocks'
import { ensureActionReceipt } from './approval-receipt-client'
import { createReadOnlySessionProjection, projectTimelineItems } from './v2/session-projection'
import type { AgentUnifiedStreamProps, ComposerJobsResponse } from './AgentUnifiedStream.types'

export function AgentUnifiedStream({
  log, running, summary, applyQueue, waitingQuestion,
  savedCount, pendingCount, autonomousMode,
  resetVersion, resumeSessionId, timeline, conversationTitle, conversationSubtitle, onAnswerQuestion, onAnswerOrchestrator, onApplied, onSessionRecorded,
}: AgentUnifiedStreamProps) {
  const { t } = useI18n()
  const streamEndRef = useRef<HTMLDivElement>(null)
  const streamScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatRequestRef = useRef<AbortController | null>(null)
  const chatRequestVersionRef = useRef(0)
  const shouldFollowScrollRef = useRef(true)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [revealThinkingVersion, setRevealThinkingVersion] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<ComposerAttachment[]>([])
  const { data: jobsData } = useApi<ComposerJobsResponse>('/api/jobs?pageSize=6')
  const { data: resumesData } = useApi<ComposerResume[]>('/api/resume')
  const toast = useToast()
  const composerJobs = jobsData?.jobs ?? []
  const composerResumes = resumesData ?? []
  const timelineItems = timeline.items
  const isRestoringSession = timeline.restoring
  // Once a Session exists, the V2 projection is the sole transcript source.
  // The page-level run log remains an operational control signal, not a second
  // rendered conversation state.
  const transcriptLog = resumeSessionId ? [] : log
  const projection = useMemo(
    () => createReadOnlySessionProjection(resumeSessionId ?? 'draft', timelineItems),
    [resumeSessionId, timelineItems],
  )
  const liveBlocks = useMemo(() => projectTimelineItems(projection), [projection])

  function scrollToBottom() {
    const stream = streamScrollRef.current
    if (!stream) return
    stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' })
  }

  function cancelChatRequest() {
    chatRequestVersionRef.current += 1
    chatRequestRef.current?.abort()
    chatRequestRef.current = null
  }

  useEffect(() => {
    if (shouldFollowScrollRef.current) scrollToBottom()
  }, [transcriptLog.length, timelineItems, applyQueue.length])

  useEffect(() => {
    shouldFollowScrollRef.current = true
    cancelChatRequest()
    setChatInput('')
    setRevealThinkingVersion(0)
    setAttachedFiles([])
  }, [resetVersion])

  useEffect(() => {
    cancelChatRequest()
    shouldFollowScrollRef.current = true
    setChatInput('')
    setAttachedFiles([])
  }, [resumeSessionId])

  useEffect(() => {
    function prefillComposer(event: Event) {
      const detail = event instanceof CustomEvent ? event.detail : null
      if (typeof detail !== 'string') return
      setChatInput(detail)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener('applymate:composer-prefill', prefillComposer)
    return () => window.removeEventListener('applymate:composer-prefill', prefillComposer)
  }, [])

  const isEmpty = !isRestoringSession && transcriptLog.length === 0 && applyQueue.length === 0 && liveBlocks.length === 0
  const isNewChatDraft = isEmpty
  const restoredPolicy = sessionSubmissionPolicy(liveBlocks)
  const effectiveAutonomousMode = restoredPolicy
    ? restoredPolicy === 'autopilot'
    : autonomousMode

  useEffect(() => {
    if (!isEmpty) return
    streamScrollRef.current?.scrollTo({ top: 0 })
  }, [isEmpty, resetVersion])

  async function handleLiveBlockAction(action: TranscriptAction) {
    if (action.type === 'edit_automation_draft') {
      setChatInput(action.prompt ?? 'Edit this automation draft:')
      setTimeout(() => inputRef.current?.focus(), 0)
      return
    }
    if (action.type === 'cancel_automation_draft') {
      toast.info('Automation draft canceled', action.body ?? 'The draft was not saved.')
      return
    }
    if (!resumeSessionId) {
      const message = 'Send a message first, then retry this action.'
      toast.error(t('agent.sessionNotReady'), message)
      throw new Error(message)
    }
    const authorizedAction = await ensureActionReceipt(resumeSessionId, action)
    const { data, error } = await apiMutate<unknown>(`/api/agent/sessions/${resumeSessionId}/actions`, 'POST', authorizedAction)
    if (error) throw new Error(error)
    const dataRecord = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null
    const eventRecord = dataRecord?.event && typeof dataRecord.event === 'object' && !Array.isArray(dataRecord.event)
      ? dataRecord.event as Record<string, unknown>
      : null
    const eventType = typeof eventRecord?.type === 'string' ? eventRecord.type : null
    if (action.type === 'create_automation' || eventType === 'automation_created' || eventType === 'automation_updated') {
      window.dispatchEvent(new Event('applymate:automations-changed'))
    }
    window.dispatchEvent(new Event('applymate:sessions-changed'))
    onSessionRecorded(resumeSessionId)
  }

  return (
    <div className="agent-live-stream" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      <AgentUnifiedStreamHeader
        hideForNewChat={isNewChatDraft}
        running={running}
        summary={summary}
        approvalRequired={Boolean(waitingQuestion && !effectiveAutonomousMode)}
        autonomousMode={effectiveAutonomousMode}
        conversationTitle={conversationTitle}
        conversationSubtitle={conversationSubtitle}
      />

      {timeline.error && (
        <div role="alert" style={{ flexShrink: 0, margin: '10px 18px 0', padding: '9px 12px', border: '1px solid var(--c-danger)', borderRadius: 8, color: 'var(--c-danger)', background: 'var(--bg-secondary)', fontSize: 11 }}>
          {t('agent.restoreFailed')}
        </div>
      )}
      <AgentLiveStreamBody
        log={transcriptLog}
        liveBlocks={liveBlocks}
        applyQueue={applyQueue}
        isEmpty={isEmpty}
        isRestoringSession={isRestoringSession}
        revealThinkingVersion={revealThinkingVersion}
        streamScrollRef={streamScrollRef}
        streamEndRef={streamEndRef}
        onAnswerQuestion={onAnswerQuestion}
        onAnswerOrchestrator={onAnswerOrchestrator}
        onApplied={onApplied}
        onLiveBlockAction={async action => {
          try {
            await handleLiveBlockAction(action)
          } catch (err) {
            toast.error(t('agent.actionFailed'), (err as Error).message || t('agent.actionFailed'))
            throw err
          }
        }}
        onFollowStateChange={following => { shouldFollowScrollRef.current = following }}
      />

      <AgentUnifiedStreamComposer
        waitingForAnswer={!!waitingQuestion && !autonomousMode}
        chatInput={chatInput}
        setChatInput={setChatInput}
        chatLoading={chatLoading}
        setChatLoading={setChatLoading}
        addMenuOpen={addMenuOpen}
        setAddMenuOpen={setAddMenuOpen}
        attachedFiles={attachedFiles}
        setAttachedFiles={setAttachedFiles}
        composerJobs={composerJobs}
        composerResumes={composerResumes}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        chatRequestRef={chatRequestRef}
        chatRequestVersionRef={chatRequestVersionRef}
        shouldFollowScrollRef={shouldFollowScrollRef}
        liveBlocks={liveBlocks}
        setRevealThinkingVersion={setRevealThinkingVersion}
        onSessionRecorded={onSessionRecorded}
      />
    </div>
  )
}
