'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TopBar }              from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import type { AgentConfig, Activity, AgentRole } from '@/lib/types'
import { useApi, apiMutate }   from '@/lib/hooks'
import { MODEL_CATALOGUE, PROVIDER_LABELS } from '@/lib/model-router'
import type { AiConfig }       from '@/lib/model-router'

// ── CSS-based responsive grid values (no JS needed, no SSR mismatch) ─────────
// These are used as inline gridTemplateColumns values that use CSS native repeat/minmax
const CARDS_GRID    = 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))'
const SETTINGS_GRID = 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))'

// ── Orchestration Chat ────────────────────────────────────────────────────────

interface ChatMsg {
  role:    'user' | 'assistant'
  content: string
  time:    Date
  pending?: boolean
}

// Context-aware suggestion chips based on app state
function getSuggestions(savedCount: number, pendingCount: number, lastRan: boolean): string[] {
  const chips: string[] = []
  if (savedCount > 0 && !lastRan) chips.push(`🚀 Run pipeline now (${savedCount} jobs waiting)`)
  if (pendingCount > 0)           chips.push(`📋 Review ${pendingCount} pending jobs`)
  chips.push('📊 Summarize my job search progress')
  chips.push('💡 Why am I scoring low on jobs?')
  chips.push('✍️ Improve my cover letter style')
  chips.push('⚙️ Set min score to 80%')
  return chips.slice(0, 4)
}

