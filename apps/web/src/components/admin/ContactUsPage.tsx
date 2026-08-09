'use client'

import { AlertTriangle, CalendarDays, Filter, LockKeyhole, MoreVertical, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type Message = { id: string; authorType: 'customer_reply' | 'staff_reply' | 'internal_note' | 'system_event'; body: string; redacted: boolean; createdAt: string }
type Case = { id: string; subject: string; category: string; status: string; priority: string; assignedAdminId: string | null; slaDueAt: string | null; version: number; createdAt: string; requester: { id: string; name: string | null; email: string; plan: string; location: string | null; jobsCount: number; resumeExists: boolean; gmail: { connected: boolean; lastSyncedAt: string | null; hasError: boolean } }; messages: Message[] }
type AdminMember = { id: string; user: { name: string | null; email: string } }
type Macro = { id: string; name: string; category: string | null; body: string }
type SupportFilters = { status: string; priority: string; assigned: string; category: string; sla: string }

function relativeSla(value: string | null) {
  if (!value) return 'No SLA'
  const hours = Math.ceil((new Date(value).getTime() - Date.now()) / 3_600_000)
  return hours < 0 ? `${Math.abs(hours)}h overdue` : `${hours}h left`
}

export function ContactUsPage({ actorId, permissions }: { actorId: string; permissions: readonly string[] }) {
  const [cases, setCases] = useState<Case[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState<SupportFilters>({ status: '', priority: '', assigned: '', category: '', sla: '' })
  const [members, setMembers] = useState<AdminMember[]>([])
  const [macros, setMacros] = useState<Macro[]>([])
  const [escalationOpen, setEscalationOpen] = useState(false)
  const [escalationService, setEscalationService] = useState('support')
  const [escalationReason, setEscalationReason] = useState('')
  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? cases[0], [cases, selectedId])

  async function loadCases() {
    setLoading(true)
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)))
    const response = await fetch(`/api/admin/v1/support/cases${params.toString() ? `?${params}` : ''}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { cases?: Case[]; error?: string } | null
    if (!response.ok) setError(payload?.error ?? 'Unable to load customer support cases.')
    else { setCases(payload?.cases ?? []); setSelectedId((current) => current ?? payload?.cases?.[0]?.id ?? null) }
    setLoading(false)
  }

  useEffect(() => { void loadCases() }, [filters])
  useEffect(() => {
    if (!permissions.includes('support_cases.assign')) return
    void fetch('/api/admin/v1/access/members?limit=100', { cache: 'no-store' }).then(response => response.json()).then(payload => setMembers(payload.items ?? [])).catch(() => undefined)
  }, [permissions])
  useEffect(() => {
    if (!permissions.includes('support_cases.read')) return
    void fetch('/api/admin/v1/support/macros', { cache: 'no-store' }).then(response => response.json()).then(payload => setMacros(payload.macros ?? [])).catch(() => undefined)
  }, [permissions])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const next = { status: params.get('status') ?? '', priority: params.get('priority') ?? '', assigned: params.get('assigned') ?? '', category: params.get('category') ?? '', sla: params.get('sla') ?? '' }
    setFilters(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
  }, [])
  function setFilter(key: keyof SupportFilters, value: string) {
    setFilters(current => {
      const next = { ...current, [key]: value }
      const params = new URLSearchParams(window.location.search)
      Object.entries(next).forEach(([name, item]) => item ? params.set(name, item) : params.delete(name))
      window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`)
      return next
    })
  }

  async function sendMessage() {
    if (!selected || !body.trim()) return
    setSending(true)
    const endpoint = `/api/admin/v1/support/cases/${selected.id}/${mode === 'reply' ? 'reply' : 'notes'}`
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ body, reason: mode === 'reply' ? 'Responding to customer support case' : 'Recording support case investigation note' }) })
    if (!response.ok) setError('Unable to save this message.')
    else { setBody(''); await loadCases() }
    setSending(false)
  }

  async function updateCase(changes: Partial<Pick<Case, 'status' | 'priority' | 'assignedAdminId'>>, reason: string) {
    if (!selected) return
    setSending(true)
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ ...changes, version: selected.version, reason }),
    })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setError(payload?.error ?? 'Unable to update this support case.')
    else await loadCases()
    setSending(false)
  }

  async function escalate() {
    if (!selected || escalationReason.trim().length < 10) return
    setSending(true)
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}/escalate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ service: escalationService, reason: escalationReason.trim() }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setError(payload?.error ?? 'Unable to escalate this case.')
    else { setError('Case escalated to an incident.'); setEscalationOpen(false); setEscalationReason(''); await loadCases() }
    setSending(false)
  }

  const canAssign = permissions.includes('support_cases.assign')
  const canResolve = permissions.includes('support_cases.resolve')
  const canReply = permissions.includes('support_cases.reply')
  const canNote = permissions.includes('support_cases.note')
  const canSend = mode === 'reply' ? canReply : canNote
  const canEscalate = permissions.includes('support_cases.escalate')

  return <div className="admin-page">
    <header className="admin-header"><div><h1>Contact us</h1><p>Customer support inbox</p></div><div className="admin-header-time"><CalendarDays size={18} /> Secure support workspace</div></header>
    <div className="admin-privacy"><ShieldCheck size={30} /><span><strong>Privacy first:</strong> Support staff cannot access API keys, full resumes, or email bodies. Only the minimum operational information is shown.</span></div>
    {error && <div className="admin-alert">{error}</div>}
    <div className="support-workspace">
      <section className="support-queue" aria-label="Conversation queue"><div className="support-panel-title"><h2>Conversation queue</h2><button title="Filter cases" onClick={() => setFilterOpen(current => !current)}><Filter size={17} /> Filter</button></div>{filterOpen && <div className="support-filter-panel"><label>Status<select value={filters.status} onChange={event => setFilter('status', event.target.value)}><option value="">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting_on_customer">Waiting on customer</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label><label>Priority<select value={filters.priority} onChange={event => setFilter('priority', event.target.value)}><option value="">All priorities</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Assignment<select value={filters.assigned} onChange={event => setFilter('assigned', event.target.value)}><option value="">Everyone</option><option value="unassigned">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.user.name ?? member.user.email}</option>)}</select></label><label>SLA<select value={filters.sla} onChange={event => setFilter('sla', event.target.value)}><option value="">All SLA states</option><option value="overdue">Overdue</option><option value="due_soon">Due soon</option></select></label></div>}<div className="support-sort">Filtered cases <span>{cases.length}</span></div>
        <div className="support-list">{loading ? <p>Loading cases...</p> : cases.length === 0 ? <p>No open support cases.</p> : cases.map((item) => <button key={item.id} className="support-case-row" data-active={selected?.id === item.id} onClick={() => setSelectedId(item.id)}><span className="support-initials">{(item.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{item.subject}</strong><small>{item.requester.name ?? 'Customer'}</small><em>{item.assignedAdminId ? 'Assigned' : 'Unassigned'}</em></span><time>{relativeSla(item.slaDueAt)}</time></button>)}</div>
      </section>
      <section className="support-thread">{selected ? <><div className="support-thread-top"><div><h2>{selected.subject}</h2><span>#{selected.id.slice(-6)} · {selected.category.replaceAll('_', ' ')}</span></div><button title="Escalate to incident" disabled={!canEscalate} onClick={() => setEscalationOpen(true)}><MoreVertical size={18} /></button></div><div className="support-controls"><label className="support-select">Status<select value={selected.status} disabled={sending || (!canAssign && !(canResolve && selected.status !== 'resolved'))} onChange={(event) => void updateCase({ status: event.target.value }, `Updating case status to ${event.target.value}`)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting_on_customer">Waiting on customer</option>{canResolve && <option value="resolved">Resolved</option>}<option value="closed">Closed</option></select></label><label className="support-select">Priority<select value={selected.priority} disabled={sending || !canAssign} onChange={(event) => void updateCase({ priority: event.target.value }, `Updating support priority to ${event.target.value}`)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>{canAssign && <label className="support-select">Owner<select value={selected.assignedAdminId ?? ''} disabled={sending} onChange={(event) => void updateCase({ assignedAdminId: event.target.value || null }, 'Updating support case owner')}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.user.name ?? member.user.email}</option>)}</select></label>}<span className="support-sla">SLA {relativeSla(selected.slaDueAt)}</span></div>
        <div className="support-messages" aria-live="polite">{selected.messages.map((message) => <article key={message.id} className={`support-message ${message.authorType}`}><span>{message.authorType === 'staff_reply' ? 'Support team' : message.authorType === 'internal_note' ? 'Internal note' : selected.requester.name ?? 'Customer'}</span><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></article>)}</div>
        <div className="support-composer"><div role="tablist"><button disabled={!canReply} data-active={mode === 'reply'} onClick={() => setMode('reply')}>Reply to customer</button><button disabled={!canNote} data-active={mode === 'note'} onClick={() => setMode('note')}>Internal note</button></div>{mode === 'reply' && macros.length > 0 && <label className="support-macro-select">Quick reply<select defaultValue="" onChange={(event) => { const macro = macros.find(item => item.id === event.target.value); if (macro) setBody(current => current ? `${current}\n\n${macro.body}` : macro.body) }}><option value="">Choose a template</option>{macros.map(macro => <option value={macro.id} key={macro.id}>{macro.category ? `${macro.category} · ` : ''}{macro.name}</option>)}</select></label>}<textarea disabled={!canSend} value={body} onChange={(event) => setBody(event.target.value)} placeholder={!canSend ? 'You do not have permission to write here.' : mode === 'reply' ? 'Write a customer-visible reply...' : 'Write an internal investigation note...'} maxLength={5000} /><div className="support-composer-footer"><span><LockKeyhole size={13} /> No private documents or email content is available.</span><button className="support-send" onClick={() => void sendMessage()} disabled={sending || !body.trim() || !canSend}>{sending ? 'Sending...' : mode === 'reply' ? 'Reply to customer' : 'Add internal note'} <Send size={15} /></button></div></div>
      </> : <div className="support-empty">Select a case to view its conversation.</div>}</section>
      <aside className="support-context">{selected ? <><h2>Safe context</h2><section><h3>Customer</h3><p className="support-person"><span className="support-initials">{(selected.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{selected.requester.name ?? 'Customer'}</strong><small>{selected.requester.email}</small></span></p><dl><dt>Plan</dt><dd>{selected.requester.plan}</dd><dt>Location</dt><dd>{selected.requester.location ?? 'Not provided'}</dd><dt>Active jobs</dt><dd>{selected.requester.jobsCount}</dd></dl></section><section><h3>Safe application summary</h3><dl><dt>Resume</dt><dd>{selected.requester.resumeExists ? 'On file' : 'Not uploaded'}</dd><dt>Gmail sync</dt><dd>{selected.requester.gmail.connected ? 'Connected' : 'Not connected'}</dd><dt>Sync status</dt><dd>{selected.requester.gmail.hasError ? 'Needs attention' : 'Healthy'}</dd></dl></section></> : null}</aside>
    </div>{escalationOpen && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); void escalate() }}><h2><AlertTriangle size={18} /> Escalate case</h2><p>Only the case ID, category, priority and safe reason will be copied to the incident.</p><label>Service<input value={escalationService} onChange={(event) => setEscalationService(event.target.value)} required maxLength={80} /></label><label>Reason<textarea value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} required minLength={10} maxLength={500} autoFocus /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setEscalationOpen(false)}>Cancel</button><button className="broadcast-primary" type="submit" disabled={sending || escalationReason.trim().length < 10}>Escalate</button></div></form></div>}
  </div>
}
