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
  return {
    id: `live-${Date.now()}-${index}`,
    taskId: null,
    type,
    speaker: type === 'automation_draft' ? 'Orchestrator' : chrome.label,
    title: chrome.label,
    body: type === 'automation_draft' ? 'I drafted an automation from your request. Please confirm before I save it.' : '',
    data,
    durationMs: null,
    createdAt: new Date().toISOString(),
  }
}

export function jobComposerContext(job: ComposerJob) {
  return [
    `使用这个职位作为上下文：${job.company} · ${job.role}`,
    `地点：${job.location ?? '未填写'}；状态：${job.status}；评分：${job.score ?? '未评分'}`,
    job.url ? `链接：${job.url}` : null,
    '请基于这个职位继续分析、评分、准备申请或创建自动化。',
  ].filter(Boolean).join('\n')
}

export function resumeComposerContext(resume: ComposerResume) {
  return [
    `使用这份简历作为上下文：${resume.name}${resume.isDefault ? '（默认）' : ''}`,
    `简历类型：${resume.kind ?? 'base'}；更新时间：${new Date(resume.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`,
    '请结合这份简历评估职位匹配、生成求职材料或解释分数。',
  ].join('\n')
}

export function attachmentComposerContext(attachedFiles: ComposerAttachment[]) {
  if (attachedFiles.length === 0) return ''
  return [
    '附件上下文（文件内容尚未上传解析，仅提供文件名和类型供你决定下一步）：',
    ...attachedFiles.map(file => `- ${file.name} (${formatBytes(file.size)} · ${file.type})`),
  ].join('\n')
}
