'use client'

import { CalendarDays, Filter, LockKeyhole, MoreVertical, Send, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type Message = { id: string; authorType: 'customer_reply' | 'staff_reply' | 'internal_note' | 'system_event'; body: string; redacted: boolean; createdAt: string }
type Case = { id: string; subject: string; category: string; status: string; priority: string; assignedAdminId: string | null; slaDueAt: string | null; version: number; createdAt: string; requester: { id: string; name: string | null; email: string; plan: string; location: string | null; jobsCount: number; resumeExists: boolean; gmail: { connected: boolean; lastSyncedAt: string | null; hasError: boolean } }; messages: Message[] }

function relativeSla(value: string | null) {
  if (!value) return 'No SLA'
  const hours = Math.ceil((new Date(value).getTime() - Date.now()) / 3_600_000)
  return hours < 0 ? `${Math.abs(hours)}h overdue` : `${hours}h left`
}

export function slaLabel(value: Date, now = new Date()): string {
  return value.getTime() < now.getTime() ? 'Overdue' : 'Within SLA'
}

export function supportMessageLabel(kind: Message['authorType']): string {
  return kind === 'internal_note' ? 'Internal note' : kind === 'staff_reply' ? 'Reply to customer' : 'Customer message'
}

export function ContactUsPage({ actorId, permissions }: { actorId: string; permissions: readonly string[] }) {
  const [cases, setCases] = useState<Case[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? cases[0], [cases, selectedId])

  async function loadCases() {
    setLoading(true)
    const response = await fetch('/api/admin/v1/support/cases', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { cases?: Case[]; error?: string } | null
    if (!response.ok) setError(payload?.error ?? 'Unable to load customer support cases.')
    else { setCases(payload?.cases ?? []); setSelectedId((current) => current ?? payload?.cases?.[0]?.id ?? null) }
    setLoading(false)
  }

  useEffect(() => { void loadCases() }, [])

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

  const canAssign = permissions.includes('support_cases.assign')
  const canResolve = permissions.includes('support_cases.resolve')

  return <div className="admin-page">
    <header className="admin-header"><div><h1>Contact us</h1><p>Customer support inbox</p></div><div className="admin-header-time"><CalendarDays size={18} /> Secure support workspace</div></header>
    <div className="admin-privacy"><ShieldCheck size={30} /><span><strong>Privacy first:</strong> Support staff cannot access API keys, full resumes, or email bodies. Only the minimum operational information is shown.</span></div>
    {error && <div className="admin-alert">{error}</div>}
    <div className="support-workspace">
      <section className="support-queue" aria-label="Conversation queue"><div className="support-panel-title"><h2>Conversation queue</h2><button title="Filter cases"><Filter size={17} /> Filter</button></div><div className="support-sort">Open cases <span>{cases.length}</span></div>
        <div className="support-list">{loading ? <p>Loading cases...</p> : cases.length === 0 ? <p>No open support cases.</p> : cases.map((item) => <button key={item.id} className="support-case-row" data-active={selected?.id === item.id} onClick={() => setSelectedId(item.id)}><span className="support-initials">{(item.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{item.subject}</strong><small>{item.requester.name ?? 'Customer'}</small><em>{item.assignedAdminId ? 'Assigned' : 'Unassigned'}</em></span><time>{relativeSla(item.slaDueAt)}</time></button>)}</div>
      </section>
      <section className="support-thread">{selected ? <><div className="support-thread-top"><div><h2>{selected.subject}</h2><span>#{selected.id.slice(-6)} · {selected.category.replaceAll('_', ' ')}</span></div><button title="More case actions"><MoreVertical size={18} /></button></div><div className="support-controls"><label className="support-select">Status<select value={selected.status} disabled={sending || (!canAssign && !(canResolve && selected.status !== 'resolved'))} onChange={(event) => void updateCase({ status: event.target.value }, `Updating case status to ${event.target.value}`)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting_on_customer">Waiting on customer</option>{canResolve && <option value="resolved">Resolved</option>}<option value="closed">Closed</option></select></label><label className="support-select">Priority<select value={selected.priority} disabled={sending || !canAssign} onChange={(event) => void updateCase({ priority: event.target.value }, `Updating support priority to ${event.target.value}`)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>{canAssign && <button disabled={sending} onClick={() => void updateCase({ assignedAdminId: selected.assignedAdminId === actorId ? null : actorId }, selected.assignedAdminId === actorId ? 'Releasing support case assignment' : 'Assigning support case to myself')}><UserRound size={14} /> {selected.assignedAdminId === actorId ? 'Unassign me' : 'Assign to me'}</button>}<span className="support-sla">SLA {relativeSla(selected.slaDueAt)}</span></div>
        <div className="support-messages" aria-live="polite">{selected.messages.map((message) => <article key={message.id} className={`support-message ${message.authorType}`}><span>{message.authorType === 'staff_reply' ? 'Support team' : message.authorType === 'internal_note' ? 'Internal note' : selected.requester.name ?? 'Customer'}</span><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></article>)}</div>
        <div className="support-composer"><div role="tablist"><button data-active={mode === 'reply'} onClick={() => setMode('reply')}>Reply to customer</button><button data-active={mode === 'note'} onClick={() => setMode('note')}>Internal note</button></div><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={mode === 'reply' ? 'Write a customer-visible reply...' : 'Write an internal investigation note...'} maxLength={5000} /><div className="support-composer-footer"><span><LockKeyhole size={13} /> No private documents or email content is available.</span><button className="support-send" onClick={() => void sendMessage()} disabled={sending || !body.trim()}>{sending ? 'Sending...' : mode === 'reply' ? 'Reply to customer' : 'Add internal note'} <Send size={15} /></button></div></div>
      </> : <div className="support-empty">Select a case to view its conversation.</div>}</section>
      <aside className="support-context">{selected ? <><h2>Safe context</h2><section><h3>Customer</h3><p className="support-person"><span className="support-initials">{(selected.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{selected.requester.name ?? 'Customer'}</strong><small>{selected.requester.email}</small></span></p><dl><dt>Plan</dt><dd>{selected.requester.plan}</dd><dt>Location</dt><dd>{selected.requester.location ?? 'Not provided'}</dd><dt>Active jobs</dt><dd>{selected.requester.jobsCount}</dd></dl></section><section><h3>Safe application summary</h3><dl><dt>Resume</dt><dd>{selected.requester.resumeExists ? 'On file' : 'Not uploaded'}</dd><dt>Gmail sync</dt><dd>{selected.requester.gmail.connected ? 'Connected' : 'Not connected'}</dd><dt>Sync status</dt><dd>{selected.requester.gmail.hasError ? 'Needs attention' : 'Healthy'}</dd></dl></section></> : null}</aside>
    </div>
  </div>
}
