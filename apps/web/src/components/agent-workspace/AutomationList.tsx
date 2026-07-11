'use client'

import React from 'react'
import { apiMutate, useApi } from '@/lib/hooks'
import { AutomationCreateModal } from './AutomationCreateModal'
import { AutomationRow, type AgentAutomation } from './AutomationRow'

interface AutomationsResponse {
  automations: AgentAutomation[]
}

export function AutomationList({ onCreate, onSessionStarted }: {
  onCreate: () => void
  onSessionStarted?: (sessionId: string) => void
}) {
  const { data, loading, error, refetch } = useApi<AutomationsResponse>('/api/agent/automations')
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editingAutomation, setEditingAutomation] = React.useState<AgentAutomation | null>(null)
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const rows = data?.automations ?? []

  React.useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('applymate:automations-changed', refresh)
    return () => window.removeEventListener('applymate:automations-changed', refresh)
  }, [refetch])

  async function toggleAutomation(row: AgentAutomation) {
    setNotice(null)
    setPendingId(row.id)
    const { error: updateError } = await apiMutate(`/api/agent/automations/${row.id}`, 'PATCH', { enabled: !row.enabled })
    setPendingId(null)
    if (updateError) {
      setNotice({ tone: 'error', message: updateError })
      return
    }
    setNotice({ tone: 'success', message: row.enabled ? 'Automation paused.' : 'Automation resumed.' })
    await refetch()
  }

  async function runAutomation(row: AgentAutomation) {
    if (!row.enabled) return
    setNotice(null)
    setPendingId(row.id)
    const { data: runData, error: runError } = await apiMutate<{ session?: { id?: string } }>(
      `/api/agent/automations/${row.id}/run`,
      'POST',
    )
    setPendingId(null)
    if (runError) {
      setNotice({ tone: 'error', message: runError })
      return
    }
    window.dispatchEvent(new Event('applymate:sessions-changed'))
    await refetch()
    const sessionId = runData?.session?.id
    setNotice({ tone: 'success', message: sessionId ? 'Automation run started.' : 'Automation run queued.' })
    if (sessionId) onSessionStarted?.(sessionId)
  }

  async function handleSaved() {
    setNotice({ tone: 'success', message: editingAutomation ? 'Automation updated.' : 'Automation created.' })
    setEditingAutomation(null)
    window.dispatchEvent(new Event('applymate:automations-changed'))
    await refetch()
  }

  function openCreate() {
    setNotice(null)
    setEditingAutomation(null)
    setCreateOpen(true)
  }

  function openEdit(row: AgentAutomation) {
    setNotice(null)
    setEditingAutomation(row)
    setCreateOpen(true)
  }

  function closeModal() {
    setCreateOpen(false)
    setEditingAutomation(null)
  }

  return (
    <div style={{ padding: '0 10px 12px' }}>
      <AutomationCreateModal
        open={createOpen}
        automation={editingAutomation}
        onClose={closeModal}
        onSaved={() => { void handleSaved() }}
        onAskAgent={() => {
          closeModal()
          window.dispatchEvent(new CustomEvent('applymate:composer-prefill', {
            detail: '帮我创建一个新的自动化任务：工作日早上 9 点搜索目标职位，85 分以上进入申请队列，提交前需要我批准。',
          }))
          onCreate()
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>
            Automations
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            Create manually or ask the agent
          </div>
        </div>
        <button
          onClick={openCreate}
          title="Create automation"
          style={{ width: 24, height: 24, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
        >
          +
        </button>
      </div>
      {notice && <AutomationNotice tone={notice.tone}>{notice.message}</AutomationNotice>}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', overflow: 'hidden' }}>
        {loading && <AutomationEmpty>Loading automations...</AutomationEmpty>}
        {error && <AutomationEmpty tone="error" title={error}>Automations unavailable.</AutomationEmpty>}
        {!loading && !error && rows.length === 0 && <AutomationEmpty>No automations yet.</AutomationEmpty>}
        {rows.map((row, index) => (
          <AutomationRow
            key={row.id}
            row={row}
            index={index}
            pending={pendingId === row.id}
            onToggle={item => void toggleAutomation(item)}
            onEdit={openEdit}
            onRun={item => void runAutomation(item)}
          />
        ))}
      </div>
    </div>
  )
}

function AutomationNotice({ tone, children }: { tone: 'success' | 'error'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        marginBottom: 7,
        border: `1px solid ${tone === 'error' ? 'rgba(220,38,38,0.24)' : 'rgba(5,150,105,0.24)'}`,
        borderRadius: 8,
        background: tone === 'error' ? 'rgba(254,242,242,0.85)' : 'rgba(236,253,245,0.85)',
        color: tone === 'error' ? 'var(--c-danger)' : 'var(--c-success)',
        padding: '7px 9px',
        fontSize: 10,
        lineHeight: 1.35,
      }}
    >
      {children}
    </div>
  )
}

function AutomationEmpty({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'error'; title?: string }) {
  return (
    <div title={title} style={{ padding: '10px 11px', fontSize: 10, color: tone === 'error' ? 'var(--c-danger)' : 'var(--text-muted)', lineHeight: 1.45 }}>
      {children}
    </div>
  )
}
