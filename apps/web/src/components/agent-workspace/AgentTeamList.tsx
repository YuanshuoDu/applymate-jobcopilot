'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentRole } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { projectTaskTree, type WorkspaceTaskInput, type WorkspaceTaskNode } from './agent-workspace-projection'
import { taskStatusColor, taskStatusLabel } from './session-view-model'

export interface CustomAgentRow {
  id: string
  name: string
  icon: string
  provider: string
  model: string
  enabled: boolean
}

interface TaskResponse {
  tasks: WorkspaceTaskInput[]
}

const ROLE_LABEL: Record<string, string> = {
  scout: 'Scout',
  analyst: 'Analyst',
  writer: 'Writer',
  reviewer: 'Reviewer',
  executor: 'Executor',
  auditor: 'Auditor',
}

export function AgentTeamList({ onAddAgent, sessionId = null }: { onAddAgent?: () => void; sessionId?: string | null }) {
  const { t } = useI18n()
  const { data: roles, loading, error: rolesError, refetch: refetchRoles } = useApi<AgentRole[]>('/api/agent/roles')
  const { data: customAgents, error: customError, refetch: refetchCustomAgents } = useApi<CustomAgentRow[]>('/api/agent/roles/custom')
  const taskUrl = sessionId ? `/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?limit=100` : '/api/agent/sessions/tasks'
  const { data: taskData, loading: tasksLoading, error: tasksError, refetch: refetchTasks } = useApi<TaskResponse>(taskUrl, { enabled: Boolean(sessionId) })
  const builtin = (roles ?? []).slice(0, 6)
  const custom = customAgents ?? []
  const error = rolesError ?? customError

  React.useEffect(() => {
    const refresh = () => {
      void refetchRoles()
      void refetchCustomAgents()
      if (sessionId) void refetchTasks()
    }
    window.addEventListener('applymate:agents-changed', refresh)
    return () => window.removeEventListener('applymate:agents-changed', refresh)
  }, [refetchCustomAgents, refetchRoles, refetchTasks, sessionId])

  const taskTree = React.useMemo(() => projectTaskTree(taskData?.tasks ?? []), [taskData?.tasks])

  return (
    <>
      <Section title={t('agent.team')} action={onAddAgent ? { label: `+ ${t('agent.add')}`, onClick: onAddAgent } : undefined}>
      {loading && <Muted>{t('agent.loadingTeam')}</Muted>}
      {!loading && error && <Muted tone="error" title={error}>{t('agent.teamUnavailable')}</Muted>}
      {!loading && !error && builtin.length === 0 && custom.length === 0 && <Muted>{t('agent.noAgents')}</Muted>}
      {!error && builtin.map(role => (
        <TeamRow
          key={role.role}
          name={ROLE_LABEL[role.role] ?? role.role}
          model={role.model}
          enabled={role.enabled}
          detail={role.lastResult?.summary ?? (role.lastRunAt ? t('agent.recentActivity') : t('agent.idle'))}
        />
      ))}
      {!error && custom.map(agent => (
        <TeamRow
          key={agent.id}
          name={`${agent.icon} ${agent.name}`}
          model={agent.model}
          enabled={agent.enabled}
          detail={t('agent.custom')}
        />
      ))}
      </Section>
      {sessionId && (
        <Section title="Task tree">
          {tasksLoading && <Muted>Loading task tree…</Muted>}
          {!tasksLoading && tasksError && <Muted tone="error" title={tasksError}>Task tree unavailable. Refresh to retry.</Muted>}
          {!tasksLoading && !tasksError && taskTree.length === 0 && <Muted>No task records for this session.</Muted>}
          {!tasksLoading && !tasksError && taskTree.map(node => <TaskTreeRow key={node.task.id} node={node} depth={0} />)}
        </Section>
      )}
    </>
  )
}

function TaskTreeRow({ node, depth }: { node: WorkspaceTaskNode; depth: number }) {
  const task = node.task
  const color = taskStatusColor(task.status)
  return (
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '6px 0', paddingLeft: depth * 12, borderTop: depth === 0 ? 'none' : '1px solid var(--border)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, marginTop: 4, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.role} · {task.taskType}</span>
            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 9, color }}>{taskStatusLabel(task.status)}</span>
          </div>
          {task.goal && <div style={{ marginTop: 2, fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.goal}</div>}
          {node.orphaned && <div style={{ marginTop: 2, fontSize: 9, color: '#d97706' }}>Parent task unavailable; shown at root.</div>}
        </div>
      </div>
      {node.children.map(child => <TaskTreeRow key={child.task.id} node={child} depth={depth + 1} />)}
    </React.Fragment>
  )
}

function TeamRow({ name, model, enabled, detail }: {
  name: string
  model: string
  enabled: boolean
  detail: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: enabled ? 'var(--c-success)' : 'var(--text-muted)',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
          <span style={{ fontSize: 9, color: enabled ? 'var(--c-success)' : 'var(--text-muted)', marginLeft: 'auto' }}>
            {enabled ? 'active' : 'off'}
          </span>
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model} · {detail}
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: { label: string; onClick: () => void }
  children: React.ReactNode
}) {
  return (
    <div style={{ padding: '0 10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>
          {title}
        </div>
        {action && (
          <button
            onClick={action.onClick}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--primary)',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0,
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', padding: '4px 9px' }}>
        {children}
      </div>
    </div>
  )
}

function Muted({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'error'; title?: string }) {
  return <div title={title} style={{ padding: '8px 0', fontSize: 10, color: tone === 'error' ? 'var(--c-danger)' : 'var(--text-muted)' }}>{children}</div>
}
