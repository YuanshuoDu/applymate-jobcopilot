'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Check, MessageSquare, NotebookPen, RefreshCw, Send, UserRound } from 'lucide-react'

interface SupportMessage { id: string; authorType: string; body: string; redacted: boolean; createdAt: string }
interface SupportCase {
  id: string; subject: string; category: string; status: string; priority: string; assignedAdminId: string | null
  slaDueAt: string | null; createdAt: string; updatedAt: string
  requester: { email: string; name: string; plan: string; accountStatus: string; region: string; counts: { jobs: number; applicationTasks: number; resumes: number } }
  messages: SupportMessage[]
}
interface SupportAssignee { id: string; name: string; email: string }

export function slaLabel(dueAt: Date, now = new Date()): string {
  return dueAt.getTime() < now.getTime() ? 'Overdue' : `${Math.max(1, Math.ceil((dueAt.getTime() - now.getTime()) / 3_600_000))}h remaining`
}

export function supportMessageLabel(authorType: string): string {
  return authorType === 'internal_note' ? 'Internal note' : authorType === 'staff_reply' ? 'Reply to customer' : authorType === 'system_event' ? 'System event' : 'Customer message'
}

export function assigneeLabel(value: SupportAssignee): string { return value.name || value.email || value.id }

export function ContactUsPage() {
  const [items, setItems] = useState<SupportCase[]>([])
  const [assignees, setAssignees] = useState<SupportAssignee[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [actorUserId, setActorUserId] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [composerMode, setComposerMode] = useState<'reply' | 'note'>('reply')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const selected = items.find(item => item.id === selectedId) ?? items[0]

  async function load() {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      const response = await fetch(`/api/admin/v1/support/cases?${params.toString()}`, { cache: 'no-store' })
      const body = await response.json() as { items?: SupportCase[]; actorUserId?: string; assignees?: SupportAssignee[]; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to load support cases')
      setItems(body.items ?? []); setAssignees(body.assignees ?? []); setActorUserId(body.actorUserId ?? '')
      if (!selectedId && body.items?.[0]) setSelectedId(body.items[0].id)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load support cases')
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [statusFilter, priorityFilter])

  async function updateCase(patch: Record<string, unknown>) {
    if (!selected) return
    const reason = window.prompt('Reason (10-500 characters)')?.trim() ?? ''
    if (reason.length < 10) return
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...patch, updatedAt: selected.updatedAt, reason }) })
    if (response.ok) await load()
  }

  async function sendMessage() {
    if (!selected || message.trim().length < 1) return
    const reason = window.prompt('Reason (10-500 characters)')?.trim() ?? ''
    if (reason.length < 10) return
    const endpoint = composerMode === 'reply' ? 'reply' : 'notes'
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}/${endpoint}`, { method: 'POST', headers: headers(), body: JSON.stringify({ message, reason }) })
    if (response.ok) { setMessage(''); await load() }
  }

  const ordered = useMemo(() => [...items].sort((a, b) => Number(new Date(a.slaDueAt ?? 0)) - Number(new Date(b.slaDueAt ?? 0))), [items])

  return <div className="contact-us-page" style={{ maxWidth: 1240, margin: '0 auto' }}>
    <style>{`@media (max-width: 1024px) { .contact-workspace { grid-template-columns: 220px minmax(0, 1fr) !important; } .contact-context { grid-column: 1 / -1; border-left: 0 !important; border-top: 1px solid #d9e2ec; } } @media (max-width: 680px) { .contact-workspace { grid-template-columns: minmax(0, 1fr) !important; } .contact-queue { max-height: 260px; border-right: 0 !important; border-bottom: 1px solid #d9e2ec; } .contact-context { grid-column: auto; } }`}</style>
    <header style={headerStyle}>
      <div><div style={eyebrow}>Customer operations</div><h1 style={titleStyle}>Contact us</h1><p style={muted}>Support messages are isolated from Gmail, resumes and candidate secrets.</p></div>
      <button type="button" title="Refresh cases" onClick={() => void load()} style={iconButton}><RefreshCw size={16} aria-hidden="true" /></button>
    </header>
    {error && <ErrorBox text={error} />}
    <div style={filterBar}>
      <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} style={input}><option value="">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting_on_customer">Waiting</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select>
      <select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)} style={input}><option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
    </div>
    {loading ? <p style={muted}>Loading support queue…</p> : <div className="contact-workspace" style={workspace}>
      <section className="contact-queue" style={queue}><h2 style={heading}>Queue <span style={count}>{ordered.length}</span></h2>{ordered.map(item => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} data-selected={selected?.id === item.id} style={queueItem}><strong>{item.subject}</strong><span style={sub}>{item.requester.name || item.requester.email} · {item.category}</span><span style={sub}>{item.priority} · {item.slaDueAt ? slaLabel(new Date(item.slaDueAt)) : 'No SLA'}</span></button>)}{ordered.length === 0 && <p style={muted}>No cases match these filters.</p>}</section>
      {selected ? <section style={conversation}>
        <div style={conversationHeader}><div><h2 style={heading}>{selected.subject}</h2><span style={muted}>{selected.requester.email} · {selected.requester.plan} · {selected.status}</span></div><div style={buttonRow}>
          <select aria-label="Assign case" value={selected.assignedAdminId ?? ''} onChange={event => void updateCase({ assignedAdminId: event.target.value || null })} style={input}><option value="">Unassigned</option>{assignees.map(assignee => <option key={assignee.id} value={assignee.id}>{assigneeLabel(assignee)}</option>)}</select>
          <button type="button" title="Assign to me" onClick={() => void updateCase({ assignedAdminId: actorUserId, status: 'in_progress' })} style={smallButton}><UserRound size={14} aria-hidden="true" /> Assign to me</button>
          <button type="button" title="Resolve case" onClick={() => void updateCase({ status: 'resolved' })} style={smallButton}><Check size={14} aria-hidden="true" /> Resolve</button>
        </div></div>
        <div style={messages}>{selected.messages.map(item => <article key={item.id} style={item.authorType === 'internal_note' ? note : messageCard}><div style={messageHeader}><strong>{supportMessageLabel(item.authorType)}</strong><span style={muted}>{new Date(item.createdAt).toLocaleString()}</span></div><p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{item.body}</p></article>)}</div>
        <div style={composer}><div style={buttonRow}><button type="button" onClick={() => setComposerMode('reply')} style={composerMode === 'reply' ? activeTab : tab}><MessageSquare size={14} aria-hidden="true" /> Reply</button><button type="button" onClick={() => setComposerMode('note')} style={composerMode === 'note' ? activeTab : tab}><NotebookPen size={14} aria-hidden="true" /> Internal note</button></div><textarea value={message} onChange={event => setMessage(event.target.value)} rows={4} placeholder={composerMode === 'reply' ? 'Reply to customer' : 'Internal note'} style={textarea} /><button type="button" disabled={!message.trim()} onClick={() => void sendMessage()} style={primary}><Send size={14} aria-hidden="true" /> {composerMode === 'reply' ? 'Send reply' : 'Add note'}</button></div>
      </section> : <section style={empty}><p style={muted}>Select a case to review its conversation.</p></section>}
      <aside className="contact-context" style={context}><h2 style={heading}>Safe context</h2>{selected && <><div style={contextRow}><span style={muted}>Account</span><strong>{selected.requester.name || 'Unnamed'}</strong></div><div style={contextRow}><span style={muted}>Plan / state</span><strong>{selected.requester.plan} · {selected.requester.accountStatus}</strong></div><div style={contextRow}><span style={muted}>Region</span><strong>{selected.requester.region || 'Unavailable'}</strong></div><div style={contextRow}><span style={muted}>Counts</span><strong>{selected.requester.counts.jobs} jobs · {selected.requester.counts.applicationTasks} tasks</strong></div><div style={contextRow}><span style={muted}>SLA</span><strong>{selected.slaDueAt ? slaLabel(new Date(selected.slaDueAt)) : 'Unavailable'}</strong></div></>}</aside>
    </div>}
  </div>
}

