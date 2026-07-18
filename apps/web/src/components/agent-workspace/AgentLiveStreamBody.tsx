'use client'

import React from 'react'
import { AgentWelcomeTranscript } from '@/components/agent-workspace/AgentWelcomeTranscript'
import { ApplyJobCard, type ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { LiveLogTranscriptBlock, LiveQuestionTranscriptBlock, LiveTranscriptBlock } from '@/components/agent-workspace/LiveTranscriptBlocks'
import type { TranscriptAction } from '@/components/agent-workspace/TranscriptSpecialBlocks'
import { approvalResponseIds, type AgentTranscriptEvent } from '@/components/agent-workspace/session-view-model'
import type { LogEntry, QuestionOption } from '@/components/agent-workspace/live-run-types'
import { shouldStickToBottom } from './AgentUnifiedStream.helpers'

interface AgentLiveStreamBodyProps {
  log: LogEntry[]
  liveBlocks: AgentTranscriptEvent[]
  applyQueue: ApplyReadyJob[]
  isEmpty: boolean
  showWelcome: boolean
  savedCount: number
  pendingCount: number
  autonomousMode: boolean
  revealThinkingVersion: number
  streamScrollRef: React.RefObject<HTMLDivElement | null>
  streamEndRef: React.RefObject<HTMLDivElement | null>
  onSelectPrompt: (prompt: string) => void
  onAnswerQuestion: (entry: LogEntry, opt: QuestionOption) => Promise<void> | void
  onAnswerOrchestrator: (questionId: string, answer: string, options?: QuestionOption[]) => Promise<void> | void
  onApplied: (jobId: string, job: ApplyReadyJob) => void
  onLiveBlockAction: (action: TranscriptAction) => Promise<void> | void
  onFollowStateChange: (following: boolean) => void
}

export function AgentLiveStreamBody({
  log,
  liveBlocks,
  applyQueue,
  isEmpty,
  showWelcome,
  savedCount,
  pendingCount,
  autonomousMode,
  revealThinkingVersion,
  streamScrollRef,
  streamEndRef,
  onSelectPrompt,
  onAnswerQuestion,
  onAnswerOrchestrator,
  onApplied,
  onLiveBlockAction,
  onFollowStateChange,
}: AgentLiveStreamBodyProps) {
  const applyPending = applyQueue.filter((job) => !job.url?.startsWith('_applied'))
  const actedApprovalIds = React.useMemo(() => approvalResponseIds(liveBlocks), [liveBlocks])

  React.useEffect(() => {
    if (!revealThinkingVersion) return
    const target = streamScrollRef.current?.querySelector('[data-agent-event-type="thinking_summary"]')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [revealThinkingVersion, streamScrollRef])

  return (
    <div
      ref={streamScrollRef}
      onScroll={event => onFollowStateChange(shouldStickToBottom(event.currentTarget))}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {isEmpty ? (
        showWelcome ? (
          <div style={{ flex: 1, padding: '4px 0 24px' }}>
            <AgentWelcomeTranscript
              savedCount={savedCount}
              pendingCount={pendingCount}
              autonomousMode={autonomousMode}
              onSelectPrompt={onSelectPrompt}
            />
          </div>
        ) : <div style={{ flex: 1 }} aria-label="New chat" />
      ) : (
        <>
          {log.map((entry, i) => {
            if (entry.type === 'user_message') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="You" accent="var(--primary)" />
            }

            if (entry.type === 'orchestrator_thinking' || entry.type === 'orchestrator_answer') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="Orchestrator" accent="#0F766E" />
            }

            if (entry.type === 'error') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="System" accent="var(--c-danger)" />
            }

            if (entry.type === 'orchestrator_question') {
              return (
                <LiveQuestionTranscriptBlock
                  key={i}
                  entry={entry}
                  speaker="Orchestrator"
                  title={entry.answered ? 'Answer recorded' : 'Approval required'}
                  accent="#0F766E"
                  onSelect={opt => onAnswerOrchestrator(entry.questionId!, opt.value, entry.options)}
                />
              )
            }

            if (entry.type === 'agent_question') {
              return (
                <LiveQuestionTranscriptBlock
                  key={i}
                  entry={entry}
                  speaker={entry.role ? `${entry.role}` : 'Agent'}
                  title={entry.answered ? 'Answer recorded' : 'Options'}
                  accent="#7c3aed"
                  onSelect={opt => onAnswerQuestion(entry, opt)}
                />
              )
            }

            if (entry.type === 'orchestrator_plan' || entry.type === 'orchestrator_complete') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="Orchestrator" accent="#0F766E" title={entry.type === 'orchestrator_complete' ? 'Complete' : 'Plan'} />
            }

            if (entry.type === 'info' && entry.message.includes('queued for manual')) return null

            return <LiveLogTranscriptBlock key={i} entry={entry} speaker={entrySpeaker(entry)} accent={entryAccent(entry)} title={entryTitle(entry)} />
          })}

          {liveBlocks.map(block => (
            <LiveTranscriptBlock
              key={block.id}
              event={block}
              actedApprovalIds={actedApprovalIds}
              revealThinkingVersion={revealThinkingVersion}
              onAction={onLiveBlockAction}
            />
          ))}

          {applyQueue.length > 0 && (
            <div style={{ flexShrink: 0, margin: '8px 0', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>📋</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>待申请队列</span>
                <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, background: 'var(--primary)', color: '#fff', fontWeight: 600 }}>{applyPending.length}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>点击「立即申请」确认投递</span>
              </div>
              {applyQueue.map(job => (
                <ApplyJobCard key={job.jobId} job={job} onApplied={(id) => onApplied(id, job)} />
              ))}
            </div>
          )}
        </>
      )}
      <div ref={streamEndRef} />
    </div>
  )
}

function entrySpeaker(entry: LogEntry) {
  if (entry.role) return entry.role
  if (entry.type.startsWith('agent_')) return 'Analyst'
  if (entry.type.startsWith('orchestrator_')) return 'Orchestrator'
  return 'System'
}

function entryAccent(entry: LogEntry) {
  if (entry.type === 'done' || entry.type === 'role_done') return '#059669'
  if (entry.type === 'error') return '#DC2626'
  if (entry.type.startsWith('orchestrator_')) return '#0F766E'
  if (entry.type.startsWith('agent_')) return '#64748B'
  return '#64748B'
}

function entryTitle(entry: LogEntry) {
  return entry.type.replaceAll('_', ' ')
}
