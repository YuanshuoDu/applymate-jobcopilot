'use client'

import { AlertTriangle, CalendarDays, Filter, LockKeyhole, MoreVertical, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Message = { id: string; authorType: 'customer_reply' | 'staff_reply' | 'internal_note' | 'system_event'; body: string; redacted: boolean; createdAt: string }
type Case = { id: string; subject: string; category: string; status: string; priority: string; assignedAdminId: string | null; slaDueAt: string | null; version: number; createdAt: string; requester: { id: string; name: string | null; email: string; plan: string; location: string | null; jobsCount: number; resumeExists: boolean; gmail: { connected: boolean; lastSyncedAt: string | null; hasError: boolean } }; messages: Message[] }
type AdminMember = { id: string; user: { name: string | null; email: string } }
type Macro = { id: string; name: string; category: string | null; body: string }
type SupportFilters = { status: string; priority: string; assigned: string; category: string; sla: string }

function relativeSla(value: string | null, t?: (key: string) => string) {
  if (!value) return t?.('support.noSla') ?? 'No SLA'
  const hours = Math.ceil((new Date(value).getTime() - Date.now()) / 3_600_000)
  return hours < 0 ? `${Math.abs(hours)}h ${t?.('support.overdue') ?? 'overdue'}` : `${hours}h ${t?.('support.hoursLeft') ?? 'left'}`
}

export function slaLabel(value: Date, now = new Date(), t?: (key: string) => string): string {
  return value.getTime() < now.getTime() ? t?.('support.overdueCapital') ?? 'Overdue' : t?.('support.withinSla') ?? 'Within SLA'
}

export function supportMessageLabel(kind: Message['authorType'], t?: (key: string) => string): string {
  return kind === 'internal_note' ? t?.('support.internalNote') ?? 'Internal note' : kind === 'staff_reply' ? t?.('support.replyCustomer') ?? 'Reply to customer' : t?.('support.customerMessage') ?? 'Customer message'
}

export function ContactUsPage({ actorId, permissions }: { actorId: string; permissions: readonly string[] }) {
  const { t } = useI18n()
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

  const loadCases = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)))
      const response = await fetch(`/api/admin/v1/support/cases${params.toString() ? `?${params}` : ''}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { cases?: Case[]; error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? t('support.loadFailed'))
      const nextCases = payload?.cases ?? []
      setCases(nextCases)
      setSelectedId((current) => {
        const requested = new URLSearchParams(window.location.search).get('case')
        if (requested && nextCases.some(item => item.id === requested)) return requested
        if (current && nextCases.some(item => item.id === current)) return current
        return nextCases[0]?.id ?? null
      })
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : t('support.loadFailed')) } finally { setLoading(false) }
  }, [filters, t])

  useEffect(() => { void loadCases() }, [loadCases])
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

  function selectCase(id: string) {
    setSelectedId(id)
    const url = new URL(window.location.href)
    url.searchParams.set('case', id)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    setError('')
  }

  async function sendMessage() {
    if (!selected || !body.trim()) return
    setSending(true)
    const endpoint = `/api/admin/v1/support/cases/${selected.id}/${mode === 'reply' ? 'reply' : 'notes'}`
    const response = await fetch(endpoint, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ body, reason: mode === 'reply' ? 'Responding to customer support case' : 'Recording support case investigation note' }) })
    if (!response.ok) setError(t('support.saveMessageFailed'))
    else { setBody(''); await loadCases() }
    setSending(false)
  }

  async function updateCase(changes: Partial<Pick<Case, 'status' | 'priority' | 'assignedAdminId'>>, reason: string) {
    if (!selected) return
    setSending(true)
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}`, {
      method: 'PATCH',
      headers: adminMutationHeaders(),
      body: JSON.stringify({ ...changes, version: selected.version, reason }),
    })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setError(payload?.error ?? t('support.updateFailed'))
    else await loadCases()
    setSending(false)
  }

  async function escalate() {
    if (!selected || escalationReason.trim().length < 10) return
    setSending(true)
    const response = await fetch(`/api/admin/v1/support/cases/${selected.id}/escalate`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ service: escalationService, reason: escalationReason.trim() }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setError(payload?.error ?? t('support.escalateFailed'))
    else { setError(t('support.escalated')); setEscalationOpen(false); setEscalationReason(''); await loadCases() }
    setSending(false)
  }

  const canAssign = permissions.includes('support_cases.assign')
  const canResolve = permissions.includes('support_cases.resolve')
  const canReply = permissions.includes('support_cases.reply')
  const canNote = permissions.includes('support_cases.note')
  const canSend = mode === 'reply' ? canReply : canNote
  const canEscalate = permissions.includes('support_cases.escalate')

  return <div className="admin-page">
    <header className="admin-header"><div><h1>{t('support.title')}</h1><p>{t('support.description')}</p></div><div className="support-header-actions"><button className="admin-secondary" type="button" onClick={() => void loadCases()} disabled={loading}><RefreshCw size={15} /> {t('common.refresh')}</button><CalendarDays size={18} /> {t('support.workspace')}</div></header>
    <div className="admin-privacy"><ShieldCheck size={30} /><span><strong>{t('support.privacyFirst')}</strong> {t('support.privacyDescription')}</span></div>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <div className="support-workspace">
      <section className="support-queue" aria-label={t('support.conversationQueue')}><div className="support-panel-title"><h2>{t('support.conversationQueue')}</h2><button type="button" title={t('support.filterCases')} onClick={() => setFilterOpen(current => !current)}><Filter size={17} /> {t('support.filter')}</button></div>{filterOpen && <div className="support-filter-panel"><label>{t('support.status')}<select value={filters.status} onChange={event => setFilter('status', event.target.value)}><option value="">{t('support.allStatuses')}</option><option value="open">{t('support.open')}</option><option value="in_progress">{t('support.inProgress')}</option><option value="waiting_on_customer">{t('support.waitingCustomer')}</option><option value="resolved">{t('support.resolved')}</option><option value="closed">{t('support.closed')}</option></select></label><label>{t('support.priority')}<select value={filters.priority} onChange={event => setFilter('priority', event.target.value)}><option value="">{t('support.allPriorities')}</option><option value="low">{t('support.low')}</option><option value="normal">{t('support.normal')}</option><option value="high">{t('support.high')}</option><option value="urgent">{t('support.urgent')}</option></select></label><label>{t('support.category')}<select value={filters.category} onChange={event => setFilter('category', event.target.value)}><option value="">{t('support.allCategories')}</option><option value="account">{t('contact.category.account')}</option><option value="billing">{t('contact.category.billing')}</option><option value="technical">{t('contact.category.technical')}</option><option value="auto_apply">{t('contact.category.auto_apply')}</option><option value="feedback">{t('contact.category.feedback')}</option><option value="other">{t('contact.category.other')}</option></select></label><label>{t('support.assignment')}<select value={filters.assigned} onChange={event => setFilter('assigned', event.target.value)}><option value="">{t('support.everyone')}</option><option value="unassigned">{t('support.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.user.name ?? member.user.email}</option>)}</select></label><label>{t('support.sla')}<select value={filters.sla} onChange={event => setFilter('sla', event.target.value)}><option value="">{t('support.allSla')}</option><option value="overdue">{t('support.overdueCapital')}</option><option value="due_soon">{t('support.dueSoon')}</option></select></label></div>}<div className="support-sort">{t('support.filteredCases')} <span>{cases.length}</span></div>
        <div className="support-list">{loading ? <p>{t('support.loadingCases')}</p> : cases.length === 0 ? <p>{t('support.noOpenCases')}</p> : cases.map((item) => <button type="button" key={item.id} className="support-case-row" data-active={selected?.id === item.id} onClick={() => selectCase(item.id)}><span className="support-initials">{(item.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{item.subject}</strong><small>{item.requester.name ?? t('support.customer')}</small><em>{item.assignedAdminId ? t('support.assigned') : t('support.unassigned')}</em></span><time>{relativeSla(item.slaDueAt, t)}</time></button>)}</div>
      </section>
      <section className="support-thread">{selected ? <><div className="support-thread-top"><div><h2>{selected.subject}</h2><span>#{selected.id.slice(-6)} · {selected.category.replaceAll('_', ' ')}</span></div><button title={t('support.escalate')} disabled={!canEscalate} onClick={() => setEscalationOpen(true)}><MoreVertical size={18} /></button></div><div className="support-controls"><label className="support-select">{t('support.status')}<select value={selected.status} disabled={sending || (!canAssign && !(canResolve && selected.status !== 'resolved'))} onChange={(event) => void updateCase({ status: event.target.value }, `${t('support.updatingStatus')} ${event.target.value}`)}><option value="open">{t('support.open')}</option><option value="in_progress">{t('support.inProgress')}</option><option value="waiting_on_customer">{t('support.waitingCustomer')}</option>{canResolve && <option value="resolved">{t('support.resolved')}</option>}<option value="closed">{t('support.closed')}</option></select></label><label className="support-select">{t('support.priority')}<select value={selected.priority} disabled={sending || !canAssign} onChange={(event) => void updateCase({ priority: event.target.value }, `${t('support.updatingPriority')} ${event.target.value}`)}><option value="low">{t('support.low')}</option><option value="normal">{t('support.normal')}</option><option value="high">{t('support.high')}</option><option value="urgent">{t('support.urgent')}</option></select></label>{canAssign && <label className="support-select">{t('support.owner')}<select value={selected.assignedAdminId ?? ''} disabled={sending} onChange={(event) => void updateCase({ assignedAdminId: event.target.value || null }, t('support.updatingOwner'))}><option value="">{t('support.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.user.name ?? member.user.email}</option>)}</select></label>}<span className="support-sla">SLA {relativeSla(selected.slaDueAt, t)}</span></div>
        <div className="support-messages" aria-live="polite">{selected.messages.map((message) => <article key={message.id} className={`support-message ${message.authorType}`}><span>{message.authorType === 'staff_reply' ? t('support.team') : message.authorType === 'internal_note' ? t('support.internalNote') : selected.requester.name ?? t('support.customer')}</span><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></article>)}</div>
        <div className="support-composer"><div role="tablist"><button disabled={!canReply} data-active={mode === 'reply'} onClick={() => setMode('reply')}>{t('support.replyCustomer')}</button><button disabled={!canNote} data-active={mode === 'note'} onClick={() => setMode('note')}>{t('support.internalNote')}</button></div>{mode === 'reply' && macros.length > 0 && <label className="support-macro-select">{t('support.quickReply')}<select defaultValue="" onChange={(event) => { const macro = macros.find(item => item.id === event.target.value); if (macro) setBody(current => current ? `${current}\n\n${macro.body}` : macro.body) }}><option value="">{t('support.chooseTemplate')}</option>{macros.map(macro => <option value={macro.id} key={macro.id}>{macro.category ? `${macro.category} · ` : ''}{macro.name}</option>)}</select></label>}<textarea disabled={!canSend} value={body} onChange={(event) => setBody(event.target.value)} placeholder={!canSend ? t('support.noWritePermission') : mode === 'reply' ? t('support.replyPlaceholder') : t('support.notePlaceholder')} maxLength={5000} /><div className="support-composer-footer"><span><LockKeyhole size={13} /> {t('support.noPrivateContent')}</span><button className="support-send" onClick={() => void sendMessage()} disabled={sending || !body.trim() || !canSend}>{sending ? t('support.sending') : mode === 'reply' ? t('support.replyCustomer') : t('support.addNote')} <Send size={15} /></button></div></div>
      </> : <div className="support-empty">{t('support.selectCase')}</div>}</section>
      <aside className="support-context">{selected ? <><h2>{t('support.safeContext')}</h2><section><h3>{t('support.customer')}</h3><p className="support-person"><span className="support-initials">{(selected.requester.name ?? 'C').slice(0, 2).toUpperCase()}</span><span><strong>{selected.requester.name ?? t('support.customer')}</strong><small>{selected.requester.email}</small></span></p><dl><dt>{t('admin.plan')}</dt><dd>{selected.requester.plan}</dd><dt>{t('support.location')}</dt><dd>{selected.requester.location ?? t('support.notProvided')}</dd><dt>{t('support.activeJobs')}</dt><dd>{selected.requester.jobsCount}</dd></dl></section><section><h3>{t('support.safeSummary')}</h3><dl><dt>{t('support.resume')}</dt><dd>{selected.requester.resumeExists ? t('support.onFile') : t('support.notUploaded')}</dd><dt>{t('support.gmailSync')}</dt><dd>{selected.requester.gmail.connected ? t('adminUsers.connected') : t('adminUsers.notConnected')}</dd><dt>{t('support.syncStatus')}</dt><dd>{selected.requester.gmail.hasError ? t('support.needsAttention') : t('support.healthy')}</dd></dl></section></> : null}</aside>
    </div>{escalationOpen && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); void escalate() }}><h2><AlertTriangle size={18} /> {t('support.escalate')}</h2><p>{t('support.escalateDescription')}</p><label>{t('support.service')}<input value={escalationService} onChange={(event) => setEscalationService(event.target.value)} required maxLength={80} /></label><label>{t('support.reason')}<textarea value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} required minLength={10} maxLength={500} autoFocus /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setEscalationOpen(false)}>{t('common.cancel')}</button><button className="broadcast-primary" type="submit" disabled={sending || escalationReason.trim().length < 10}>{t('support.escalate')}</button></div></form></div>}
  </div>
}
