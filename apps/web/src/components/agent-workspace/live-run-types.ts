export interface QuestionOption {
  label:   string
  value:   string
  action?: { field: string; value: unknown }
}

export interface LogEntry {
  role?:     string
  type:      'role_start' | 'role_done' | 'job_done' | 'job_skip' | 'info' | 'done' | 'error' | 'start'
           | 'agent_plan' | 'agent_action' | 'agent_observation' | 'agent_reflect'
           | 'agent_question' | 'question_answered'
           | 'orchestrator_plan' | 'orchestrator_fix' | 'orchestrator_retry'
           | 'orchestrator_decision' | 'orchestrator_complete'
           | 'orchestrator_thinking' | 'orchestrator_question' | 'orchestrator_answer'
           | 'user_message'
  message:   string
  time:      Date
  score?:    number
  questionId?: string
  question?:   string
  options?:  QuestionOption[]
  answered?: boolean
}

export interface RunSummary {
  processed: number
  applied:   number
  pending:   number
  skipped:   number
  failed:    number
}
