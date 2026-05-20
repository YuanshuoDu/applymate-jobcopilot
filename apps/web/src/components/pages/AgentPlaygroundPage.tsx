'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TopBar }              from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import type { AgentConfig, Activity, AgentRole } from '@/lib/types'
import { useApi, apiMutate }   from '@/lib/hooks'
import { MODEL_CATALOGUE, PROVIDER_LABELS } from '@/lib/model-router'
import type { AiConfig }       from '@/lib/model-router'

// ── Custom Agent type ─────────────────────────────────────────────────────────
interface CustomAgentRow {
  id:          string
  name:        string
  icon:        string
  description: string | null
  systemPrompt: string | null
  provider:    string
  model:       string
  insertAfter: string
  enabled:     boolean
}

// ── Role metadata ─────────────────────────────────────────────────────────────

type RoleKey = 'scout' | 'analyst' | 'writer' | 'reviewer' | 'executor' | 'auditor'

const BUILTIN_ROLES: { key: RoleKey; icon: string; label: string; zh: string; desc: string }[] = [
  { key: 'scout',    icon: '🔍', label: 'Scout',    zh: '侦察',  desc: '过滤候选职位' },
  { key: 'analyst',  icon: '🤖', label: 'Analyst',  zh: '分析',  desc: 'AI 评分匹配' },
  { key: 'writer',   icon: '✍️', label: 'Writer',   zh: '撰写',  desc: '生成求职信' },
  { key: 'reviewer', icon: '🔎', label: 'Reviewer', zh: '审核',  desc: '分流决策' },
  { key: 'executor', icon: '🚀', label: 'Executor', zh: '执行',  desc: '更新申请状态' },
  { key: 'auditor',  icon: '✅', label: 'Auditor',  zh: '验收',  desc: '生成运行报告' },
]

type RoleStatus = 'idle' | 'running' | 'done' | 'error'

interface RoleMetric {
  count: number; durationMs: number; summary: string
  avgScore?: number; applied?: number; pending?: number; failed?: number
}

// ── Log entry (per-agent) ─────────────────────────────────────────────────────

interface QuestionOption {
  label:   string
  value:   string
  action?: { field: string; value: unknown }
}

interface ApplyReadyJob {
  jobId:           string
  company:         string
  role:            string
  score:           number
  url:             string | null
  location?:       string | null
  coverLetter?:    string
  matchedKeywords: string[]
}

interface LogEntry {
  role?:     string
  type:      'role_start' | 'role_done' | 'job_done' | 'job_skip' | 'info' | 'done' | 'error' | 'start'
           | 'agent_plan' | 'agent_action' | 'agent_observation' | 'agent_reflect'
           | 'agent_question' | 'question_answered'
           | 'orchestrator_plan' | 'orchestrator_fix' | 'orchestrator_retry'
           | 'orchestrator_decision' | 'orchestrator_complete'
  message:   string
  score?:    number
  time:      Date
  questionId?: string
  question?:   string
  options?:    QuestionOption[]
  answered?:   boolean
}

// ── Chat types ────────────────────────────────────────────────────────────────

interface ChatMsg {
  role:    'user' | 'assistant'
  content: string
  time:    Date
  pending?: boolean
}

// ── Shared model selector ─────────────────────────────────────────────────────

