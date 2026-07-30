import type { TranscriptAction } from './TranscriptSpecialBlocks'
import type { ComposerAttachment, ComposerJob, ComposerResume } from './AgentComposer'
import { formatBytes } from './ComposerParts'
import type { LogEntry } from './live-run-types'
import { eventChrome, type AgentTranscriptEvent } from './session-view-model'

export function appendAssistantResponse(full: string, onAppendLog: (entry: LogEntry) => void) {
  if (!full.trim()) return
  const lines = full.split('\n').filter(line => line.trim())
  const thinkPfx = ['let me', 'i need', 'i will', 'sure,', 'okay,', 'as an']
  const msgLines = lines.filter(line => !thinkPfx.some(prefix => line.toLowerCase().trim().startsWith(prefix)))
  const message = (msgLines.length > 0 ? msgLines : lines).join('\n').trim()
  onAppendLog({ type: 'orchestrator_thinking', message, time: new Date() })
}

export function localCancelEvent(action: TranscriptAction): AgentTranscriptEvent {
  return {
    id: `live-cancel-${Date.now()}`,
    taskId: null,
    type: 'automation_cancelled',
    speaker: 'You',
    title: 'Automation draft cancelled',
    body: action.body ?? 'Cancelled automation draft.',
    data: action,
    durationMs: null,
    createdAt: new Date().toISOString(),
  }
}

export function fallbackActionEvent(action: TranscriptAction): AgentTranscriptEvent {
  const creating = action.type === 'create_automation'
  return {
    id: `live-action-${Date.now()}`,
    taskId: null,
    type: creating ? 'automation_created' : 'approval_response',
    speaker: 'ApplyMate',
    title: creating ? 'Automation saved' : 'Decision recorded',
    body: creating ? `Created automation: ${action.draft?.name ?? 'New automation'}` : action.body ?? 'Decision recorded.',
    data: action,
    durationMs: null,
    createdAt: new Date().toISOString(),
  }
}

export function liveBlockEvent(type: string, data: unknown, index: number): AgentTranscriptEvent {
  const chrome = eventChrome(type)
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const eventData = payload.data && typeof payload.data === 'object' ? payload.data : data
  return {
    id: `live-${Date.now()}-${index}`,
    taskId: null,
    type,
    speaker: typeof payload.speaker === 'string' ? payload.speaker : type === 'automation_draft' ? 'Orchestrator' : chrome.label,
    title: typeof payload.title === 'string' ? payload.title : chrome.label,
    body: typeof payload.body === 'string' ? payload.body : type === 'automation_draft' ? 'I drafted an automation from your request. Please confirm before I save it.' : '',
    data: eventData,
    durationMs: null,
    createdAt: new Date().toISOString(),
  }
}

export function jobComposerContext(job: ComposerJob) {
  return [
    `Use this role as context: ${job.company} · ${job.role}`,
    `Location: ${job.location ?? 'Not provided'}; status: ${job.status}; score: ${job.score ?? 'Not scored'}`,
    job.url ? `Link: ${job.url}` : null,
    'Use this role to continue analysis, scoring, application preparation, or automation setup.',
  ].filter(Boolean).join('\n')
}

export function resumeComposerContext(resume: ComposerResume) {
  return [
    `Use this resume as context: ${resume.name}${resume.isDefault ? ' (default)' : ''}`,
    `Resume type: ${resume.kind ?? 'base'}; updated ${new Date(resume.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`,
    'Use this resume to evaluate a role match, generate application materials, or explain a score.',
  ].join('\n')
}

export function attachmentComposerContext(attachedFiles: ComposerAttachment[]) {
  if (attachedFiles.length === 0) return ''
  return [
    'Attachment context (file contents have not been uploaded or parsed; file names and types are provided for your next step):',
    ...attachedFiles.map(file => `- ${file.name} (${formatBytes(file.size)} · ${file.type})`),
  ].join('\n')
}

export function shouldStickToBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 120,
) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}
