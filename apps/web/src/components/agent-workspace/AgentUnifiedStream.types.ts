import type { ApplyReadyJob } from './ApplyJobCard'
import type { ComposerJob } from './AgentComposer'
import type { AgentChatAction } from './agent-chat-stream'
import type { LogEntry, QuestionOption, RunSummary } from './live-run-types'

export interface ComposerJobsResponse {
  jobs: ComposerJob[]
}

export interface AgentUnifiedStreamProps {
  log: LogEntry[]
  running: boolean
  summary: RunSummary | null
  applyQueue: ApplyReadyJob[]
  waitingQuestion: { id: string; question: string; options: QuestionOption[] } | null
  savedCount: number
  pendingCount: number
  autonomousMode: boolean
  resetVersion: number
  resumeSessionId?: string | null
  onAnswerQuestion: (entry: LogEntry, opt: QuestionOption) => Promise<void> | void
  onAnswerOrchestrator: (questionId: string, answer: string, options?: QuestionOption[]) => Promise<void> | void
  onApplied: (jobId: string, job: ApplyReadyJob) => void
  onChatAction: (action: AgentChatAction) => void | Promise<void>
  onAppendLog: (entry: LogEntry) => void
  onSessionRecorded: (sessionId: string, goal?: string, subtitle?: string) => void
  conversationTitle?: string | null
  conversationSubtitle?: string | null
}
