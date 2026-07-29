'use client'

import { useMemo, useState } from 'react'
import { BriefcaseBusiness, MapPin, Send, X } from 'lucide-react'
import { Btn, Card, useToast } from '@/components/ui'
import type { GmailRecommendation } from './types'

type RecommendationFilter = 'pending' | 'saved' | 'dismissed'

interface Props {
  recommendations: GmailRecommendation[]
  onChanged: () => void
}

export function RecommendedJobsPanel({ recommendations, onChanged }: Props) {
  const toast = useToast()
  const [filter, setFilter] = useState<RecommendationFilter>('pending')
  const [busyId, setBusyId] = useState<string | null>(null)
  const visible = useMemo(() => recommendations.filter((item) => item.status === filter), [recommendations, filter])
  const counts = useMemo(() => ({
    pending: recommendations.filter((item) => item.status === 'pending').length,
    saved: recommendations.filter((item) => item.status === 'saved').length,
    dismissed: recommendations.filter((item) => item.status === 'dismissed').length,
  }), [recommendations])

  async function act(id: string, action: 'save' | 'dismiss') {
    setBusyId(id)
    try {
      const response = await fetch(`/api/gmail/recommendations/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not update recommendation')
      if (action === 'save') {
        toast.success('Saved to My Jobs', 'You can score or apply when you are ready.')
        window.dispatchEvent(new Event('applymate:jobs-changed'))
      } else toast.info('Recommendation dismissed')
      onChanged()
    } catch (error) {
      toast.error('Could not update recommendation', error instanceof Error ? error.message : 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  return <section aria-label="Recommended jobs">
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      <div><h2 style={{ margin: 0, fontSize: 16 }}>Recommended jobs</h2><p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Roles found in job-platform emails. Save only the ones you want to track.</p></div>
      {counts.pending > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'rgba(79,70,229,0.10)', padding: '4px 8px', borderRadius: 999 }}>{counts.pending} to review</span>}
    </div>
    <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
      {(['pending', 'saved', 'dismissed'] as RecommendationFilter[]).map((item) => <button type="button" key={item} onClick={() => setFilter(item)} style={filterStyle(filter === item)}>{labelFor(item)} · {counts[item]}</button>)}
    </div>
    {visible.length === 0 ? <Card style={{ padding: 28, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>{filter === 'pending' ? 'No new recommendations yet. Daily job alerts will appear here after Gmail syncs.' : `No ${labelFor(filter).toLowerCase()} recommendations.`}</Card> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(245px, 1fr))', gap: 12 }}>
      {visible.map((item) => <RecommendationCard key={item.id} item={item} busy={busyId === item.id} onAction={act} />)}
    </div>}
  </section>
}

function RecommendationCard({ item, busy, onAction }: { item: GmailRecommendation; busy: boolean; onAction: (id: string, action: 'save' | 'dismiss') => void }) {
  const canSave = Boolean(item.company && item.role)
  return <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', minHeight: 215 }}>
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}><span style={iconStyle}><BriefcaseBusiness size={16} /></span><div style={{ minWidth: 0, flex: 1 }}><strong style={{ display: 'block', fontSize: 13, lineHeight: 1.35 }}>{item.role || 'Role details needed'}</strong><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.company || 'Company details needed'}</span></div></div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
      {item.location && <span style={detailStyle}><MapPin size={12} />{item.location}</span>}
      {item.platform && <span style={detailStyle}>{item.platform}</span>}
      {item.salary && <span style={detailStyle}>{item.salary}</span>}
    </div>
    {item.description && <p style={{ margin: '11px 0 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>{item.description}</p>}
    <div style={{ marginTop: 'auto', paddingTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {item.url && <a href={item.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>View role ↗</a>}
      {item.status === 'pending' && <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}><Btn small variant="ghost" disabled={busy} onClick={() => onAction(item.id, 'dismiss')}><X size={13} /> Dismiss</Btn><Btn small variant="primary" disabled={busy || !canSave} onClick={() => onAction(item.id, 'save')}><Send size={13} /> {busy ? 'Saving…' : 'Save'}</Btn></div>}
      {item.status === 'saved' && <span style={{ marginLeft: 'auto', color: '#059669', fontSize: 11, fontWeight: 700 }}>Saved to My Jobs</span>}
      {item.status === 'dismissed' && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>Dismissed</span>}
    </div>
    {item.status === 'pending' && !canSave && <p style={{ margin: '8px 0 0', color: '#A16207', fontSize: 10 }}>This email did not include enough job detail to save automatically.</p>}
  </Card>
}

function labelFor(value: RecommendationFilter) { return value === 'pending' ? 'To review' : value === 'saved' ? 'Saved' : 'Dismissed' }
function filterStyle(active: boolean) { return { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 9px', cursor: 'pointer', fontSize: 11, background: active ? 'rgba(79,70,229,0.12)' : 'var(--bg)', color: active ? 'var(--primary)' : 'var(--text-muted)', fontWeight: active ? 700 : 500 } }
const iconStyle = { width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 9, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', flexShrink: 0 }
const detailStyle = { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 6px', borderRadius: 999, background: 'var(--bg-secondary)' }