function ModelSelect({ provider, model, onChange }: {
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
      style={{ fontSize: 10, padding: '2px 5px', border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 170, cursor: 'pointer' }}
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

// ── Pipeline Monitor Bar (top, sticky) ───────────────────────────────────────

// Full descriptions for each builtin role
const ROLE_DESCRIPTIONS: Record<string, string> = {
  scout:    '扫描已保存职位，过滤排除公司、去重、按每日上限截取',
  analyst:  '调用 AI 对每个职位与简历评分，提取匹配/缺失关键词',
  writer:   '为高分职位生成定制求职信，提取简历关键词建议',
  reviewer: '按自动投递规则分流：批准 / 待审核 / 跳过',
  executor: '将批准职位状态改为"已投递"，写入申请记录',
  auditor:  '核验 DB 状态一致性，生成本次运行报告与洞察',
}

function PipelineMonitorBar({
  statuses, currentRole, roleMetrics, currentJobs, roles, savingRoles,
  customAgents, onModelChange, onToggle, onAddAgent, onDeleteCustom,
}: {
  statuses:    Record<string, RoleStatus>
  currentRole: string | null
  roleMetrics: Partial<Record<string, RoleMetric>>
  currentJobs: Partial<Record<string, { company: string; role: string; score?: number }>>
  roles:       AgentRole[]
  savingRoles: Partial<Record<string, boolean>>
  customAgents: CustomAgentRow[]
  onModelChange:  (role: string, p: string, m: string) => void
  onToggle:       (role: string, enabled: boolean) => void
  onAddAgent:     () => void
  onDeleteCustom: (id: string) => void
}) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)',
      position: 'sticky', top: 0, zIndex: 20, overflowX: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 'max-content', padding: '10px 16px', gap: 0 }}>
        {BUILTIN_ROLES.map((r, i) => {
          const st      = statuses[r.key] ?? 'idle'
          const active  = currentRole === r.key
          const cfg     = roles.find(c => c.role === r.key)
          const enabled = cfg?.enabled ?? true
          const metric  = roleMetrics[r.key]
          const curJob  = currentJobs[r.key]
          const desc    = ROLE_DESCRIPTIONS[r.key] ?? ''

          const borderColor = !enabled ? 'var(--border)'
            : st === 'done'  ? 'var(--c-success)'
            : active         ? 'var(--primary)'
            : st === 'error' ? 'var(--c-danger)'
            : 'var(--border)'

          const iconBg = !enabled ? 'var(--bg-tertiary)'
            : st === 'done'  ? 'rgba(5,150,105,0.10)'
            : active         ? 'rgba(79,70,229,0.14)'
            : 'var(--bg-tertiary)'

          return (
            <React.Fragment key={r.key}>
              {/* ── Node Card ── */}
              <div style={{
                width: 148,
                background: 'var(--bg)',
                border: `1.5px solid ${borderColor}`,
                borderRadius: 10,
                padding: '10px 10px 8px',
                display: 'flex', flexDirection: 'column', gap: 6,
                transition: 'all 0.25s',
                opacity: enabled ? 1 : 0.6,
                boxShadow: active ? `0 0 0 3px rgba(79,70,229,0.12)` : 'none',
              }}>

                {/* Row 1: Icon + Name + Status badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                    background: iconBg, border: `1.5px solid ${borderColor}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14,
                    animation: active ? 'pulse 1.4s ease-in-out infinite' : 'none',
                  }}>
                    {st === 'done' ? '✓' : r.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.2 }}>{r.zh}</div>
                  </div>
                  {/* Status dot — top right */}
                  {active && <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0, animation: 'pulse 1s ease-in-out infinite' }} />}
                  {st === 'done' && !active && <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-success)', flexShrink: 0 }} />}
                </div>

                {/* Row 2: Description */}
                <div style={{
                  fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5,
                  borderTop: '0.5px solid var(--border)', paddingTop: 5,
                }}>
                  {desc}
                </div>

                {/* Row 3: Running status / metric */}
                <div style={{ minHeight: 20 }}>
                  {active && curJob ? (
                    <div style={{ fontSize: 10, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {curJob.company}
                      </span>
                      {curJob.score != null && (
                        <span style={{ fontWeight: 700, flexShrink: 0, color: curJob.score >= 80 ? 'var(--c-success)' : curJob.score >= 60 ? 'var(--c-warning)' : 'var(--text-muted)' }}>
                          {curJob.score}%
                        </span>
                      )}
                    </div>
                  ) : metric ? (
                    <div style={{ fontSize: 10, color: 'var(--c-success)', display: 'flex', gap: 6 }}>
                      <span>{metric.count ?? 0} 个</span>
                      <span style={{ color: 'var(--text-muted)' }}>{(metric.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {!enabled ? '' : st === 'error' ? '执行失败' : '等待中'}
                    </div>
                  )}
                </div>

                {/* Row 4: Model selector */}
                <ModelSelect
                  provider={cfg?.provider ?? 'anthropic'}
                  model={cfg?.model ?? 'claude-haiku-4-5-20251001'}
                  onChange={(p, m) => onModelChange(r.key, p, m)}
                />

                {/* Row 5: Enable / Disable button — clear, full-width */}
                <button
                  onClick={() => onToggle(r.key, !enabled)}
                  style={{
                    width: '100%', padding: '4px 0', borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${enabled ? 'rgba(5,150,105,0.35)' : 'rgba(100,116,139,0.4)'}`,
                    background: enabled ? 'rgba(5,150,105,0.08)' : 'rgba(100,116,139,0.08)',
                    color: enabled ? 'var(--c-success)' : 'var(--text-muted)',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    transition: 'all 0.15s',
                  }}
                >
                  {enabled ? '✓ 已启用' : '○ 已禁用 — 点击启用'}
                </button>
              </div>

              {/* Connector arrow */}
              {i < BUILTIN_ROLES.length - 1 && (
                <div style={{ display: 'flex', alignItems: 'center', height: 148, margin: '0 3px' }}>
                  <div style={{ width: 20, height: 2, background: st === 'done' ? 'var(--c-success)' : 'var(--border)', transition: 'background 0.4s', borderRadius: 1 }} />
                  <div style={{ fontSize: 8, color: st === 'done' ? 'var(--c-success)' : 'var(--border)', marginLeft: -1 }}>▶</div>
                </div>
              )}
            </React.Fragment>
          )
        })}

        {/* Custom agent nodes */}
        {customAgents.map(ca => {
          const roleKey  = `custom_${ca.id}`
          const st       = statuses[roleKey] ?? 'idle'
          const active   = currentRole === roleKey
          const metric   = roleMetrics[roleKey]
          const borderC  = active ? '#7C3AED' : st === 'done' ? 'var(--c-success)' : 'rgba(124,58,237,0.35)'
          return (
            <React.Fragment key={ca.id}>
              <div style={{ display: 'flex', alignItems: 'center', height: 148, margin: '0 3px' }}>
                <div style={{ width: 20, height: 2, background: 'rgba(124,58,237,0.3)', borderRadius: 1, borderTop: '1px dashed rgba(124,58,237,0.4)' }} />
                <div style={{ fontSize: 8, color: 'rgba(124,58,237,0.5)', marginLeft: -1 }}>▶</div>
              </div>
              <div style={{
                width: 148, background: 'var(--bg)',
                border: `1.5px dashed ${borderC}`,
                borderRadius: 10, padding: '10px 10px 8px',
                display: 'flex', flexDirection: 'column', gap: 6,
                opacity: ca.enabled ? 1 : 0.55,
                boxShadow: active ? '0 0 0 3px rgba(124,58,237,0.12)' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: 'rgba(124,58,237,0.10)', border: `1.5px dashed ${borderC}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, animation: active ? 'pulse 1.4s ease-in-out infinite' : 'none' }}>
                    {ca.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ca.name}</div>
                    <div style={{ fontSize: 9, color: '#a78bfa', lineHeight: 1.2 }}>↳ {ca.insertAfter} 之后</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '0.5px solid var(--border)', paddingTop: 5 }}>
                  {ca.description || '自定义 Agent'}
                </div>
                <div style={{ fontSize: 10, color: metric ? 'var(--c-success)' : 'var(--text-muted)' }}>
                  {metric ? `${metric.count} 个 · ${(metric.durationMs/1000).toFixed(1)}s` : (active ? '运行中…' : '等待中')}
                </div>
                <div style={{ fontSize: 9, color: '#a78bfa', background: 'rgba(124,58,237,0.08)', padding: '2px 6px', borderRadius: 4, textAlign: 'center', border: '0.5px solid rgba(124,58,237,0.2)' }}>
                  ✦ 自定义 Agent
                </div>
                <button onClick={() => onDeleteCustom(ca.id)} style={{ width: '100%', padding: '3px 0', borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: 'var(--c-danger)', fontSize: 10, fontFamily: 'inherit' }}>
                  ✕ 删除此 Agent
                </button>
              </div>
            </React.Fragment>
          )
        })}

        {/* Add Agent button */}
        <div style={{ display: 'flex', alignItems: 'center', height: 148, margin: '0 3px' }}>
          <div style={{ width: 14, height: 2, background: 'var(--border)', borderRadius: 1 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', height: 148 }}>
          <button
            onClick={onAddAgent}
            style={{
              width: 80, height: 80, borderRadius: 10,
              border: '2px dashed var(--border)', background: 'transparent',
              cursor: 'pointer', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 5,
              fontSize: 22, color: 'var(--text-muted)', fontFamily: 'inherit',
              transition: 'all 0.2s',
            }}
            onMouseEnter={e => { const b = e.currentTarget; b.style.borderColor = 'var(--primary)'; b.style.color = 'var(--primary)'; b.style.background = 'rgba(79,70,229,0.05)' }}
            onMouseLeave={e => { const b = e.currentTarget; b.style.borderColor = 'var(--border)'; b.style.color = 'var(--text-muted)'; b.style.background = 'transparent' }}
            title="添加自定义 Agent"
          >
            <span>＋</span>
            <span style={{ fontSize: 9 }}>添加 Agent</span>
          </button>
        </div>

      </div>
    </div>
  )
}

