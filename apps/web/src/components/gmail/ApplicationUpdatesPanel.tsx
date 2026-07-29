'use client'

import { useMemo, useState } from 'react'
import { CalendarCheck2, CircleX, FileCheck2, Info, MailOpen, PartyPopper } from 'lucide-react'
import { Btn, Card, StatusBadge, useToast } from '@/components/ui'
import type { GmailMessageKind, LinkableJob, TrackedGmailMessage } from './types'

type UpdateFilter = 'all' | GmailMessageKind | 'needs_matching'

const FILTERS: Array<{ key: UpdateFilter; label: string }> = [
  { key: 'all', label: 'All updates' },
  { key: 'application_received', label: 'Applied' },
  { key: 'interview_invitation', label: 'Interviews' },
  { key: 'offer', label: 'Offers' },
  { key: 'rejection', label: 'Rejections' },
  { key: 'application_update', label: 'Employer updates' },
  { key: 'needs_matching', label: 'Needs matching' },
]

const KIND_CONFIG: Record<GmailMessageKind, { label: string; color: string; Icon: typeof FileCheck2 }> = {
  application_received: { label: 'Application received', color: '#4F46E5', Icon: FileCheck2 },
  interview_invitation: { label: 'Interview invitation', color: '#059669', Icon: CalendarCheck2 },
  offer: { label: 'Offer', color: '#0284C7', Icon: PartyPopper },
  rejection: { label: 'Rejection', color: '#DC2626', Icon: CircleX },
  application_update: { label: 'Employer update', color: '#A16207', Icon: Info },
  recommendation_digest: { label: 'Recommendations', color: '#4F46E5', Icon: MailOpen },
  other: { label: 'Other', color: '#64748B', Icon: MailOpen },
}

interface Props {
  messages: TrackedGmailMessage[]
  jobs: LinkableJob[]
  onChanged: () => void
}