function OrchestrationChat({
  savedCount, pendingCount, hasRun,
  onAction,
}: {
  savedCount:  number
  pendingCount: number
  hasRun:      boolean
  onAction: (action: { type: string; [k: string]: unknown }) => void
}) {
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  const suggestions = getSuggestions(savedCount, pendingCount, hasRun)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Proactive greeting when chat first opens
  useEffect(() => {
    if (open && messages.length === 0) {
      const greeting = savedCount > 0
        ? `你好！我是你的 ApplyMate 工作流协调官 🎯\n\n当前你有 **${savedCount}** 个已保存的职位等待分析${pendingCount > 0 ? `，另有 **${pendingCount}** 个职位待审核` : ''}。\n\n我可以帮你：\n• 启动 6-Agent 流水线分析职位\n• 解释某个职位为什么得分低\n• 调整搜索策略和偏好\n• 分析你的求职进展模式\n\n想从哪里开始？`
        : `你好！我是你的 ApplyMate 工作流协调官 🎯\n\n目前你还没有保存的职位。建议先通过 **Chrome 插件**在 LinkedIn/Indeed 保存职位，或在 **Jobs 页面**手动添加，然后我来帮你分析和投递。\n\n有什么我可以帮你的？`
      setMessages([{ role: 'assistant', content: greeting, time: new Date() }])
    }
  }, [open])

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return
    const userMsg: ChatMsg = { role: 'user', content: text, time: new Date() }
    const pendingMsg: ChatMsg = { role: 'assistant', content: '', time: new Date(), pending: true }

    setMessages(prev => [...prev, userMsg, pendingMsg])
    setInput('')
    setLoading(true)

    // Build messages for API (exclude system greeting from history)
    const history = [...messages.filter(m => !m.pending), userMsg]
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch('/api/agent/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: history }),
      })

      if (!res.ok) throw new Error(await res.text())
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Parse SSE lines
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let event = ''
        for (const line of lines) {
          if (line.startsWith('event: '))      event = line.slice(7).trim()
          else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (event === 'text' && data.delta) {
                fullText += data.delta
                setMessages(prev => prev.map((m, i) =>
                  i === prev.length - 1 ? { ...m, content: fullText, pending: false } : m
                ))
              } else if (event === 'action') {
                onAction(data)
              }
            } catch { /* ignore parse errors */ }
            event = ''
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, content: `Error: ${(err as Error).message}`, pending: false } : m
      ))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function renderContent(text: string) {
    // Strip ACTION lines before showing
    const clean = text.replace(/^ACTION:.+$/gm, '').trim()
    // Bold **text**
    return clean.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  }

  return (
    <>
      {/* ── Floating chat button (always visible) ── */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        {/* Unread badge */}
        {!open && (savedCount > 0 || pendingCount > 0) && (
          <div style={{ background: 'var(--primary)', color: '#fff', borderRadius: 999, padding: '4px 10px', fontSize: 11, fontWeight: 500, boxShadow: '0 2px 8px rgba(24,95,165,0.4)' }}>
            {savedCount > 0 ? `${savedCount} 个职位待分析` : `${pendingCount} 个待审核`}
          </div>
        )}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            width: 52, height: 52, borderRadius: '50%',
            background: loading ? 'var(--c-warning)' : 'var(--primary)',
            border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, boxShadow: '0 4px 16px rgba(24,95,165,0.45)',
            transition: 'transform 0.2s, background 0.2s',
            animation: loading ? 'pulse 1.2s ease-in-out infinite' : 'none',
          }}
          title="Orchestrator Chat"
        >
          {open ? '✕' : '🧠'}
        </button>
      </div>

      {/* ── Chat overlay ── */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 999,
          width: 380, height: 520,
          background: 'var(--bg)', border: '0.5px solid var(--border)',
          borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 14px', background: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🧠</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>Orchestrator</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', lineHeight: 1.2 }}>
                {loading ? '正在思考…' : '用自然语言控制你的 Agent 团队'}
              </div>
            </div>
            {loading && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff', animation: 'pulse 1s ease-in-out infinite' }} />}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 2 }}>
                <div style={{
                  maxWidth: '82%', padding: '8px 11px',
                  borderRadius: msg.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                  background: msg.role === 'user' ? 'var(--primary)' : 'var(--bg-secondary)',
                  color: msg.role === 'user' ? '#fff' : 'var(--text)',
                  border: msg.role === 'assistant' ? '0.5px solid var(--border)' : 'none',
                  fontSize: 12, lineHeight: 1.65,
                  animation: msg.pending ? 'pulse 1s ease-in-out infinite' : 'none',
                }}>
                  {msg.pending
                    ? <span style={{ color: 'var(--text-muted)', letterSpacing: 2 }}>● ● ●</span>
                    : <span dangerouslySetInnerHTML={{ __html: renderContent(msg.content) }} />
                  }
                </div>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', padding: '0 3px' }}>
                  {msg.time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Suggestion chips */}
          {messages.length <= 1 && (
            <div style={{ padding: '4px 10px 6px', display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => sendMessage(s)} style={{
                  padding: '4px 9px', fontSize: 10, borderRadius: 999,
                  border: '0.5px solid var(--border)', background: 'var(--bg-secondary)',
                  cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap',
                }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 7, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="告诉我你想做什么… (Enter 发送)"
              rows={2}
              style={{
                flex: 1, padding: '7px 9px', fontSize: 12, borderRadius: 8,
                border: '0.5px solid var(--border)', background: 'var(--bg)',
                color: 'var(--text)', outline: 'none', resize: 'none',
                fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
              style={{
                padding: '8px 12px', borderRadius: 8, border: 'none',
                background: (!input.trim() || loading) ? 'var(--border)' : 'var(--primary)',
                color: '#fff', fontSize: 14, cursor: (!input.trim() || loading) ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? '…' : '→'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Role metadata ─────────────────────────────────────────────────────────────

type RoleKey = 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'

const ROLES: { key: RoleKey; icon: string; label: string; zh: string; desc: string }[] = [
  { key: 'scout',    icon: '🔍', label: 'Scout',    zh: '侦察员', desc: '过滤候选职位：排除、去重、优先公司、每日上限' },
  { key: 'analyst',  icon: '🤖', label: 'Analyst',  zh: '分析员', desc: 'AI 评分 resume↔JD，提取匹配/缺失关键词' },
  { key: 'writer',   icon: '✍️', label: 'Writer',   zh: '撰写员', desc: '生成求职信，定制简历关键词' },
  { key: 'reviewer', icon: '🔎', label: 'Reviewer', zh: '审核员', desc: '按规则分流：auto-apply / review / skip' },
  { key: 'executor', icon: '🚀', label: 'Executor', zh: '执行员', desc: '更新 DB job.status=applied，写 Activity' },
  { key: 'auditor',  icon: '✅', label: 'Auditor',  zh: '验收员', desc: '验证 DB 状态，生成最终运行报告' },
]

type RoleStatus = 'idle' | 'running' | 'done' | 'error'

interface RoleMetric {
  count: number; durationMs: number; summary: string
  avgScore?: number; letters?: number; approved?: number
  pending?: number; applied?: number; failed?: number; warnings?: number
}

interface LogEntry {
  type:    'role_start' | 'role_done' | 'job_done' | 'job_skip' | 'info' | 'done' | 'error' | 'start'
  role?:   RoleKey
  message: string
  score?:  number
  time:    Date
}

// ── Model selector ────────────────────────────────────────────────────────────

function InlineModelSelect({ provider, model, onChange }: {
  provider: string; model: string; onChange: (p: string, m: string) => void
}) {
  const byProvider = MODEL_CATALOGUE.reduce<Record<string, typeof MODEL_CATALOGUE>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = []
    acc[m.provider].push(m)
    return acc
  }, {})

  return (
    <select
      value={`${provider}::${model}`}
      onChange={e => { const [p, m] = e.target.value.split('::'); onChange(p, m) }}
      onClick={e => e.stopPropagation()}
      style={{ fontSize: 10, padding: '3px 5px', border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', outline: 'none', width: '100%', cursor: 'pointer', maxWidth: 180 }}
    >
      {Object.entries(byProvider).map(([prov, models]) => (
        <optgroup key={prov} label={PROVIDER_LABELS[prov as keyof typeof PROVIDER_LABELS] ?? prov}>
          {models.map(m => (
            <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// ── Pipeline Flow Bar (sticky) ────────────────────────────────────────────────

function PipelineFlowBar({ statuses, currentRole }: {
  statuses: Record<RoleKey, RoleStatus>; currentRole: RoleKey | null
}) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)',
      position: 'sticky', top: 0, zIndex: 10, overflowX: 'auto',
    }}>
      {/* Inner: min-width ensures it never wraps, allows horizontal scroll */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '8px 16px',
        minWidth: 'max-content', gap: 0,
      }}>
        {ROLES.map((r, i) => {
          const st     = statuses[r.key]
          const active = currentRole === r.key
          const color  = st === 'done' ? 'var(--c-success)' : active ? 'var(--primary)' : st === 'error' ? 'var(--c-danger)' : 'var(--text-muted)'
          const bg     = st === 'done' ? 'rgba(5,150,105,0.10)' : active ? 'rgba(79,70,229,0.12)' : 'var(--bg-tertiary)'
          return (
            <React.Fragment key={r.key}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 72 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: '50%', background: bg,
                  border: `1.5px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, flexShrink: 0,
                  animation: active ? 'pulse 1.4s ease-in-out infinite' : 'none',
                }}>
                  {st === 'done' ? '✓' : r.icon}
                </div>
                <div style={{ fontSize: 9, color, fontWeight: active ? 600 : 400, textAlign: 'center', lineHeight: 1.3, whiteSpace: 'nowrap' }}>
                  <div>{r.label}</div>
                  <div style={{ opacity: 0.65 }}>{r.zh}</div>
                </div>
              </div>
              {i < ROLES.length - 1 && (
                <div style={{ width: 32, height: 1.5, background: st === 'done' ? 'var(--c-success)' : 'var(--border)', transition: 'background 0.4s', margin: '0 2px', marginBottom: 18, flexShrink: 0 }} />
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

// ── Agent Role Card ───────────────────────────────────────────────────────────

function AgentRoleCard({ roleInfo, config, status, metrics, saving, onModelChange, onToggle, onPromptSave }: {
  roleInfo: typeof ROLES[0]; config: AgentRole | undefined; status: RoleStatus
  metrics: RoleMetric | undefined; saving: boolean
  onModelChange:  (role: RoleKey, p: string, m: string) => void
  onToggle:       (role: RoleKey, enabled: boolean) => void
  onPromptSave:   (role: RoleKey, prompt: string) => void
}) {
  const { key, icon, label, zh, desc } = roleInfo
  const provider    = config?.provider    ?? 'anthropic'
  const model       = config?.model       ?? ''
  const enabled     = config?.enabled     ?? true
  const totalRuns   = config?.totalRuns   ?? 0
  const lastResult  = config?.lastResult  as RoleMetric | null | undefined

  const [promptOpen,   setPromptOpen]   = useState(false)
  const [promptText,   setPromptText]   = useState(config?.systemPrompt ?? '')
  const [promptSaving, setPromptSaving] = useState(false)

  // Sync prompt from config when it loads
  useEffect(() => {
    if (config?.systemPrompt != null) setPromptText(config.systemPrompt)
  }, [config?.systemPrompt])

  const statusColors: Record<RoleStatus, string> = { idle: 'var(--text-muted)', running: 'var(--primary)', done: 'var(--c-success)', error: 'var(--c-danger)' }
  const statusLabels: Record<RoleStatus, string> = { idle: 'Idle', running: 'Running…', done: 'Done', error: 'Error' }
  const sc = statusColors[status]

  async function savePrompt() {
    setPromptSaving(true)
    await onPromptSave(key, promptText)
    setPromptSaving(false)
    setPromptOpen(false)
  }

  return (
    <Card style={{
      padding: 0, overflow: 'hidden', opacity: enabled ? 1 : 0.55,
      border: status === 'running' ? `1.5px solid var(--primary)` : status === 'done' ? `1.5px solid rgba(5,150,105,0.40)` : '0.5px solid var(--border)',
      transition: 'border 0.3s, box-shadow 0.3s',
      boxShadow: status === 'running' ? '0 0 0 3px rgba(79,70,229,0.12)' : 'none',
    }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>{label}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.2 }}>{zh}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: sc, display: 'inline-block',
            animation: status === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: 10, color: sc, fontWeight: 500 }}>{statusLabels[status]}</span>
          <div onClick={() => onToggle(key, !enabled)} style={{ width: 26, height: 14, borderRadius: 7, background: enabled ? 'var(--primary)' : 'var(--border)', cursor: 'pointer', position: 'relative', flexShrink: 0 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: enabled ? 14 : 2, transition: 'left 0.2s' }} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>{desc}</div>

        {/* Model selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>模型</span>
          <div style={{ flex: 1, minWidth: 120 }}>
            <InlineModelSelect provider={provider} model={model} onChange={(p, m) => onModelChange(key, p, m)} />
          </div>
        </div>

        {/* Run metrics */}
        {metrics ? (
          <div style={{ fontSize: 10, background: 'rgba(59,109,17,0.06)', borderRadius: 5, padding: '5px 8px', lineHeight: 1.7 }}>
            <div style={{ color: 'var(--c-success)', fontWeight: 500 }}>{metrics.summary}</div>
            <div style={{ color: 'var(--text-muted)' }}>{(metrics.durationMs / 1000).toFixed(1)}s · 共 {totalRuns + 1} 次运行</div>
          </div>
        ) : lastResult && totalRuns > 0 ? (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', borderRadius: 5, padding: '5px 8px', lineHeight: 1.7 }}>
            <div>{lastResult.summary}</div>
            <div>上次: {config?.lastRunAt ? new Date(config.lastRunAt).toLocaleDateString('zh') : '—'} · 共 {totalRuns} 次</div>
          </div>
        ) : null}

        {saving && <div style={{ fontSize: 9, color: 'var(--primary)', textAlign: 'right' }}>保存中…</div>}

        {/* ── System Prompt (fine-tuning) ── */}
        <div>
          <button
            onClick={() => setPromptOpen(o => !o)}
            style={{
              width: '100%', padding: '5px 8px', background: promptOpen ? 'rgba(79,70,229,0.08)' : 'var(--bg-tertiary)',
              border: '0.5px solid var(--border)', borderRadius: 5, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 10, color: 'var(--text-muted)',
            }}
          >
            <span>✏ Instructions (System Prompt)</span>
            <span>{promptOpen ? '▲' : '▼'}</span>
          </button>

          {promptOpen && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                placeholder="Customize how this agent thinks and acts…"
                rows={5}
                style={{
                  width: '100%', padding: '7px 9px', resize: 'vertical',
                  border: '0.5px solid var(--border)', borderRadius: 5,
                  fontSize: 10, fontFamily: 'inherit', lineHeight: 1.6,
                  color: 'var(--text)', background: 'var(--bg)', outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setPromptOpen(false)}
                  style={{ padding: '4px 10px', fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', cursor: 'pointer', color: 'var(--text-muted)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={savePrompt}
                  disabled={promptSaving}
                  style={{ padding: '4px 10px', fontSize: 10, background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 4, cursor: promptSaving ? 'not-allowed' : 'pointer', opacity: promptSaving ? 0.7 : 1 }}
                >
                  {promptSaving ? 'Saving…' : '💾 Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

// ── Run Log Panel ─────────────────────────────────────────────────────────────

function RunLogPanel({ log, running, done, summary, onStart, onStop }: {
  log: LogEntry[]; running: boolean; done: boolean
  summary: { processed: number; applied: number; pending: number; skipped: number; failed: number } | null
  onStart: () => void; onStop: () => void
}) {
  const logEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  function entryColor(e: LogEntry): string {
    if (e.type === 'done')       return 'var(--c-success)'
    if (e.type === 'error')      return 'var(--c-danger)'
    if (e.type === 'role_start') return 'var(--primary)'
    if (e.type === 'role_done')  return 'var(--c-success)'
    if (e.type === 'job_skip')   return 'var(--text-muted)'
    if (e.score != null)         return e.score >= 80 ? 'var(--c-success)' : e.score >= 60 ? 'var(--c-warning)' : 'var(--text-muted)'
    return 'var(--text)'
  }

  const isEmpty = log.length === 0

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Live Run Log</span>
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-success)', animation: 'pulse 1.2s ease-in-out infinite' }} />
              <span style={{ fontSize: 10, color: 'var(--c-success)' }}>Pipeline 运行中…</span>
            </div>
          )}
          {done && !running && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>Completed</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!running && <Btn small variant="primary" onClick={onStart}>{done ? '↻ Run Again' : '▶ Start Run'}</Btn>}
          {running   && <Btn small variant="danger"  onClick={onStop}>⏹ Stop</Btn>}
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div style={{ display: 'flex', borderBottom: '0.5px solid var(--border)' }}>
          {[
            { label: 'Processed', value: summary.processed, color: 'var(--text)' },
            { label: 'Applied',   value: summary.applied,   color: 'var(--c-success)' },
            { label: 'Pending',   value: summary.pending,   color: 'var(--c-warning)' },
            { label: 'Skipped',   value: summary.skipped,   color: 'var(--text-muted)' },
            { label: 'Failed',    value: summary.failed,    color: 'var(--c-danger)' },
          ].map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center', padding: '7px 0', borderRight: i < 4 ? '0.5px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Log body — compact when empty, full height when active */}
      <div style={{
        height: isEmpty ? 64 : 220, overflowY: 'auto', padding: '8px 14px',
        fontFamily: 'monospace', transition: 'height 0.3s',
        display: 'flex', flexDirection: 'column', justifyContent: isEmpty ? 'center' : 'flex-start',
      }}>
        {isEmpty ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            点击 ▶ Start Run 启动 6-Agent 流水线
          </div>
        ) : log.map((entry, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 2, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 1, fontVariantNumeric: 'tabular-nums' }}>
              {entry.time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span style={{ fontSize: 11, color: entryColor(entry), lineHeight: 1.5 }}>{entry.message}</span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* Empty state CTA: no jobs found */}
      {done && summary?.processed === 0 && (
        <div style={{ padding: '10px 14px', borderTop: '0.5px solid var(--border)', background: 'rgba(24,95,165,0.04)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            没有待处理的职位。先通过 <strong>Chrome 插件</strong>在 LinkedIn / Indeed 保存职位，或在 <strong>Jobs 页面</strong>点击「+ Add Job」手动添加。
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Settings helpers ──────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '14px 0 6px', borderBottom: '0.5px solid var(--border)', marginBottom: 4 }}>
      {children}
    </div>
  )
}

function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 12 }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? 'var(--primary)' : 'var(--border)', cursor: 'pointer', position: 'relative', flexShrink: 0 }}>
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: value ? 16 : 2, transition: 'left 0.2s' }} />
      </div>
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 1, onChange, unit = '' }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string
}) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12 }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--primary)' }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{min}{unit}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{max}{unit}</span>
      </div>
    </div>
  )
}

function PillInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('')
  function add() { if (input.trim()) { onChange([...values, input.trim()]); setInput('') } }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
      {values.map((v, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', borderRadius: 999, padding: '1px 7px', fontSize: 10 }}>
          {v}
          <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: 10, padding: 0 }}>✕</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        placeholder={placeholder}
        style={{ border: 'none', outline: 'none', fontSize: 10, color: 'var(--text)', background: 'transparent', minWidth: 100, padding: '2px 3px' }} />
    </div>
  )
}

// ── Global Settings Panel ─────────────────────────────────────────────────────

type UiCfg = {
  minScore: number; maxPerDay: number; autoApply: boolean; requireReview: boolean
  autoCoverLetter: boolean; coverTone: string; useTailoredCV: boolean
  targetRoles: string[]; targetLocations: string[]
  excludeCompanies: string[]; priorityCompanies: string[]
  salaryMin: number; salaryMax: number
  notifyApply: boolean; notifyReject: boolean; weeklySummary: boolean
  followUpReminder: boolean; followUpDays: number
}

const DEFAULT_CFG: UiCfg = {
  minScore: 75, maxPerDay: 10, autoApply: false, requireReview: true,
  autoCoverLetter: false, coverTone: 'professional', useTailoredCV: false,
  targetRoles: [], targetLocations: [], excludeCompanies: [], priorityCompanies: [],
  salaryMin: 0, salaryMax: 0,
  notifyApply: true, notifyReject: true, weeklySummary: false, followUpReminder: true, followUpDays: 7,
}

function GlobalSettingsPanel({ cfg, set, onSave, onReset, saving, gridCols }: {
  cfg: UiCfg; set: <K extends keyof UiCfg>(k: K, v: UiCfg[K]) => void
  onSave: () => void; onReset: () => void; saving: boolean
  gridCols?: string
}) {
  const cols = gridCols ?? '1fr 1fr 1fr'
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px 4px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)' }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>⚙ Global Pipeline Settings</span>
      </div>
      <div style={{ padding: '0 16px 16px', display: 'grid', gridTemplateColumns: cols, gap: '0 20px' }}>

        {/* ── Col 1: Job Matching ── */}
        <div>
          <SectionTitle>Job Matching Rules</SectionTitle>
          <SliderRow label="Minimum match score" value={cfg.minScore} min={40} max={100} onChange={v => set('minScore', v)} unit="%" />
          <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Target roles</div>
            <PillInput values={cfg.targetRoles} onChange={v => set('targetRoles', v)} placeholder="Add role…" />
          </div>
          <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Target locations</div>
            <PillInput values={cfg.targetLocations} onChange={v => set('targetLocations', v)} placeholder="Add location…" />
          </div>
          <SliderRow label="Min salary" value={cfg.salaryMin} min={0} max={200000} step={5000} onChange={v => set('salaryMin', v)} unit="€" />
          <SliderRow label="Max salary" value={cfg.salaryMax} min={0} max={200000} step={5000} onChange={v => set('salaryMax', v)} unit="€" />

          <SectionTitle>Application Limits</SectionTitle>
          <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Max applications / day</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <button onClick={() => set('maxPerDay', Math.max(1, cfg.maxPerDay - 1))} style={{ width: 22, height: 22, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer' }}>−</button>
              <span style={{ fontSize: 12, fontWeight: 500, minWidth: 22, textAlign: 'center' }}>{cfg.maxPerDay}</span>
              <button onClick={() => set('maxPerDay', Math.min(50, cfg.maxPerDay + 1))} style={{ width: 22, height: 22, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer' }}>+</button>
            </div>
          </div>
          <Toggle label="Skip if already processed today" sub="Deduplication across all sources" value={true} onChange={() => {}} />
        </div>

        {/* ── Col 2: Auto-Apply + Notifications ── */}
        <div>
          <SectionTitle>Auto-Apply Settings</SectionTitle>
          <Toggle label="Auto-apply when match ≥ min score" sub="Applies automatically without review"
            value={cfg.autoApply} onChange={v => set('autoApply', v)} />
          <Toggle label="Require manual review" sub="Jobs go to Review column before applying"
            value={cfg.requireReview} onChange={v => set('requireReview', v)} />
          <Toggle label="Auto-generate cover letter" sub="AI writes a tailored cover letter per job"
            value={cfg.autoCoverLetter} onChange={v => set('autoCoverLetter', v)} />
          {cfg.autoCoverLetter && (
            <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12 }}>Cover letter tone</span>
              <select value={cfg.coverTone} onChange={e => set('coverTone', e.target.value)}
                style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                <option value="professional">Professional</option>
                <option value="confident">Confident</option>
                <option value="concise">Concise</option>
              </select>
            </div>
          )}
          <Toggle label="Use tailored CV per role" sub="Logs missing keywords for each application"
            value={cfg.useTailoredCV} onChange={v => set('useTailoredCV', v)} />

          <SectionTitle>Notifications</SectionTitle>
          <Toggle label="Notify on auto-apply"  value={cfg.notifyApply}      onChange={v => set('notifyApply', v)} />
          <Toggle label="Notify on rejection"    value={cfg.notifyReject}     onChange={v => set('notifyReject', v)} />
          <Toggle label="Weekly summary email"   value={cfg.weeklySummary}    onChange={v => set('weeklySummary', v)} />
          <Toggle label="Follow-up reminders"    value={cfg.followUpReminder} onChange={v => set('followUpReminder', v)} />
          {cfg.followUpReminder && (
            <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Remind after (days)</span>
              <input type="number" value={cfg.followUpDays} min={1} max={30} onChange={e => set('followUpDays', Number(e.target.value))}
                style={{ width: 48, padding: '3px 6px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }} />
            </div>
          )}
        </div>

        {/* ── Col 3: Company Lists ── */}
        <div>
          <SectionTitle>Companies to Avoid</SectionTitle>
          <PillInput values={cfg.excludeCompanies} onChange={v => set('excludeCompanies', v)} placeholder="Add company…" />

          <SectionTitle>Priority Companies (Always Apply)</SectionTitle>
          <PillInput values={cfg.priorityCompanies} onChange={v => set('priorityCompanies', v)} placeholder="Add company…" />

          {/* Save / Reset */}
          <div style={{ marginTop: 20, display: 'flex', gap: 8, flexDirection: 'column' }}>
            <Btn variant="primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : '💾 Save Settings'}
            </Btn>
            <Btn variant="ghost" onClick={onReset}>Reset to defaults</Btn>
          </div>
        </div>

      </div>
    </Card>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AgentPlaygroundPage() {
  const toast = useToast()

  const { data: agentData }                             = useApi<AgentConfig>('/api/agent')
  const { data: rolesData, refetch: refetchRoles }      = useApi<AgentRole[]>('/api/agent/roles')
  const { data: activityData }                          = useApi<Activity[]>('/api/activity?limit=10')
  const { data: jobsData }                              = useApi<{ jobs: Array<{ status: string }> }>('/api/jobs?pageSize=100')

  const [globalRunning, setGlobalRunning] = useState(false)
  const [cfg,           setCfg]           = useState<UiCfg>(DEFAULT_CFG)
  const [saving,        setSaving]        = useState(false)
  const [savingRoles,   setSavingRoles]   = useState<Partial<Record<RoleKey, boolean>>>({})

  // Track if pipeline has ever run (for chat greeting)
  const [hasRun,        setHasRun]        = useState(false)

  // Run state
  const [roleStatuses,  setRoleStatuses]  = useState<Record<RoleKey, RoleStatus>>(
    () => Object.fromEntries(ROLES.map(r => [r.key, 'idle'])) as Record<RoleKey, RoleStatus>
  )
  const [currentRole,   setCurrentRole]   = useState<RoleKey | null>(null)
  const [roleMetrics,   setRoleMetrics]   = useState<Partial<Record<RoleKey, RoleMetric>>>({})
  const [runLog,        setRunLog]        = useState<LogEntry[]>([])
  const [runDone,       setRunDone]       = useState(false)
  const [runSummary,    setRunSummary]    = useState<{ processed: number; applied: number; pending: number; skipped: number; failed: number } | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Sync global config from API
  useEffect(() => {
    if (!agentData) return
    setGlobalRunning(agentData.isRunning)
    setCfg(prev => ({
      ...prev,
      minScore:         agentData.minMatchScore,
      maxPerDay:        agentData.dailyLimit,
      autoApply:        agentData.autoApply,
      requireReview:    agentData.requireApproval,
      autoCoverLetter:  (agentData as any).autoCoverLetter  ?? false,
      coverTone:        (agentData as any).coverTone        ?? 'professional',
      useTailoredCV:    (agentData as any).useTailoredCV    ?? false,
      targetRoles:      agentData.targetRoles               ?? [],
      targetLocations:  agentData.targetLocations           ?? [],
      excludeCompanies: agentData.excludeCompanies          ?? [],
      priorityCompanies:(agentData as any).priorityCompanies ?? [],
      salaryMin:        (agentData as any).salaryMin         ?? 0,
      salaryMax:        (agentData as any).salaryMax         ?? 0,
      notifyApply:      (agentData as any).notifyApply       ?? true,
      notifyReject:     (agentData as any).notifyReject      ?? true,
      weeklySummary:    (agentData as any).weeklySummary     ?? false,
      followUpReminder: (agentData as any).followUpReminder  ?? true,
      followUpDays:     (agentData as any).followUpDays      ?? 7,
    }))
  }, [agentData])

  function addLog(entry: LogEntry) { setRunLog(prev => [...prev, entry]) }
  function set<K extends keyof UiCfg>(k: K, v: UiCfg[K]) { setCfg(c => ({ ...c, [k]: v })) }

  // ── SSE Run ────────────────────────────────────────────────────────────────

  function startRun() {
    if (esRef.current) esRef.current.close()
    setHasRun(true)
    setRunLog([])
    setRunDone(false)
    setRunSummary(null)
    setRoleMetrics({})
    setCurrentRole(null)
    setRoleStatuses(Object.fromEntries(ROLES.map(r => [r.key, 'idle'])) as Record<RoleKey, RoleStatus>)

    const es = new EventSource('/api/agent/run')
    esRef.current = es

    // Fix #1: Clean log format — role label only once
    es.addEventListener('role_start', e => {
      const d = JSON.parse(e.data) as { role: RoleKey; label: string; model: string; icon: string }
      setCurrentRole(d.role)
      setRoleStatuses(prev => ({ ...prev, [d.role]: 'running' }))
      addLog({ type: 'role_start', role: d.role, message: `${d.icon} [${d.role}] ${d.label} 开始… (${d.model})`, time: new Date() })
    })

    // Fix #2: Consistent label format for role_done
    es.addEventListener('role_done', e => {
      const d = JSON.parse(e.data) as { role: RoleKey; icon: string; summary: string; count: number; durationMs: number } & RoleMetric
      setRoleStatuses(prev => ({ ...prev, [d.role]: 'done' }))
      setRoleMetrics(prev => ({ ...prev, [d.role]: d }))
      addLog({ type: 'role_done', role: d.role, message: `  ✓ [${d.role}] ${d.summary} (${(d.durationMs / 1000).toFixed(1)}s)`, time: new Date() })
    })

    es.addEventListener('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 Pipeline started — ${d.total} jobs queued`, time: new Date() })
    })

    es.addEventListener('job_done', e => {
      const d = JSON.parse(e.data)
      const applied = d.autoApplied ? ' ✓ Applied' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({ type: 'job_done', message: `  ${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`, score: d.score, time: new Date() })
    })

    es.addEventListener('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'job_skip', message: `  — ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
    })

    es.addEventListener('info', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: `  ℹ ${d.message}`, time: new Date() })
    })

    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      setRunSummary(d)
      setRunDone(true)
      setCurrentRole(null)
      addLog({ type: 'done', message: `✅ Pipeline complete — ${d.processed} scored, ${d.applied} applied, ${d.pending} pending, ${d.skipped} skipped`, time: new Date() })
      es.close(); esRef.current = null
      refetchRoles()
      if (d.processed > 0) toast.success('Pipeline complete', `Scored ${d.processed} jobs, applied to ${d.applied}`)
    })

    es.addEventListener('error', e => {
      try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); addLog({ type: 'error', message: `✗ ${d.message ?? 'Pipeline error'}`, time: new Date() }) }
      catch { addLog({ type: 'error', message: '✗ Connection lost', time: new Date() }) }
      setCurrentRole(null); setRunDone(true)
      es.close(); esRef.current = null
    })
  }

  function stopRun() {
    esRef.current?.close(); esRef.current = null
    setCurrentRole(null); setRunDone(true)
    addLog({ type: 'info', message: '— Stopped by user', time: new Date() })
  }

  const isRunning = !!currentRole || (runLog.length > 0 && !runDone)

  // ── Role model / enable change ─────────────────────────────────────────────

  const handleModelChange = useCallback(async (role: RoleKey, provider: string, model: string) => {
    setSavingRoles(prev => ({ ...prev, [role]: true }))
    await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { provider, model })
    await refetchRoles()
    setSavingRoles(prev => ({ ...prev, [role]: false }))
    toast.success('Model updated', `${role} → ${model}`)
  }, [refetchRoles, toast])

  const handleRoleToggle = useCallback(async (role: RoleKey, enabled: boolean) => {
    await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
    await refetchRoles()
  }, [refetchRoles])

  const handlePromptSave = useCallback(async (role: RoleKey, systemPrompt: string) => {
    await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { systemPrompt })
    await refetchRoles()
    toast.success('Instructions saved', `${role} agent will use your custom prompt`)
  }, [refetchRoles, toast])

  // ── Chat action handler ────────────────────────────────────────────────────

  const handleChatAction = useCallback(async (action: { type: string; [k: string]: unknown }) => {
    switch (action.type) {
      case 'start_run':
        startRun()
        toast.info('Pipeline started', 'The orchestrator triggered a run')
        break
      case 'update_config': {
        const field = action.field as string
        const value = action.value
        await apiMutate('/api/agent', 'PATCH', { [field]: value })
        // Update local cfg state
        const cfgFieldMap: Record<string, keyof UiCfg> = {
          minMatchScore: 'minScore', dailyLimit: 'maxPerDay',
          autoApply: 'autoApply', requireApproval: 'requireReview',
          autoCoverLetter: 'autoCoverLetter', useTailoredCV: 'useTailoredCV',
        }
        const uiField = cfgFieldMap[field]
        if (uiField) setCfg(c => ({ ...c, [uiField]: value }))
        toast.success('Setting updated', `${field} → ${value}`)
        break
      }
      case 'navigate':
        // Signal parent to navigate (handled via window.location or router)
        if (action.path === 'jobs') window.location.href = '/?page=jobs'
        break
      default:
        break
    }
  }, [toast])

  // ── Global config save ─────────────────────────────────────────────────────

  async function saveGlobalConfig() {
    setSaving(true)
    const { error } = await apiMutate('/api/agent', 'PATCH', {
      isRunning: globalRunning, dailyLimit: cfg.maxPerDay, minMatchScore: cfg.minScore,
      autoApply: cfg.autoApply, requireApproval: cfg.requireReview,
      targetLocations: cfg.targetLocations, targetRoles: cfg.targetRoles,
      excludeCompanies: cfg.excludeCompanies, priorityCompanies: cfg.priorityCompanies,
      autoCoverLetter: cfg.autoCoverLetter, coverTone: cfg.coverTone, useTailoredCV: cfg.useTailoredCV,
      salaryMin: cfg.salaryMin, salaryMax: cfg.salaryMax,
      notifyApply: cfg.notifyApply, notifyReject: cfg.notifyReject, weeklySummary: cfg.weeklySummary,
      followUpReminder: cfg.followUpReminder, followUpDays: cfg.followUpDays,
    })
    setSaving(false)
    if (error) toast.error('Error', error)
    else       toast.success('Settings saved', 'Pipeline will use updated config')
  }

  async function toggleGlobalRunning() {
    const next = !globalRunning
    setGlobalRunning(next)
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) { setGlobalRunning(!next); toast.error('Error', error) }
    else toast.info(next ? 'Agent enabled' : 'Agent paused', '')
  }

  const roles        = rolesData ?? []
  const savedCount   = (jobsData?.jobs ?? []).filter(j => j.status === 'saved').length
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.status === 'review').length

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Agent Playground">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: globalRunning ? 'var(--c-success)' : 'var(--text-muted)' }} />
          <span style={{ fontSize: 11, color: globalRunning ? 'var(--c-success)' : 'var(--text-muted)', fontWeight: 500 }}>
            {globalRunning ? 'Enabled' : 'Paused'}
          </span>
        </div>
        <Btn variant={globalRunning ? 'danger' : 'primary'} onClick={toggleGlobalRunning}>
          {globalRunning ? '⏸ Pause' : '▶ Enable'}
        </Btn>
      </TopBar>

      {/* Sticky Pipeline Flow Bar */}
      <PipelineFlowBar statuses={roleStatuses} currentRole={currentRole} />

      <div style={{ padding: 16, paddingBottom: 90, display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* 6 Agent Role Cards — auto-fill responsive, min 300px per card */}
        <div style={{ display: 'grid', gridTemplateColumns: CARDS_GRID, gap: 12 }}>
          {ROLES.map(r => (
            <AgentRoleCard
              key={r.key}
              roleInfo={r}
              config={roles.find(c => c.role === r.key)}
              status={roleStatuses[r.key]}
              metrics={roleMetrics[r.key]}
              saving={!!savingRoles[r.key]}
              onModelChange={handleModelChange}
              onToggle={handleRoleToggle}
              onPromptSave={handlePromptSave}
            />
          ))}
        </div>

        {/* Fix #4: Live Run Log with dynamic height + CTA */}
        <RunLogPanel
          log={runLog} running={isRunning} done={runDone} summary={runSummary}
          onStart={startRun} onStop={stopRun}
        />

        {/* Fix #5: Global Settings — all sections, always visible */}
        <GlobalSettingsPanel
          cfg={cfg} set={set} onSave={saveGlobalConfig} onReset={() => setCfg(DEFAULT_CFG)} saving={saving}
          gridCols={SETTINGS_GRID}
        />

        {/* Recent Activity */}
        {activityData && activityData.length > 0 && (
          <Card style={{ padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 8, color: 'var(--text-muted)' }}>Recent Activity</div>
            {activityData.slice(0, 8).map(a => (
              <div key={a.id} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
                  {new Date(a.createdAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ fontSize: 11, color: a.color ?? 'var(--text)', lineHeight: 1.4 }}>{a.text}</span>
              </div>
            ))}
          </Card>
        )}

      </div>

      {/* ── Floating Orchestration Chat (fixed position, always accessible) ── */}
      <OrchestrationChat
        savedCount={savedCount}
        pendingCount={pendingCount}
        hasRun={hasRun}
        onAction={handleChatAction}
      />
    </div>
  )
}