function headers(): HeadersInit { return { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` } }
function ErrorBox({ text }: { text: string }) { return <div role="alert" style={{ marginBottom: 14, padding: 10, border: '1px solid #e6b8b8', color: '#a32d2d', background: '#fff8f8', borderRadius: 6 }}>{text}</div> }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 18 }
const eyebrow = { color: '#5b6b80', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.08em' }
const titleStyle = { margin: '5px 0 0', fontSize: 28 }
const muted = { color: '#5b6b80', fontSize: 12 }
const filterBar = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 12 }
const input = { minHeight: 34, minWidth: 130, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 9px', background: '#fff', color: '#172033', font: 'inherit' }
const workspace = { display: 'grid', gridTemplateColumns: '250px minmax(0,1fr) 220px', minHeight: 620, background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8, overflow: 'hidden' }
const queue = { borderRight: '1px solid #d9e2ec', padding: 12, overflowY: 'auto' as const }
const conversation = { minWidth: 0, display: 'flex', flexDirection: 'column' as const, padding: 16 }
const context = { borderLeft: '1px solid #d9e2ec', padding: 14 }
const empty = { padding: 24, background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8 }
const heading = { margin: '0 0 12px', fontSize: 16 }
const count = { color: '#5b6b80', fontSize: 12, fontWeight: 500 }
const queueItem = { width: '100%', display: 'grid', gap: 4, textAlign: 'left' as const, padding: '11px 9px', marginBottom: 5, border: '1px solid #d9e2ec', borderRadius: 6, background: '#fff', color: '#172033', cursor: 'pointer' }
const sub = { color: '#687b90', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const conversationHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, borderBottom: '1px solid #e5ebf1', paddingBottom: 12 }
const messages = { flex: 1, overflowY: 'auto' as const, display: 'grid', alignContent: 'start', gap: 9, padding: '14px 0' }
const messageCard = { padding: 11, border: '1px solid #d9e2ec', borderRadius: 6, background: '#fff' }
const note = { ...messageCard, background: '#fff8e8', borderColor: '#e8d29c' }
const messageHeader = { display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, fontSize: 11 }
const composer = { borderTop: '1px solid #e5ebf1', paddingTop: 12 }
const textarea = { width: '100%', border: '1px solid #c9d5e1', borderRadius: 5, padding: 8, font: 'inherit', resize: 'vertical' as const, color: '#172033', margin: '8px 0' }
const buttonRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 6, alignItems: 'center' }
const tab = { minHeight: 30, display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', color: '#5b6b80', cursor: 'pointer', padding: '0 8px', fontSize: 11 }
const activeTab = { ...tab, background: '#e8f3f8', color: '#146c94', borderColor: '#9db8ca' }
const primary = { minHeight: 34, display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 6, padding: '0 11px', background: '#146c94', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 12 }
const smallButton = { ...tab, color: '#146c94' }
const iconButton = { width: 32, height: 32, display: 'inline-grid', placeItems: 'center', border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', cursor: 'pointer' }
const contextRow = { display: 'grid', gap: 4, borderBottom: '1px solid #e5ebf1', padding: '10px 0', fontSize: 12 }
