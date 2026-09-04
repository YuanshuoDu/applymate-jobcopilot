'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { AgentComposer, type ComposerAttachment, type ComposerJob, type ComposerResume } from './AgentComposer'
import { AgentLiveStreamBody } from './AgentLiveStreamBody'
import {
  attachmentComposerContext,
  jobComposerContext,
  resumeComposerContext,
} from './AgentUnifiedStream.helpers'
import { AgentUnifiedStreamHeader } from './AgentUnifiedStreamHeader'
import { sessionSubmissionPolicy } from './automation-policy'
import type { TranscriptAction } from './TranscriptSpecialBlocks'
import { ensureActionReceipt } from './approval-receipt-client'
import { sendAgentTurnMessage, useAgentTurnComposerContext } from './agent-turn-commands'
import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineState } from './v2/timeline-reducer'
import { streamAgentTimeline } from './v2/stream-client'
import { createReadOnlySessionProjection, projectTimelineItems } from './v2/session-projection'
import type { AgentUnifiedStreamProps, ComposerJobsResponse } from './AgentUnifiedStream.types'

function newClientMessageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `message-${crypto.randomUUID()}`
  return `message-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function AgentUnifiedStream({
  log, running, summary, applyQueue, waitingQuestion,
  savedCount, pendingCount, autonomousMode,
  resetVersion, resumeSessionId, conversationTitle, conversationSubtitle, onAnswerQuestion, onAnswerOrchestrator, onApplied, onSessionRecorded,
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
  const [isRestoringSession, setIsRestoringSession] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [timelineState, setTimelineState] = useState<TimelineState>(() => createTimelineState(resumeSessionId ?? 'draft'))
  const [revealThinkingVersion, setRevealThinkingVersion] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<ComposerAttachment[]>([])
  const { data: jobsData } = useApi<ComposerJobsResponse>('/api/jobs?pageSize=6')
  const { data: resumesData } = useApi<ComposerResume[]>('/api/resume')
  const toast = useToast()
  const composerJobs = jobsData?.jobs ?? []
  const composerResumes = resumesData ?? []
  const turnComposer = useAgentTurnComposerContext()
  const timelineItems = useMemo(() => selectTimelineItems(timelineState), [timelineState])
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
  }, [transcriptLog.length, timelineItems.length, applyQueue.length])

  useEffect(() => {
    shouldFollowScrollRef.current = true
    cancelChatRequest()
    setIsRestoringSession(false)
    setChatInput('')
    setTimelineState(createTimelineState('draft'))
    setRevealThinkingVersion(0)
    setAttachedFiles([])
  }, [resetVersion])

  useEffect(() => {
    if (!resumeSessionId) {
      setTimelineState(createTimelineState('draft'))
      setIsRestoringSession(false)
      return
    }
    const controller = new AbortController()
    cancelChatRequest()
    shouldFollowScrollRef.current = true
    setTimelineState(createTimelineState(resumeSessionId))
    setIsRestoringSession(true)
    setChatInput('')
    setAttachedFiles([])

    void streamAgentTimeline({
      sessionId: resumeSessionId,
      signal: controller.signal,
      onConnected: () => {
        if (controller.signal.aborted) return
        setIsRestoringSession(false)
      },
      dispatch: action => {
        if (controller.signal.aborted) return
        setTimelineState(current => timelineReducer(current, action))
        requestAnimationFrame(scrollToBottom)
      },
    })
      .then(() => {
        if (controller.signal.aborted) return
        setIsRestoringSession(false)
        requestAnimationFrame(scrollToBottom)
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setIsRestoringSession(false)
        toast.error(t('agent.restoreFailed'), error instanceof Error ? error.message : t('agent.restoreFailed'))
      })

    return () => controller.abort()
  }, [resumeSessionId, t, toast])

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

  function appendComposerContext(text: string) {
    setChatInput(current => current.trim() ? `${current.trim()}\n\n${text}` : text)
    setAddMenuOpen(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function prefillPrompt(prompt: string) {
    setChatInput(prompt)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function addJobContext(job: ComposerJob) {
    appendComposerContext(jobComposerContext(job))
  }

  function addResumeContext(resume: ComposerResume) {
    appendComposerContext(resumeComposerContext(resume))
  }

  function addSelectedFiles(files: FileList | null) {
    const next = Array.from(files ?? []).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      type: file.type || 'file',
    }))
    if (next.length === 0) return
    setAttachedFiles(current => {
      const existing = new Set(current.map(file => file.id))
      return [...current, ...next.filter(file => !existing.has(file.id))].slice(0, 6)
    })
    toast.info(t('agent.filesAttached'), `${next.length} ${t(next.length === 1 ? 'agent.file' : 'agent.files')} ${t('agent.addedAsContext')}`)
  }

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

  async function sendChat(text: string) {
    if (!text.trim() || chatLoading) return
    const draftText = text.trim()
    const draftFiles = attachedFiles
    const outgoing = [draftText, attachmentComposerContext(attachedFiles)].filter(Boolean).join('\n\n')
    if (turnComposer) {
      turnComposer.send(outgoing)
      setAttachedFiles([])
      return
    }
    setChatInput('')
    setAttachedFiles([])
    setChatLoading(true)
    const requestVersion = chatRequestVersionRef.current + 1
    chatRequestVersionRef.current = requestVersion
    const controller = new AbortController()
    chatRequestRef.current?.abort()
    chatRequestRef.current = controller

    try {
      const sessionResponse = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: draftText }),
        signal: controller.signal,
      })
      const sessionBody = await sessionResponse.json().catch(() => null) as unknown
      const sessionRecord = sessionBody && typeof sessionBody === 'object' && !Array.isArray(sessionBody)
        ? (sessionBody as Record<string, unknown>).session
        : null
      const recordedSessionId = sessionRecord && typeof sessionRecord === 'object' && !Array.isArray(sessionRecord)
        && typeof (sessionRecord as Record<string, unknown>).id === 'string'
        ? (sessionRecord as Record<string, unknown>).id as string
        : null
      if (!sessionResponse.ok || !recordedSessionId) throw new Error('Could not create an Agent session.')
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal })
      await sendAgentTurnMessage(recordedSessionId, outgoing, 'steer', null, newClientMessageId(), fetcher)
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      // Publish the URL only after the typed command is accepted. This avoids
      // switching the composer context while the draft request is still busy.
      shouldFollowScrollRef.current = true
      chatRequestRef.current = null
      setChatLoading(false)
      onSessionRecorded(recordedSessionId, draftText, 'Chat · Running')
    } catch (err) {
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      const message = (err as Error).message || 'Agent chat failed.'
      setChatInput(current => current.trim() ? current : draftText)
      setAttachedFiles(current => current.length > 0 ? current : draftFiles)
      toast.error(t('agent.chatFailed'), message)
    } finally {
      if (requestVersion === chatRequestVersionRef.current) {
        chatRequestRef.current = null
        setChatLoading(false)
      }
    }
  }

  const chips = [
    { label: t('agent.quickAutomate'), prompt: t('agent.quickAutomatePrompt') },
    { label: t('agent.quickReview'), prompt: t('agent.quickReviewPrompt') },
    { label: t('agent.quickExplainScore'), prompt: t('agent.quickExplainScorePrompt') },
    {
      label: t('agent.quickThinking'),
      prompt: t('agent.quickThinkingPrompt'),
      onClick: () => liveBlocks.some(block => block.type === 'thinking_summary')
        ? setRevealThinkingVersion(v => v + 1)
        : appendComposerContext(t('agent.quickThinkingPrompt')),
    },
  ]

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

      <AgentComposer
        waitingForAnswer={!!waitingQuestion && !autonomousMode}
        chips={chips}
        chatInput={chatInput}
        chatLoading={chatLoading}
        addMenuOpen={addMenuOpen}
        attachedFiles={attachedFiles}
        composerJobs={composerJobs}
        composerResumes={composerResumes}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        onChatInputChange={setChatInput}
        onAddMenuOpenChange={setAddMenuOpen}
        onSendChat={sendChat}
        onRemoveAttachedFile={id => setAttachedFiles(current => current.filter(file => file.id !== id))}
        onAddSelectedFiles={addSelectedFiles}
        onAddJobContext={addJobContext}
        onAddResumeContext={addResumeContext}
        onAppendComposerContext={appendComposerContext}
      />
    </div>
  )
}
