'use client'

import React from 'react'
import { AgentWelcomeTranscript } from '@/components/agent-workspace/AgentWelcomeTranscript'
import { ApplyJobCard, type ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { LiveLogTranscriptBlock, LiveQuestionTranscriptBlock, LiveTranscriptBlock, SmartMessage } from '@/components/agent-workspace/LiveTranscriptBlocks'
import type { TranscriptAction } from '@/components/agent-workspace/TranscriptSpecialBlocks'
import { approvalResponseIds, type AgentTranscriptEvent } from '@/components/agent-workspace/session-view-model'
import type { LogEntry, QuestionOption } from '@/components/agent-workspace/live-run-types'

interface AgentLiveStreamBodyProps {
  log: LogEntry[]
  liveBlocks: AgentTranscriptEvent[]
  applyQueue: ApplyReadyJob[]
  isEmpty: boolean
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
}

export function AgentLiveStreamBody({
  log,
  liveBlocks,
  applyQueue,
  isEmpty,
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
}: AgentLiveStreamBodyProps) {
  const applyPending = applyQueue.filter((job) => !job.url?.startsWith('_applied'))
  const actedApprovalIds = React.useMemo(() => approvalResponseIds(liveBlocks), [liveBlocks])

  React.useEffect(() => {
    if (!revealThinkingVersion) return
    const target = streamScrollRef.current?.querySelector('[data-agent-event-type="thinking_summary"]')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [revealThinkingVersion, streamScrollRef])

  return (
    <div ref={streamScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {isEmpty ? (
        <div style={{ flex: 1, padding: '4px 0 24px' }}>
          <AgentWelcomeTranscript
            savedCount={savedCount}
            pendingCount={pendingCount}
            autonomousMode={autonomousMode}
            onSelectPrompt={onSelectPrompt}
          />
        </div>
      ) : (
        <>
          {log.map((entry, i) => {
            if (entry.type === 'user_message') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="You" accent="var(--primary)" />
            }

            if (entry.type === 'orchestrator_thinking' || entry.type === 'orchestrator_answer') {
              return <LiveLogTranscriptBlock key={i} entry={entry} speaker="Orchestrator" accent="#4f46e5" />
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
                  accent="#d97706"
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
              const isComplete = entry.type === 'orchestrator_complete'
              return (
                <div key={i} style={{ margin: '6px 0', padding: '8px 12px', borderRadius: 8, background: isComplete ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.06)', border: `1px solid ${isComplete ? 'rgba(52,211,153,0.25)' : 'rgba(245,158,11,0.2)'}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15 }}>{isComplete ? '✅' : '🧠'}</span>
                  <span style={{ fontSize: 11, color: isComplete ? '#34d399' : '#f59e0b', fontWeight: 500 }}>{entry.message}</span>
                </div>
              )
            }

            if (entry.type === 'info' && entry.message.includes('queued for manual')) return null

            const indent = entry.type === 'agent_observation' ? 16 : entry.type === 'agent_plan' ? 8 : 0
            return (
              <div key={i} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                padding: `2px 0`,
                paddingLeft: indent,
                background: entry.type === 'agent_plan' ? 'rgba(79,70,229,0.03)' : 'transparent',
                borderLeft: entry.type === 'agent_plan' ? '2px solid rgba(129,140,248,0.3)' : 'none',
              }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 3, fontVariantNumeric: 'tabular-nums', minWidth: 58 }}>
                  {entry.time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {entryPrefix(entry) && (
                    <span style={{ fontSize: 11, color: entryColor(entry), fontFamily: 'monospace' }}>{entryPrefix(entry)}</span>
                  )}
                  <SmartMessage text={entry.message} color={entryColor(entry)} />
                </div>
              </div>
            )
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
            <div style={{ margin: '8px 0', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
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

function entryColor(e: LogEntry): string {
  if (e.type === 'done')                 return 'var(--c-success)'
  if (e.type === 'error')                return 'var(--c-danger)'
  if (e.type === 'role_start')           return 'var(--primary)'
  if (e.type === 'role_done')            return 'var(--c-success)'
  if (e.type === 'job_skip')             return 'var(--text-muted)'
  if (e.type === 'agent_plan')           return '#818cf8'
  if (e.type === 'agent_action')         return 'var(--text)'
  if (e.type === 'agent_observation')    return '#94a3b8'
  if (e.type === 'agent_reflect')        return 'var(--c-success)'
  if (e.type === 'orchestrator_thinking')return '#f59e0b'
  if (e.type === 'orchestrator_fix')     return '#f97316'
  if (e.type === 'orchestrator_retry')   return '#fb923c'
  if (e.type === 'orchestrator_decision')return '#a78bfa'
  if (e.type === 'orchestrator_complete')return '#34d399'
  if (e.type === 'orchestrator_answer')  return 'var(--c-success)'
  if (e.type === 'user_message')         return '#fff'
  if (e.score != null)                   return e.score >= 80 ? 'var(--c-success)' : e.score >= 60 ? 'var(--c-warning)' : 'var(--text-muted)'
  return 'var(--text)'
}

function entryPrefix(e: LogEntry): string {
  if (e.type === 'agent_plan')            return '📋 '
  if (e.type === 'agent_action')          return '⚡ '
  if (e.type === 'agent_observation')     return '   👁 '
  if (e.type === 'agent_reflect')         return '💬 '
  if (e.type === 'orchestrator_fix')      return '🔧 '
  if (e.type === 'orchestrator_retry')    return '🔄 '
  if (e.type === 'orchestrator_decision') return '⚖ '
  return ''
}
