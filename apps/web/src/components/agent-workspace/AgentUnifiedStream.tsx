'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { AgentComposer, type ComposerAttachment, type ComposerJob, type ComposerResume } from './AgentComposer'
import { AgentLiveStreamBody } from './AgentLiveStreamBody'
import {
  appendAssistantResponse,
  attachmentComposerContext,
  fallbackActionEvent,
  jobComposerContext,
  liveBlockEvent,
  localCancelEvent,
  resumeComposerContext,
  shouldStickToBottom,
} from './AgentUnifiedStream.helpers'
import { AgentUnifiedStreamHeader } from './AgentUnifiedStreamHeader'
import { sessionSubmissionPolicy } from './automation-policy'
import type { TranscriptAction } from './TranscriptSpecialBlocks'
import { streamAgentChat } from './agent-chat-stream'
import type { AgentTranscriptEvent } from './session-view-model'
import type { AgentUnifiedStreamProps, ComposerJobsResponse } from './AgentUnifiedStream.types'

type ApplyResultRow = {
  status?: unknown
  flowUsed?: unknown
  error?: unknown
  durationMs?: unknown
}

async function pollForAuditResult(
  jobId: string,
  job: Record<string, unknown>,
  setBlocks: React.Dispatch<React.SetStateAction<AgentTranscriptEvent[]>>,
) {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise(resolve => window.setTimeout(resolve, 5_000))
    try {
      const response = await fetch(`/api/jobs/${jobId}/apply-results`)
      if (!response.ok) continue
      const payload = await response.json() as { results?: ApplyResultRow[] }
      const result = payload.results?.[0]
      if (!result) continue
      const status = typeof result.status === 'string' ? result.status : 'completed'
      const detail = typeof result.error === 'string' && result.error
        ? `Error: ${result.error}`
        : `Flow: ${typeof result.flowUsed === 'string' ? result.flowUsed : 'worker'}${typeof result.durationMs === 'number' ? ` · ${Math.round(result.durationMs / 1000)}s` : ''}`
      setBlocks(blocks => [...blocks, liveBlockEvent('audit_result', {
        speaker: 'Auditor', title: 'Application result',
        body: `Auditor result for ${typeof job.company === 'string' ? job.company : 'application'}: ${status}. ${detail}`,
        data: { jobId, job, result },
      }, blocks.length)])
      return
    } catch {
      // Worker/network lag is expected; retry within the bounded observation window.
    }
  }
}