export function ApplicationUpdatesPanel({ messages, jobs, onChanged }: Props) {
  const toast = useToast()
  const [filter, setFilter] = useState<UpdateFilter>('all')
  const [linkChoice, setLinkChoice] = useState<Record<string, string>>({})
  const [jobDetails, setJobDetails] = useState<Record<string, { company: string; role: string }>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const updates = useMemo(
    () => messages.filter((message) => message.kind !== 'recommendation_digest' && message.kind !== 'other'),
    [messages],
  )
  const visible = updates.filter((message) => (
    filter === 'all'
      || (filter === 'needs_matching' && !message.job)
      || message.kind === filter
  ))

  async function act(message: TrackedGmailMessage, action: 'link' | 'create_job') {
    setBusyId(message.id)
    const details = jobDetails[message.id]
    const body = action === 'link'
      ? { action, jobId: linkChoice[message.id] }
      : { action, company: details?.company ?? message.inferredCompany, role: details?.role ?? message.inferredRole }
    try {
      const response = await fetch(`/api/gmail/messages/${message.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not update the application')
      toast.success(action === 'link' ? 'Application linked' : 'Added to My Jobs')
      window.dispatchEvent(new Event('applymate:jobs-changed'))
      onChanged()
    } catch (error) {
      toast.error('Could not update application', error instanceof Error ? error.message : 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  return <section aria-label="Application updates" style={{ minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      <div><h2 style={{ margin: 0, fontSize: 16 }}>Application updates</h2><p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Only confirmed email evidence changes a job’s lifecycle.</p></div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{updates.length} tracked email{updates.length === 1 ? '' : 's'}</span>
    </div>
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 10, marginBottom: 4 }}>
      {FILTERS.map((item) => <button key={item.key} type="button" onClick={() => setFilter(item.key)} style={filterButtonStyle(filter === item.key)}>{item.label}</button>)}
    </div>
    {visible.length === 0 ? <EmptyState filter={filter} /> : <div style={{ display: 'grid', gap: 10 }}>
      {visible.map((message) => {
        const config = KIND_CONFIG[message.kind]
        const Icon = config.Icon
        const inferred = [message.inferredCompany, message.inferredRole].filter(Boolean).join(' · ')
        const isBusy = busyId === message.id
        return <Card key={message.id} style={{ padding: 16, borderColor: message.job ? 'var(--border)' : 'rgba(245,158,11,0.45)' }}>
          <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: `${config.color}18`, color: config.color, flexShrink: 0 }}><Icon size={16} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: config.color }}>{config.label}</span>
                <time style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDate(message.receivedAt)}</time>
              </div>
              <strong style={{ display: 'block', marginTop: 4, fontSize: 13, lineHeight: 1.35 }}>{message.subject}</strong>
              <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>{message.excerpt || message.senderName || message.senderEmail || 'No preview available'}</p>
              {message.job ? <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}><span style={{ fontSize: 12, fontWeight: 600 }}>{message.job.company} · {message.job.role}</span><StatusBadge status={message.job.status} /></div> : <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', fontSize: 12, color: '#92400E' }}><strong>Needs matching</strong>{inferred ? ` · ${inferred}` : ' · Add details before tracking this application.'}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
                <a href={`https://mail.google.com/mail/u/0/#all/${message.gmailThreadId ?? message.gmailMessageId}`} target="_blank" rel="noreferrer" style={linkStyle}>Open in Gmail ↗</a>
                {!message.job && <><input aria-label={`Company for ${message.subject}`} placeholder="Company" value={jobDetails[message.id]?.company ?? message.inferredCompany ?? ''} onChange={(event) => setJobDetails((previous) => ({ ...previous, [message.id]: { company: event.target.value, role: previous[message.id]?.role ?? message.inferredRole ?? '' } }))} style={textInputStyle} /><input aria-label={`Role for ${message.subject}`} placeholder="Role" value={jobDetails[message.id]?.role ?? message.inferredRole ?? ''} onChange={(event) => setJobDetails((previous) => ({ ...previous, [message.id]: { company: previous[message.id]?.company ?? message.inferredCompany ?? '', role: event.target.value } }))} style={textInputStyle} /><Btn small variant="primary" disabled={isBusy || !(jobDetails[message.id]?.company ?? message.inferredCompany) || !(jobDetails[message.id]?.role ?? message.inferredRole)} onClick={() => act(message, 'create_job')}>{isBusy ? 'Saving…' : 'Track as new job'}</Btn></>}
                {!message.job && jobs.length > 0 && <><select aria-label={`Link ${message.subject} to job`} value={linkChoice[message.id] ?? ''} onChange={(event) => setLinkChoice((previous) => ({ ...previous, [message.id]: event.target.value }))} style={selectStyle}><option value="">Link to existing job…</option>{jobs.map((job) => <option value={job.id} key={job.id}>{job.company} · {job.role}</option>)}</select><Btn small variant="ghost" disabled={isBusy || !linkChoice[message.id]} onClick={() => act(message, 'link')}>Link</Btn></>}
              </div>
            </div>
          </div>
        </Card>
      })}
    </div>}
  </section>
}

function EmptyState({ filter }: { filter: UpdateFilter }) {
  return <Card style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{filter === 'needs_matching' ? 'Every tracked application is linked to a My Jobs record.' : 'No application emails match this view yet.'}</Card>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function filterButtonStyle(active: boolean) {
  return { whiteSpace: 'nowrap' as const, border: '1px solid var(--border)', borderRadius: 999, padding: '5px 9px', cursor: 'pointer', fontSize: 11, background: active ? 'rgba(79,70,229,0.12)' : 'var(--bg)', color: active ? 'var(--primary)' : 'var(--text-muted)', fontWeight: active ? 700 : 500 }
}

const linkStyle = { fontSize: 11, color: 'var(--primary)', fontWeight: 600, textDecoration: 'none', padding: '5px 0' }
const selectStyle = { maxWidth: 230, minWidth: 170, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', padding: '5px 7px', fontSize: 11 }
const textInputStyle = { width: 128, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', padding: '5px 7px', fontSize: 11 }
