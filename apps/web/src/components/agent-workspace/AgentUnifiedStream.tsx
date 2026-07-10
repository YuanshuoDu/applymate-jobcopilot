'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import { MODEL_CATALOGUE } from '@/lib/model-router'
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
} from './AgentUnifiedStream.helpers'
import { AgentUnifiedStreamHeader } from './AgentUnifiedStreamHeader'
import type { TranscriptAction } from './TranscriptSpecialBlocks'
import { streamAgentChat } from './agent-chat-stream'
import type { AgentTranscriptEvent } from './session-view-model'
import type { AgentUnifiedStreamProps, ComposerJobsResponse } from './AgentUnifiedStream.types'

export function AgentUnifiedStream({
  log, running, summary, applyQueue, waitingQuestion,
  savedCount, pendingCount, autonomousMode,
  resetVersion, onAnswerQuestion, onAnswerOrchestrator, onApplied, onChatAction, onAppendLog, onSessionRecorded,
}: AgentUnifiedStreamProps) {
  const streamEndRef = useRef<HTMLDivElement>(null)
  const streamScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const defaultModel = MODEL_CATALOGUE[0]
  const [selectedModel, setSelectedModel] = useState(`${defaultModel.provider}::${defaultModel.model}`)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [liveBlocks, setLiveBlocks] = useState<AgentTranscriptEvent[]>([])
  const [revealThinkingVersion, setRevealThinkingVersion] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<ComposerAttachment[]>([])
  const { data: jobsData } = useApi<ComposerJobsResponse>('/api/jobs?pageSize=6')
  const { data: resumesData } = useApi<ComposerResume[]>('/api/resume')
  const toast = useToast()
  const composerJobs = jobsData?.jobs ?? []
  const composerResumes = resumesData ?? []

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log.length, liveBlocks.length, applyQueue.length])

  useEffect(() => {
    setChatSessionId(null)
    setChatInput('')
    setLiveBlocks([])
    setRevealThinkingVersion(0)
    setAttachedFiles([])
  }, [resetVersion])

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

  const isEmpty = log.length === 0 && applyQueue.length === 0 && liveBlocks.length === 0

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
    toast.info('附件已添加', `${next.length} 个文件会作为上下文提示给 Agent`)
  }

  async function handleLiveBlockAction(action: TranscriptAction) {
    if (action.type === 'edit_automation_draft') {
      setChatInput(action.prompt ?? '请编辑这个自动化草稿：')
      setTimeout(() => inputRef.current?.focus(), 0)
      return
    }
    if (action.type === 'cancel_automation_draft') {
      setLiveBlocks(blocks => [...blocks, localCancelEvent(action)])
      return
    }
    if (!chatSessionId) {
      const message = 'Send a message first, then retry this action.'
      toast.error('Session not ready', message)
      throw new Error(message)
    }
    const { data, error } = await apiMutate<{ event?: AgentTranscriptEvent }>(`/api/agent/sessions/${chatSessionId}/actions`, 'POST', action)
    if (error) throw new Error(error)
    const eventType = data?.event?.type
    if (action.type === 'create_automation' || eventType === 'automation_created' || eventType === 'automation_updated') {
      window.dispatchEvent(new Event('applymate:automations-changed'))
    }
    window.dispatchEvent(new Event('applymate:sessions-changed'))
    onSessionRecorded(chatSessionId)
    setLiveBlocks(blocks => [...blocks, data?.event ?? fallbackActionEvent(action)])
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

    try {
      const full = await streamAgentChat({
        sessionId: chatSessionId,
        messages: [{ role: 'user', content: outgoing }],
        model: selectedModel,
        onSession: sessionId => {
          setChatSessionId(sessionId)
          onSessionRecorded(sessionId)
        },
        onBlock: appendLiveBlock,
        onAction: onChatAction,
      })
      appendAssistantResponse(full, onAppendLog)
    } catch (err) {
      const message = (err as Error).message || 'Agent chat failed.'
      setChatInput(current => current.trim() ? current : draftText)
      setAttachedFiles(current => current.length > 0 ? current : draftFiles)
      onAppendLog({ type: 'error', message, time: new Date() })
      toast.error('Chat failed', message)
    } finally {
      setChatLoading(false)
    }
  }

  const chips = [
    { label: 'Create automation', prompt: '创建一个工作日 09:00 的自动化任务，帮我搜索并评分合适职位。' },
    { label: 'Review pending', prompt: `审核 ${pendingCount} 个待定职位，并给出批准/跳过建议。` },
    { label: 'Explain score', prompt: '解释最近高分职位的评分依据和缺口。' },
    {
      label: 'Show thinking',
      prompt: '展示本次 agent 判断的思考摘要和证据。',
      onClick: () => liveBlocks.some(block => block.type === 'thinking_summary')
        ? setRevealThinkingVersion(v => v + 1)
        : appendComposerContext('展示本次 agent 判断的思考摘要和证据。'),
    },
  ]

  return (
    <div className="agent-live-stream" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      <AgentUnifiedStreamHeader running={running} summary={summary} approvalRequired={Boolean(waitingQuestion && !autonomousMode)} />

      <AgentLiveStreamBody
        log={log}
        liveBlocks={liveBlocks}
        applyQueue={applyQueue}
        isEmpty={isEmpty}
        savedCount={savedCount}
        pendingCount={pendingCount}
        autonomousMode={autonomousMode}
        revealThinkingVersion={revealThinkingVersion}
        streamScrollRef={streamScrollRef}
        streamEndRef={streamEndRef}
        onSelectPrompt={prefillPrompt}
        onAnswerQuestion={onAnswerQuestion}
        onAnswerOrchestrator={onAnswerOrchestrator}
        onApplied={onApplied}
        onLiveBlockAction={async action => {
          try {
            await handleLiveBlockAction(action)
          } catch (err) {
            toast.error('Action failed', (err as Error).message || 'Action failed.')
            throw err
          }
        }}
      />

      <AgentComposer
        waitingForAnswer={!!waitingQuestion && !autonomousMode}
        chips={chips}
        chatInput={chatInput}
        chatLoading={chatLoading}
        selectedModel={selectedModel}
        addMenuOpen={addMenuOpen}
        attachedFiles={attachedFiles}
        composerJobs={composerJobs}
        composerResumes={composerResumes}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        onChatInputChange={setChatInput}
        onSelectedModelChange={setSelectedModel}
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