export function AgentUnifiedStream({
  log, running, summary, applyQueue, waitingQuestion,
  savedCount, pendingCount, autonomousMode,
  resetVersion, resumeSessionId, conversationTitle, conversationSubtitle, onAnswerQuestion, onAnswerOrchestrator, onApplied, onChatAction, onAppendLog, onSessionRecorded,
}: AgentUnifiedStreamProps) {
  const { t } = useI18n()
  const streamEndRef = useRef<HTMLDivElement>(null)
  const streamScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeSessionRef = useRef<string | null>(null)
  const chatRequestRef = useRef<AbortController | null>(null)
  const chatRequestVersionRef = useRef(0)
  const shouldFollowScrollRef = useRef(true)
  const auditedJobIdsRef = useRef(new Set<string>())
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [isRestoringSession, setIsRestoringSession] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [liveBlocks, setLiveBlocks] = useState<AgentTranscriptEvent[]>([])
  const [revealThinkingVersion, setRevealThinkingVersion] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<ComposerAttachment[]>([])
  const { data: jobsData } = useApi<ComposerJobsResponse>('/api/jobs?pageSize=6')
  const { data: resumesData } = useApi<ComposerResume[]>('/api/resume')
  const toast = useToast()
  const composerJobs = jobsData?.jobs ?? []
  const composerResumes = resumesData ?? []

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
  }, [log.length, liveBlocks.length, applyQueue.length])

  useEffect(() => {
    activeSessionRef.current = chatSessionId
  }, [chatSessionId])

  useEffect(() => {
    shouldFollowScrollRef.current = true
    cancelChatRequest()
    activeSessionRef.current = null
    setChatSessionId(null)
    setIsRestoringSession(false)
    setChatInput('')
    setLiveBlocks([])
    setRevealThinkingVersion(0)
    setAttachedFiles([])
  }, [resetVersion])

  useEffect(() => {
    // A newly-created chat reports its session ID to the parent before its
    // SSE blocks finish arriving. Do not treat that echo as a history restore.
    if (!resumeSessionId || resumeSessionId === activeSessionRef.current) return
    const controller = new AbortController()
    cancelChatRequest()
    shouldFollowScrollRef.current = true
    activeSessionRef.current = resumeSessionId
    setChatSessionId(resumeSessionId)
    setIsRestoringSession(true)
    setChatInput('')
    setAttachedFiles([])
    // Do not leave the prior conversation visible while the next session's
    // authorized transcript is loading.
    setLiveBlocks([])

    void fetch(`/api/agent/sessions/${resumeSessionId}/events`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(t('agent.restoreFailed'))
        return response.json() as Promise<{ events?: AgentTranscriptEvent[] }>
      })
      .then(data => {
        if (controller.signal.aborted) return
        setLiveBlocks(data.events ?? [])
        setIsRestoringSession(false)
        requestAnimationFrame(scrollToBottom)
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setIsRestoringSession(false)
        toast.error(t('agent.restoreFailed'), error instanceof Error ? error.message : t('agent.restoreFailed'))
      })

    return () => controller.abort()
  }, [resumeSessionId, toast])

  // The worker persists the eventual submission result. Once Executor queues a
  // user-confirmed package, surface that result in the same conversation as an
  // Auditor event instead of asking the user to hunt through another page.
  useEffect(() => {
    const queued = liveBlocks.filter(block => block.type === 'application_queued')
    for (const block of queued) {
      const rawData = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {}
      const data = rawData.payload && typeof rawData.payload === 'object'
        ? rawData.payload as Record<string, unknown>
        : rawData
      const job = data.job && typeof data.job === 'object' ? data.job as Record<string, unknown> : data
      const jobId = typeof data.jobId === 'string'
        ? data.jobId
        : typeof job.id === 'string' ? job.id : null
      if (!jobId || auditedJobIdsRef.current.has(jobId)) continue
      auditedJobIdsRef.current.add(jobId)
      void pollForAuditResult(jobId, job, setLiveBlocks)
    }
  }, [liveBlocks])

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

  const isEmpty = !isRestoringSession && log.length === 0 && applyQueue.length === 0 && liveBlocks.length === 0
  const isNewChatDraft = isEmpty
  const restoredPolicy = sessionSubmissionPolicy(liveBlocks)
  const effectiveAutonomousMode = restoredPolicy
    ? restoredPolicy === 'autopilot'
    : autonomousMode

  useEffect(() => {
    if (!isEmpty) return
    streamScrollRef.current?.scrollTo({ top: 0 })
  }, [isEmpty, resetVersion])

  function appendLiveBlock(type: string, data: unknown) {
    setLiveBlocks(blocks => [...blocks, liveBlockEvent(type, data, blocks.length)])
  }

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
      setLiveBlocks(blocks => [...blocks, localCancelEvent(action)])
      return
    }
    if (!chatSessionId) {
      const message = 'Send a message first, then retry this action.'
      toast.error(t('agent.sessionNotReady'), message)
      throw new Error(message)
    }
    const { data, error } = await apiMutate<{ event?: AgentTranscriptEvent; events?: AgentTranscriptEvent[] }>(`/api/agent/sessions/${chatSessionId}/actions`, 'POST', action)
    if (error) throw new Error(error)
    const eventType = data?.event?.type
    if (action.type === 'create_automation' || eventType === 'automation_created' || eventType === 'automation_updated') {
      window.dispatchEvent(new Event('applymate:automations-changed'))
    }
    window.dispatchEvent(new Event('applymate:sessions-changed'))
    onSessionRecorded(chatSessionId)
    const events = data?.events?.length ? data.events : [data?.event ?? fallbackActionEvent(action)]
    setLiveBlocks(blocks => [...blocks, ...events])
  }

  async function sendChat(text: string) {
    if (!text.trim() || chatLoading) return
    const draftText = text.trim()
    const draftFiles = attachedFiles
    const outgoing = [draftText, attachmentComposerContext(attachedFiles)].filter(Boolean).join('\n\n')
    setChatInput('')
    setAttachedFiles([])
    setChatLoading(true)
    onAppendLog({ type: 'user_message', message: outgoing, time: new Date() })
    let recordedSessionId = chatSessionId
    const requestVersion = chatRequestVersionRef.current + 1
    chatRequestVersionRef.current = requestVersion
    const controller = new AbortController()
    chatRequestRef.current?.abort()
    chatRequestRef.current = controller

    try {
      const full = await streamAgentChat({
        sessionId: chatSessionId,
        signal: controller.signal,
        messages: [{ role: 'user', content: outgoing }],
        onSession: sessionId => {
          if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
          shouldFollowScrollRef.current = true
          recordedSessionId = sessionId
          activeSessionRef.current = sessionId
          setChatSessionId(sessionId)
          onSessionRecorded(sessionId, draftText, 'Chat · Running')
        },
        onBlock: (type, data) => {
          if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
          appendLiveBlock(type, data)
        },
        // The pipeline start resets its operational log. Keep the originating
        // user message as the first transcript item instead of losing it.
        onAction: action => {
          if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
          return onChatAction({ ...action, chatMessage: outgoing, sessionId: activeSessionRef.current })
        },
      })
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      appendAssistantResponse(full, onAppendLog)
      if (recordedSessionId) onSessionRecorded(recordedSessionId)
    } catch (err) {
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      const message = (err as Error).message || 'Agent chat failed.'
      setChatInput(current => current.trim() ? current : draftText)
      setAttachedFiles(current => current.length > 0 ? current : draftFiles)
      onAppendLog({ type: 'error', message, time: new Date() })
      toast.error(t('agent.chatFailed'), message)
    } finally {
      if (requestVersion === chatRequestVersionRef.current) {
        chatRequestRef.current = null
        setChatLoading(false)
      }
    }
  }

  const chips = [
    { label: 'Automate', prompt: 'Create a weekday 09:00 automation to find and score suitable roles.' },
    { label: 'Review', prompt: `Review the ${pendingCount} pending role${pendingCount === 1 ? '' : 's'} and recommend approve or skip.` },
    { label: 'Explain score', prompt: 'Explain the latest high-match role, including scoring evidence and resume gaps.' },
    {
      label: 'Thinking',
      prompt: 'Show a reasoning summary and the supporting evidence for this Agent decision.',
      onClick: () => liveBlocks.some(block => block.type === 'thinking_summary')
        ? setRevealThinkingVersion(v => v + 1)
        : appendComposerContext('Show a reasoning summary and the supporting evidence for this Agent decision.'),
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
        log={log}
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