// ── Execution Log Panel (left) ────────────────────────────────────────────────

function ExecutionLogPanel({ log, running, done, summary, onStart, onStop, onAnswerQuestion }: {
  log: LogEntry[]; running: boolean; done: boolean
  summary: { processed: number; applied: number; pending: number; skipped: number; failed: number } | null
  onStart: () => void; onStop: () => void
  onAnswerQuestion: (entry: LogEntry, opt: QuestionOption) => void
}) {
  const logEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  // Group logs by role
  const grouped: { role: string; icon: string; label: string; entries: LogEntry[] }[] = []
  for (const entry of log) {
    const roleKey = entry.role ?? 'orchestrator'
    const last    = grouped[grouped.length - 1]
    if (last && last.role === roleKey) {
      last.entries.push(entry)
    } else {
      const meta = BUILTIN_ROLES.find(r => r.key === roleKey)
      grouped.push({
        role:    roleKey,
        icon:    meta?.icon ?? '🧠',
        label:   meta?.label ?? roleKey,
        entries: [entry],
      })
    }
  }

  function entryColor(e: LogEntry): string {
    if (e.type === 'done')               return 'var(--c-success)'
    if (e.type === 'error')              return 'var(--c-danger)'
    if (e.type === 'role_start')         return 'var(--primary)'
    if (e.type === 'role_done')          return 'var(--c-success)'
    if (e.type === 'job_skip')           return 'var(--text-muted)'
    if (e.type === 'agent_plan')           return '#818cf8'
    if (e.type === 'agent_action')         return 'var(--text)'
    if (e.type === 'agent_observation')    return '#94a3b8'
    if (e.type === 'agent_reflect')        return 'var(--c-success)'
    if (e.type === 'orchestrator_plan')    return '#f59e0b'   // amber — master plan
    if (e.type === 'orchestrator_fix')     return '#f97316'   // orange — fix
    if (e.type === 'orchestrator_retry')   return '#fb923c'   // light orange — retry
    if (e.type === 'orchestrator_decision')return '#a78bfa'   // purple — decision
    if (e.type === 'orchestrator_complete')return '#34d399'   // emerald — done
    if (e.score != null)                 return e.score >= 80 ? 'var(--c-success)' : e.score >= 60 ? 'var(--c-warning)' : 'var(--text-muted)'
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

  function entryIndent(e: LogEntry): number {
    if (e.type === 'agent_observation') return 16
    if (e.type === 'agent_action')      return 8
    return 0
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>执行日志</span>
          {running && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--c-success)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--c-success)', display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' }} />
              运行中…
            </span>
          )}
          {done && !running && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>已完成</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!running && <Btn small variant="primary" onClick={onStart}>{done ? '↻ 再次运行' : '▶ 开始运行'}</Btn>}
          {running   && <Btn small variant="danger"  onClick={onStop}>⏹ 停止</Btn>}
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div style={{ display: 'flex', borderBottom: '0.5px solid var(--border)', flexShrink: 0 }}>
          {[
            { label: '已处理', value: summary.processed, color: 'var(--text)'        },
            { label: '已投递', value: summary.applied,   color: 'var(--c-success)'   },
            { label: '待审核', value: summary.pending,   color: 'var(--c-warning)'   },
            { label: '已跳过', value: summary.skipped,   color: 'var(--text-muted)'  },
            { label: '失败',   value: summary.failed,    color: 'var(--c-danger)'    },
          ].map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center', padding: '6px 0', borderRight: i < 4 ? '0.5px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Log body — grouped by agent */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {log.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
            点击「▶ 开始运行」启动 6-Agent 流水线<br />
            <span style={{ fontSize: 10, marginTop: 6, display: 'block' }}>或通过右侧聊天窗口发出指令</span>
          </div>
        ) : grouped.map((group, gi) => (
          <div key={`${group.role}-${gi}`} style={{ marginBottom: 6 }}>
            {/* Agent group header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 14px', background: 'var(--bg-secondary)', borderTop: gi > 0 ? '0.5px solid var(--border)' : 'none', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ fontSize: 13 }}>{group.icon}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)' }}>{group.label}</span>
            </div>
            {/* Entries */}
            {group.entries.map((entry, ei) => {
              // Agent question card
              if (entry.type === 'agent_question') {
                return (
                  <div key={ei} style={{ margin: '6px 14px 6px 20px', borderRadius: 8, border: '1px solid rgba(234,179,8,0.35)', background: 'rgba(234,179,8,0.05)', overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', background: 'rgba(234,179,8,0.08)', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '0.5px solid rgba(234,179,8,0.2)' }}>
                      <span style={{ fontSize: 14 }}>🤔</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#b45309' }}>
                        {BUILTIN_ROLES.find(r => r.key === entry.role)?.label ?? 'Agent'} 需要你的决定
                      </span>
                      {entry.answered && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--c-success)' }}>✓ 已回答</span>}
                    </div>
                    <div style={{ padding: '8px 12px' }}>
                      <p style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.6, margin: '0 0 8px' }}>{entry.question}</p>
                      {!entry.answered && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {entry.options?.map((opt, oi) => (
                            <button key={oi} onClick={() => onAnswerQuestion(entry, opt)} style={{
                              padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
                              border: '1px solid rgba(234,179,8,0.4)', background: 'rgba(234,179,8,0.10)',
                              color: '#92400e', fontSize: 11, fontFamily: 'inherit', fontWeight: 500,
                              transition: 'all 0.15s',
                            }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(234,179,8,0.22)' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(234,179,8,0.10)' }}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              }

              // question_answered confirmation
              if (entry.type === 'question_answered') {
                return (
                  <div key={ei} style={{ padding: '2px 14px 2px 20px', fontSize: 11, color: 'var(--c-success)', fontStyle: 'italic' }}>
                    {entry.message}
                  </div>
                )
              }

              // Orchestrator plan — top banner style
              if (entry.type === 'orchestrator_plan') {
                return (
                  <div key={ei} style={{ margin: '6px 14px 2px', padding: '7px 12px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15 }}>🧠</span>
                    <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 500 }}>{entry.message}</span>
                  </div>
                )
              }
              // Orchestrator complete — summary banner
              if (entry.type === 'orchestrator_complete') {
                return (
                  <div key={ei} style={{ margin: '6px 14px 2px', padding: '7px 12px', borderRadius: 7, background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>✅</span>
                    <span style={{ fontSize: 11, color: '#34d399', fontWeight: 500 }}>{entry.message}</span>
                  </div>
                )
              }

              // Normal log entry
              return (
                <div key={ei} style={{
                  display: 'flex', gap: 8,
                  padding: `2px 14px 2px ${20 + entryIndent(entry)}px`,
                  alignItems: 'flex-start',
                  background: entry.type === 'agent_plan' ? 'rgba(79,70,229,0.04)' : 'transparent',
                  borderLeft: entry.type === 'agent_plan' ? '2px solid rgba(129,140,248,0.4)' : 'none',
                }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                    {entry.time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span style={{ fontSize: 11, color: entryColor(entry), lineHeight: 1.6, fontFamily: 'monospace' }}>
                    {entryPrefix(entry)}{entry.message}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
        {/* Empty-state CTA after run with 0 jobs */}
        {done && summary?.processed === 0 && (
          <div style={{ margin: '10px 14px', padding: '10px 12px', background: 'rgba(24,95,165,0.05)', borderRadius: 8, border: '0.5px solid var(--border)', display: 'flex', gap: 10 }}>
            <span style={{ fontSize: 18 }}>💡</span>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              没有待处理职位。先通过 <strong>Chrome 插件</strong>在 LinkedIn/Indeed 保存职位，或在 <strong>Jobs 页面</strong>手动添加。
            </div>
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

// ── Orchestrator Chat Panel (right, inline) ───────────────────────────────────

function OrchestratorChatPanel({
  savedCount, pendingCount, hasRun,
  onAction,
}: {
  savedCount:   number
  pendingCount: number
  hasRun:       boolean
  onAction: (action: { type: string; [k: string]: unknown }) => void
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef  = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Greeting on mount
  useEffect(() => {
    const greeting = savedCount > 0
      ? `你好！我是 Orchestrator 🧠\n\n当前有 **${savedCount}** 个职位待分析${pendingCount > 0 ? `，**${pendingCount}** 个待审核` : ''}。\n\n我可以：\n• 启动/停止流水线\n• 调整任意 Agent 配置\n• 解释评分结果\n• 管理求职策略\n\n用自然语言告诉我你想做什么。`
      : `你好！我是 Orchestrator 🧠\n\n暂无待处理职位。先保存一些职位，我来帮你分析。`
    setMessages([{ role: 'assistant', content: greeting, time: new Date() }])
  }, [])

  const chips = [
    savedCount > 0 && !hasRun ? `▶ 开始分析 ${savedCount} 个职位` : null,
    pendingCount > 0           ? `📋 审核 ${pendingCount} 个待定职位` : null,
    '📊 分析我的求职进展',
    '⚙️ 把最低匹配分设为 80%',
    '🔍 为什么某个职位分低？',
  ].filter(Boolean) as string[]

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return
    const userMsg:    ChatMsg = { role: 'user',      content: text, time: new Date() }
    const pendingMsg: ChatMsg = { role: 'assistant', content: '', time: new Date(), pending: true }
    setMessages(prev => [...prev, userMsg, pendingMsg])
    setInput('')
    setLoading(true)

    const history = [...messages.filter(m => !m.pending), userMsg]
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })
      if (!res.ok) throw new Error(await res.text())

      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = '', fullText = '', event = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
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
            } catch { /* ignore */ }
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

  function renderContent(text: string) {
    return text.replace(/^ACTION:.+$/gm, '').trim()
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '0.5px solid var(--border)' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', background: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 18 }}>🧠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>Orchestrator</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.2 }}>
            {loading ? '思考中…' : '自然语言控制 Agent 团队'}
          </div>
        </div>
        {loading && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', animation: 'pulse 1s ease-in-out infinite' }} />}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 2 }}>
            <div style={{
              maxWidth: '88%', padding: '8px 11px',
              borderRadius: msg.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
              background: msg.role === 'user' ? 'var(--primary)' : 'var(--bg-secondary)',
              color: msg.role === 'user' ? '#fff' : 'var(--text)',
              border: msg.role === 'assistant' ? '0.5px solid var(--border)' : 'none',
              fontSize: 12, lineHeight: 1.65,
              animation: msg.pending ? 'pulse 1s ease-in-out infinite' : 'none',
            }}>
              {msg.pending
                ? <span style={{ color: 'var(--text-muted)', letterSpacing: 3 }}>● ● ●</span>
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
        <div style={{ padding: '4px 10px 6px', display: 'flex', flexWrap: 'wrap', gap: 5, flexShrink: 0 }}>
          {chips.slice(0, 4).map((s, i) => (
            <button key={i} onClick={() => sendMessage(s)} style={{
              padding: '4px 9px', fontSize: 10, borderRadius: 999,
              border: '0.5px solid var(--border)', background: 'var(--bg-secondary)',
              cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 7, alignItems: 'flex-end', flexShrink: 0 }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
          placeholder="告诉 Orchestrator 你想做什么… (Enter 发送)"
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
  )
}

// ── Apply Job Card ────────────────────────────────────────────────────────────

function ApplyJobCard({ job, onApplied }: { job: ApplyReadyJob; onApplied: (id: string) => void }) {
  const [showCL,   setShowCL]   = useState(false)
  const [applying, setApplying] = useState(false)
  const isApplied = job.url?.startsWith('_applied')

  async function handleApply() {
    if (!job.url || isApplied) return
    setApplying(true)
    // Open job URL in new tab
    window.open(job.url, '_blank', 'noopener')
    // After user confirms they applied
    await new Promise(r => setTimeout(r, 800))
    await onApplied(job.jobId)
    setApplying(false)
  }

  return (
    <div style={{
      padding: '10px 14px', borderBottom: '0.5px solid var(--border)',
      opacity: isApplied ? 0.55 : 1, transition: 'opacity 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{job.company}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{job.role}</span>
            {job.location && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>📍{job.location}</span>}
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
              background: job.score >= 80 ? 'rgba(5,150,105,0.12)' : 'rgba(234,179,8,0.12)',
              color: job.score >= 80 ? 'var(--c-success)' : '#b45309',
            }}>{job.score}%</span>
          </div>
          {job.matchedKeywords.length > 0 && (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
              匹配：{job.matchedKeywords.slice(0, 5).join(' · ')}
            </div>
          )}
          {job.coverLetter && (
            <button onClick={() => setShowCL(s => !s)} style={{ marginTop: 4, fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              {showCL ? '▲ 收起求职信' : '▼ 查看求职信'}
            </button>
          )}
          {showCL && job.coverLetter && (
            <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6, fontSize: 10, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', border: '0.5px solid var(--border)' }}>
              {job.coverLetter}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {isApplied ? (
            <span style={{ fontSize: 11, color: 'var(--c-success)', fontWeight: 600 }}>✓ 已投递</span>
          ) : (
            <button
              onClick={handleApply}
              disabled={applying || !job.url}
              style={{
                padding: '6px 14px', borderRadius: 7, border: 'none',
                background: applying ? 'var(--border)' : 'var(--primary)',
                color: '#fff', fontSize: 11, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {applying ? '…' : '🚀 立即申请'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Add Agent Modal ───────────────────────────────────────────────────────────

const BUILTIN_STAGE_KEYS = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']
const EMOJI_OPTIONS = ['🧩', '🔬', '📌', '🛡', '⚡', '🎯', '🔧', '📊', '🧠', '💡', '🔗', '📋']

function AddAgentModal({ onClose, onCreated }: {
  onClose:   () => void
  onCreated: (agent: CustomAgentRow) => void
}) {
  const toast = useToast()
  const [name,         setName]        = useState('')
  const [icon,         setIcon]        = useState('🧩')
  const [description,  setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [provider,     setProvider]    = useState('anthropic')
  const [model,        setModel]       = useState('claude-haiku-4-5-20251001')
  const [insertAfter,  setInsertAfter] = useState('auditor')
  const [saving,       setSaving]      = useState(false)

  async function handleCreate() {
    if (!name.trim()) { toast.error('请填写名称', ''); return }
    setSaving(true)
    const res = await fetch('/api/agent/roles/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, description, systemPrompt, provider, model, insertAfter }),
    })
    setSaving(false)
    if (!res.ok) { toast.error('创建失败', await res.text()); return }
    const data = await res.json()
    onCreated(data.data ?? data)
    toast.success('自定义 Agent 已创建', `「${name}」将在 ${insertAfter} 阶段后运行`)
    onClose()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', fontSize: 12,
    border: '0.5px solid var(--border)', borderRadius: 6,
    background: 'var(--bg)', color: 'var(--text)', outline: 'none',
    boxSizing: 'border-box', fontFamily: 'inherit',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 14,
        width: 480, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden',
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '14px 18px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>＋ 添加自定义 Agent</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)' }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Icon picker + Name */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>图标</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: 110 }}>
                {EMOJI_OPTIONS.map(e => (
                  <button key={e} onClick={() => setIcon(e)} style={{
                    width: 28, height: 28, borderRadius: 6, border: icon === e ? '2px solid var(--primary)' : '0.5px solid var(--border)',
                    background: icon === e ? 'rgba(79,70,229,0.1)' : 'var(--bg-secondary)',
                    cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{e}</button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>名称 *</div>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：Remote Filter" style={inputStyle} autoFocus />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, marginBottom: 5 }}>描述（可选）</div>
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="简短说明此 Agent 的职责" style={inputStyle} />
            </div>
          </div>

          {/* System Prompt */}
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>System Prompt（告诉 Agent 怎么分析）</div>
            <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
              placeholder={'例如：\n你是一个远程工作过滤专家。对于每个职位，判断它是否支持远程工作。\n如果不支持，说明原因。'}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
            />
          </div>

          {/* Model + Insert After */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>AI 模型</div>
              <ModelSelect provider={provider} model={model} onChange={(p, m) => { setProvider(p); setModel(m) }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>插入在哪个阶段之后</div>
              <select value={insertAfter} onChange={e => setInsertAfter(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {BUILTIN_STAGE_KEYS.map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? '创建中…' : '✓ 创建 Agent'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ── Global Settings (collapsible) ─────────────────────────────────────────────

type UiCfg = {
  minScore: number; maxPerDay: number; autoApply: boolean; requireReview: boolean
  autoCoverLetter: boolean; coverTone: string; useTailoredCV: boolean
  targetRoles: string[]; targetLocations: string[]
  excludeCompanies: string[]; priorityCompanies: string[]
  salaryMin: number; salaryMax: number
  throttleMs: number
}

const DEFAULT_CFG: UiCfg = {
  minScore: 75, maxPerDay: 10, autoApply: false, requireReview: true,
  autoCoverLetter: false, coverTone: 'professional', useTailoredCV: false,
  targetRoles: [], targetLocations: [], excludeCompanies: [], priorityCompanies: [],
  salaryMin: 0, salaryMax: 0,
  throttleMs: 300,
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

function GlobalSettingsCollapsible({ cfg, set, onSave, onReset, saving }: {
  cfg: UiCfg; set: <K extends keyof UiCfg>(k: K, v: UiCfg[K]) => void
  onSave: () => void; onReset: () => void; saving: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderTop: '0.5px solid var(--border)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '10px 16px', border: 'none', background: 'var(--bg-secondary)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 12, fontWeight: 500, color: 'var(--text)', fontFamily: 'inherit',
        }}
      >
        <span>⚙ 全局流水线设置</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>

      {open && (
        <div style={{ padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))', gap: '0 20px' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '6px 0', borderBottom: '0.5px solid var(--border)', marginBottom: 4 }}>职位匹配规则</div>
            <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12 }}>最低匹配分</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--primary)' }}>{cfg.minScore}%</span>
              </div>
              <input type="range" min={40} max={100} value={cfg.minScore} onChange={e => set('minScore', Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }} />
            </div>
            <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div>
                  <span style={{ fontSize: 12 }}>AI 调用间隔</span>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>每个职位评分之间的等待时间（避免限流）</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--primary)' }}>{cfg.throttleMs}ms</span>
              </div>
              <input type="range" min={100} max={2000} step={100} value={cfg.throttleMs} onChange={e => set('throttleMs', Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>100ms（快）</span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>2000ms（慢/安全）</span>
              </div>
            </div>
            <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标职位</div>
              <PillInput values={cfg.targetRoles} onChange={v => set('targetRoles', v)} placeholder="添加职位…" />
            </div>
            <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标城市</div>
              <PillInput values={cfg.targetLocations} onChange={v => set('targetLocations', v)} placeholder="添加城市…" />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '6px 0', borderBottom: '0.5px solid var(--border)', marginBottom: 4 }}>自动投递设置</div>
            <Toggle label="自动投递（匹配分≥最低分）" sub="无需审核自动投递" value={cfg.autoApply} onChange={v => set('autoApply', v)} />
            <Toggle label="需要人工审核" sub="职位进入审核列后投递" value={cfg.requireReview} onChange={v => set('requireReview', v)} />
            <Toggle label="自动生成求职信" sub="AI 为每个职位撰写" value={cfg.autoCoverLetter} onChange={v => set('autoCoverLetter', v)} />
            <Toggle label="定制简历关键词" sub="记录每个职位缺失关键词" value={cfg.useTailoredCV} onChange={v => set('useTailoredCV', v)} />
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '6px 0', borderBottom: '0.5px solid var(--border)', marginBottom: 4 }}>公司管理</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>排除公司</div>
            <PillInput values={cfg.excludeCompanies} onChange={v => set('excludeCompanies', v)} placeholder="添加公司…" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 4px' }}>优先公司</div>
            <PillInput values={cfg.priorityCompanies} onChange={v => set('priorityCompanies', v)} placeholder="添加公司…" />
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Btn variant="primary" onClick={onSave} disabled={saving}>{saving ? '保存中…' : '💾 保存设置'}</Btn>
              <Btn variant="ghost" onClick={onReset}>重置</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AgentPlaygroundPage() {
  const toast = useToast()

  const { data: agentData }                              = useApi<AgentConfig>('/api/agent')
  const { data: rolesData, refetch: refetchRoles }       = useApi<AgentRole[]>('/api/agent/roles')
  const { data: jobsData }                               = useApi<{ jobs: Array<{ status: string }> }>('/api/jobs?pageSize=100')
  const { data: customData, refetch: refetchCustom }     = useApi<CustomAgentRow[]>('/api/agent/roles/custom')

  const [globalRunning, setGlobalRunning] = useState(false)
  const [cfg,           setCfg]           = useState<UiCfg>(DEFAULT_CFG)
  const [saving,        setSaving]        = useState(false)
  const [savingRoles,   setSavingRoles]   = useState<Partial<Record<string, boolean>>>({})
  const [hasRun,        setHasRun]        = useState(false)
  const [showAddModal,  setShowAddModal]  = useState(false)
  const [applyQueue,    setApplyQueue]    = useState<ApplyReadyJob[]>([])

  // Pipeline run state
  const [roleStatuses,  setRoleStatuses]  = useState<Record<string, RoleStatus>>(
    () => Object.fromEntries(BUILTIN_ROLES.map(r => [r.key, 'idle'])) as Record<string, RoleStatus>
  )
  const [currentRole,   setCurrentRole]   = useState<string | null>(null)
  const [roleMetrics,   setRoleMetrics]   = useState<Partial<Record<string, RoleMetric>>>({})
  const [currentJobs,   setCurrentJobs]   = useState<Partial<Record<string, { company: string; role: string; score?: number }>>>({})
  const [runLog,        setRunLog]        = useState<LogEntry[]>([])
  const [runDone,       setRunDone]       = useState(false)
  const [runSummary,    setRunSummary]    = useState<{ processed: number; applied: number; pending: number; skipped: number; failed: number } | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Sync config from API
  useEffect(() => {
    if (!agentData) return
    setGlobalRunning(agentData.isRunning)
    setCfg(prev => ({
      ...prev,
      minScore:         agentData.minMatchScore,
      maxPerDay:        agentData.dailyLimit,
      autoApply:        agentData.autoApply,
      requireReview:    agentData.requireApproval,
      throttleMs:       (agentData as any).throttleMs       ?? 300,
      autoCoverLetter:  (agentData as any).autoCoverLetter  ?? false,
      coverTone:        (agentData as any).coverTone        ?? 'professional',
      useTailoredCV:    (agentData as any).useTailoredCV    ?? false,
      targetRoles:      agentData.targetRoles               ?? [],
      targetLocations:  agentData.targetLocations           ?? [],
      excludeCompanies: agentData.excludeCompanies          ?? [],
      priorityCompanies:(agentData as any).priorityCompanies ?? [],
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
    setCurrentJobs({})
    setCurrentRole(null)
    setApplyQueue([])
    setRoleStatuses(Object.fromEntries(BUILTIN_ROLES.map(r => [r.key, 'idle'])) as Record<string, RoleStatus>)

    const es = new EventSource('/api/agent/run')
    esRef.current = es

    es.addEventListener('role_start', e => {
      const d = JSON.parse(e.data) as { role: string; label: string; model: string; icon: string }
      setCurrentRole(d.role)
      setRoleStatuses(prev => ({ ...prev, [d.role]: 'running' }))
      addLog({ role: d.role, type: 'role_start', message: `${d.icon} [${d.role}] ${d.label} 开始… (${d.model})`, time: new Date() })
    })

    es.addEventListener('role_done', e => {
      const d = JSON.parse(e.data) as { role: string; icon: string; summary: string; count: number; durationMs: number } & RoleMetric
      setRoleStatuses(prev => ({ ...prev, [d.role]: 'done' }))
      setRoleMetrics(prev => ({ ...prev, [d.role]: d }))
      setCurrentJobs(prev => { const n = { ...prev }; delete n[d.role]; return n })
      addLog({ role: d.role, type: 'role_done', message: `✓ ${d.summary} (${(d.durationMs / 1000).toFixed(1)}s)`, time: new Date() })
    })

    es.addEventListener('start', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'start', message: `🚀 流水线启动 — ${d.total} 个职位待处理`, time: new Date() })
    })

    es.addEventListener('job_done', e => {
      const d = JSON.parse(e.data)
      // Update current job for analyst role
      if (currentRole === 'analyst') {
        setCurrentJobs(prev => ({ ...prev, analyst: { company: d.company, role: d.role, score: d.score } }))
      }
      const applied = d.autoApplied ? ' ✓ 已投递' : ''
      const kws = d.matchedKeywords?.length ? ` [${d.matchedKeywords.slice(0, 3).join(', ')}]` : ''
      addLog({ role: currentRole ?? 'analyst', type: 'job_done', message: `${d.score >= 80 ? '✦' : d.score >= 60 ? '◆' : '◇'} ${d.company} · ${d.role} — ${d.score}%${kws}${applied}`, score: d.score, time: new Date() })
    })

    es.addEventListener('job_skip', e => {
      const d = JSON.parse(e.data)
      addLog({ role: currentRole ?? 'scout', type: 'job_skip', message: `— ${d.company} · ${d.role}: ${d.reason}`, time: new Date() })
    })

    es.addEventListener('orchestrator_plan', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_plan', message: `🧠 Orchestrator 策略：${d.plan}`, time: new Date() })
    })
    es.addEventListener('orchestrator_fix', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.stage, type: 'orchestrator_fix', message: d.message, time: new Date() })
    })
    es.addEventListener('orchestrator_retry', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.stage, type: 'orchestrator_retry', message: d.message, time: new Date() })
    })
    es.addEventListener('orchestrator_decision', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_decision', message: `⚖ Orchestrator 决策 [${d.stage}]：${d.reason}`, time: new Date() })
    })
    es.addEventListener('orchestrator_complete', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'orchestrator_complete', message: `🧠 ${d.message}`, time: new Date() })
    })

    es.addEventListener('apply_ready', e => {
      const d = JSON.parse(e.data) as ApplyReadyJob
      setApplyQueue(prev => [...prev, d])
    })

    es.addEventListener('agent_question', e => {
      const d = JSON.parse(e.data)
      addLog({
        role: d.role, type: 'agent_question', message: d.question,
        questionId: d.questionId, question: d.question, options: d.options,
        answered: false, time: new Date(),
      })
    })

    es.addEventListener('agent_plan', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_plan', message: d.plan, time: new Date() })
    })

    es.addEventListener('agent_action', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_action', message: d.action, time: new Date() })
    })

    es.addEventListener('agent_observation', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_observation', message: d.observation, time: new Date() })
    })

    es.addEventListener('agent_reflect', e => {
      const d = JSON.parse(e.data)
      addLog({ role: d.role, type: 'agent_reflect', message: d.reflect, time: new Date() })
    })

    es.addEventListener('info', e => {
      const d = JSON.parse(e.data)
      addLog({ type: 'info', message: `ℹ ${d.message}`, time: new Date() })
    })

    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      setRunSummary(d)
      setRunDone(true)
      setCurrentRole(null)
      setCurrentJobs({})
      addLog({ type: 'done', message: `✅ 流水线完成 — ${d.processed} 个评分，${d.applied} 个投递，${d.pending} 个待审核，${d.skipped} 个跳过`, time: new Date() })
      es.close(); esRef.current = null
      refetchRoles()
      if (d.processed > 0) toast.success('流水线完成', `${d.processed} 个职位已评分，投递 ${d.applied} 个`)
    })

    es.addEventListener('error', e => {
      try { const d = JSON.parse((e as MessageEvent).data ?? '{}'); addLog({ type: 'error', message: `✗ ${d.message ?? '流水线错误'}`, time: new Date() }) }
      catch { addLog({ type: 'error', message: '✗ 连接断开', time: new Date() }) }
      setCurrentRole(null); setRunDone(true)
      es.close(); esRef.current = null
    })
  }

  function stopRun() {
    esRef.current?.close(); esRef.current = null
    setCurrentRole(null); setRunDone(true)
    addLog({ type: 'info', message: '— 用户停止运行', time: new Date() })
  }

  const isRunning = !!currentRole || (runLog.length > 0 && !runDone)

  // ── Role controls ──────────────────────────────────────────────────────────

  const handleModelChange = useCallback(async (role: string, provider: string, model: string) => {
    setSavingRoles(prev => ({ ...prev, [role]: true }))
    await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { provider, model })
    await refetchRoles()
    setSavingRoles(prev => ({ ...prev, [role]: false }))
    toast.success('模型已更新', `${role} → ${model}`)
  }, [refetchRoles, toast])

  const handleRoleToggle = useCallback(async (role: string, enabled: boolean) => {
    await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
    await refetchRoles()
    toast.info(enabled ? `${role} 已启用` : `${role} 已禁用`, '')
  }, [refetchRoles, toast])

  // ── Chat action handler ────────────────────────────────────────────────────

  const handleChatAction = useCallback(async (action: { type: string; [k: string]: unknown }) => {
    switch (action.type) {
      case 'start_run':
        startRun()
        toast.info('流水线已启动', 'Orchestrator 触发运行')
        break
      case 'stop_run':
        stopRun()
        toast.info('流水线已停止', '')
        break
      case 'toggle_agent': {
        const role    = action.role    as string
        const enabled = action.enabled as boolean
        await apiMutate(`/api/agent/roles/${role}`, 'PATCH', { enabled })
        await refetchRoles()
        toast.info(enabled ? `${role} 已启用` : `${role} 已禁用`, '')
        break
      }
      case 'update_config': {
        const field = action.field as string
        const value = action.value
        await apiMutate('/api/agent', 'PATCH', { [field]: value })
        const cfgMap: Record<string, keyof UiCfg> = {
          minMatchScore: 'minScore', dailyLimit: 'maxPerDay',
          autoApply: 'autoApply', requireApproval: 'requireReview',
        }
        const uiField = cfgMap[field]
        if (uiField) setCfg(c => ({ ...c, [uiField]: value }))
        toast.success('设置已更新', `${field} → ${value}`)
        break
      }
      case 'navigate':
        if (action.path === 'jobs') window.location.href = '/?page=jobs'
        break
    }
  }, [refetchRoles, toast])

  // ── Global config save ─────────────────────────────────────────────────────

  async function saveGlobalConfig() {
    setSaving(true)
    const { error } = await apiMutate('/api/agent', 'PATCH', {
      isRunning: globalRunning, dailyLimit: cfg.maxPerDay, minMatchScore: cfg.minScore,
      autoApply: cfg.autoApply, requireApproval: cfg.requireReview,
      targetLocations: cfg.targetLocations, targetRoles: cfg.targetRoles,
      excludeCompanies: cfg.excludeCompanies, priorityCompanies: cfg.priorityCompanies,
      autoCoverLetter: cfg.autoCoverLetter, coverTone: cfg.coverTone, useTailoredCV: cfg.useTailoredCV,
      throttleMs: cfg.throttleMs,
    })
    setSaving(false)
    if (error) toast.error('保存失败', error)
    else       toast.success('设置已保存', '')
  }

  async function toggleGlobalRunning() {
    const next = !globalRunning
    setGlobalRunning(next)
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) { setGlobalRunning(!next); toast.error('操作失败', error) }
    else toast.info(next ? 'Agent 已开启' : 'Agent 已暂停', '')
  }

  const handleAnswerQuestion = useCallback(async (entry: LogEntry, opt: QuestionOption) => {
    // Mark answered
    setRunLog(prev => prev.map(l =>
      l.questionId === entry.questionId ? { ...l, answered: true } : l
    ))
    // Apply action
    if (opt.action) {
      const { field, value } = opt.action
      if (field === '_navigate') {
        window.location.href = `/?page=${value}`
        return
      }
      if (field === '_send_email') {
        const emailData = JSON.parse(value as string) as { to: string; draft: string; subject: string; jobId: string }
        await apiMutate('/api/gmail/send-draft', 'POST', emailData)
        toast.success('邮件已发送', `拒信问询已发送至 ${emailData.to}`)
        return
      }
      await apiMutate('/api/agent', 'PATCH', { [field]: value })
      // Sync local cfg
      const cfgMap: Record<string, keyof UiCfg> = {
        minMatchScore: 'minScore', dailyLimit: 'maxPerDay',
        autoApply: 'autoApply', requireApproval: 'requireReview',
      }
      const uiField = cfgMap[field]
      if (uiField) setCfg(c => ({ ...c, [uiField]: value }))
    }
    addLog({
      type: 'question_answered',
      message: `✓ 你选择了「${opt.label}」${opt.action ? '，偏好已保存' : ''}`,
      time: new Date(),
    })
    toast.success('偏好已记录', opt.action ? '设置已更新，下次运行生效' : '已知悉，继续运行')
  }, [toast])

  const handleDeleteCustom = useCallback(async (id: string) => {
    const res = await fetch(`/api/agent/roles/custom/${id}`, { method: 'DELETE' })
    if (res.ok) {
      await refetchCustom()
      toast.success('自定义 Agent 已删除', '')
    } else {
      toast.error('删除失败', '')
    }
  }, [refetchCustom, toast])

  const roles        = rolesData   ?? []
  const customAgents = customData  ?? []
  const savedCount   = (jobsData?.jobs ?? []).filter(j => j.status === 'saved').length
  const pendingCount = (jobsData?.jobs ?? []).filter(j => j.status === 'review').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      {/* TopBar */}
      <TopBar title="AI Agent">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: globalRunning ? 'var(--c-success)' : 'var(--text-muted)', boxShadow: globalRunning ? '0 0 6px var(--c-success)' : 'none' }} />
          <span style={{ fontSize: 11, color: globalRunning ? 'var(--c-success)' : 'var(--text-muted)', fontWeight: 500 }}>
            {globalRunning ? '运行中' : '已暂停'}
          </span>
        </div>
        <Btn variant={globalRunning ? 'danger' : 'primary'} onClick={toggleGlobalRunning}>
          {globalRunning ? '⏸ 暂停 Agent' : '▶ 启用 Agent'}
        </Btn>
      </TopBar>

      {/* Pipeline Monitor Bar (sticky top) */}
      <PipelineMonitorBar
        statuses={roleStatuses}
        currentRole={currentRole}
        roleMetrics={roleMetrics}
        currentJobs={currentJobs}
        roles={roles}
        savingRoles={savingRoles}
        customAgents={customAgents}
        onModelChange={handleModelChange}
        onToggle={handleRoleToggle}
        onAddAgent={() => setShowAddModal(true)}
        onDeleteCustom={handleDeleteCustom}
      />

      {/* Add Agent Modal */}
      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onCreated={async () => { await refetchCustom() }}
        />
      )}

      {/* Main content: left log + right chat */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Execution Log + Apply Queue */}
        <div style={{ flex: '0 0 58%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ExecutionLogPanel
            log={runLog}
            running={isRunning}
            done={runDone}
            summary={runSummary}
            onStart={startRun}
            onStop={stopRun}
            onAnswerQuestion={handleAnswerQuestion}
          />
          {/* Manual Apply Queue */}
          {applyQueue.length > 0 && (
            <div style={{ borderTop: '0.5px solid var(--border)', background: 'var(--bg)', flexShrink: 0, maxHeight: 280, overflowY: 'auto' }}>
              <div style={{ padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: 8, position: 'sticky', top: 0, background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', zIndex: 1 }}>
                <span style={{ fontSize: 14 }}>📋</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>待申请队列</span>
                <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, background: 'var(--primary)', color: '#fff', fontWeight: 600 }}>{applyQueue.filter(j => !j.url?.startsWith('_applied')).length}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>点击「立即申请」确认投递</span>
              </div>
              {applyQueue.map(job => (
                <ApplyJobCard key={job.jobId} job={job} onApplied={async (jobId) => {
                  await apiMutate(`/api/jobs/${jobId}/apply`, 'POST', {})
                  setApplyQueue(prev => prev.map(j => j.jobId === jobId ? { ...j, url: `_applied_${j.url}` } : j))
                  toast.success('已标记为投递', `${job.company} · ${job.role}`)
                }} />
              ))}
            </div>
          )}
        </div>

        {/* Right: Orchestrator Chat */}
        <div style={{ flex: '0 0 42%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <OrchestratorChatPanel
            savedCount={savedCount}
            pendingCount={pendingCount}
            hasRun={hasRun}
            onAction={handleChatAction}
          />
        </div>
      </div>

      {/* Bottom: Collapsible settings */}
      <GlobalSettingsCollapsible
        cfg={cfg} set={set} onSave={saveGlobalConfig} onReset={() => setCfg(DEFAULT_CFG)} saving={saving}
      />
    </div>
  )
}
