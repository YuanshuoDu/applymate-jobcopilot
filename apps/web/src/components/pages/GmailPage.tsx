'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MailCheck, RefreshCw, Sparkles } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { ApplicationUpdatesPanel } from '@/components/gmail/ApplicationUpdatesPanel'
import { RecommendedJobsPanel } from '@/components/gmail/RecommendedJobsPanel'
import type { GmailRecommendation, GmailTrackingResponse, LinkableJob, TrackedGmailMessage } from '@/components/gmail/types'
import { Btn, Card, useToast } from '@/components/ui'

type ConnectionState = 'loading' | 'no_google' | 'reauth' | 'ready' | 'error'
type GmailView = 'updates' | 'recommendations'

export function GmailPage() {
  const toast = useToast()
  const authTriggeredRef = useRef(false)
  const [connection, setConnection] = useState<ConnectionState>('loading')
  const [view, setView] = useState<GmailView>('updates')
  const [messages, setMessages] = useState<TrackedGmailMessage[]>([])
  const [recommendations, setRecommendations] = useState<GmailRecommendation[]>([])
  const [jobs, setJobs] = useState<LinkableJob[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const loadTracking = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!silent) setConnection('loading')
    else setRefreshing(true)
    try {
      const response = await fetch('/api/gmail/tracking', { signal })
      const body = await response.json() as GmailTrackingResponse & { error?: string }
      if (!response.ok) {
        setConnection(body.error === 'NO_GOOGLE_ACCOUNT' ? 'no_google' : body.error === 'GMAIL_REAUTH' ? 'reauth' : 'error')
        return
      }
      const jobsResponse = await fetch('/api/jobs?pageSize=100', { signal })
      const jobsBody = await jobsResponse.json() as { jobs?: LinkableJob[] }
      setMessages(body.messages ?? [])
      setRecommendations(body.recommendations ?? [])
      setJobs(jobsBody.jobs ?? [])
      setConnection('ready')
      if (silent) {
        const added = body.sync?.newRecommendations ?? 0
        toast.success('Gmail is up to date', added ? `${added} new recommendation${added === 1 ? '' : 's'} ready to review.` : 'No new job updates.')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setConnection('error')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    void loadTracking(false, controller.signal)
    return () => controller.abort()
  }, [loadTracking])

  function connectGoogle() {
    if (authTriggeredRef.current) return
    authTriggeredRef.current = true
    window.location.href = '/api/gmail/oauth/start?transfer=1'
  }

  if (connection !== 'ready') return <GmailConnectionState state={connection} onConnect={connectGoogle} onRetry={() => { authTriggeredRef.current = false; void loadTracking() }} />

  const pending = recommendations.filter((item) => item.status === 'pending').length
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <TopBar title="Gmail job tracker">
      {pending > 0 && <span style={{ fontSize: 11, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '3px 8px', fontWeight: 700 }}>{pending} jobs to review</span>}
      <Btn small variant="ghost" disabled={refreshing} onClick={() => void loadTracking(true)}><RefreshCw size={14} /> {refreshing ? 'Syncing…' : 'Sync Gmail'}</Btn>
    </TopBar>
    <main style={{ flex: 1, overflowY: 'auto', padding: '24px clamp(18px, 3vw, 36px)', background: 'var(--bg-tertiary)' }}>
      <section style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', marginBottom: 22 }}>
          <TabButton active={view === 'updates'} onClick={() => setView('updates')} label="Application updates" />
          <TabButton active={view === 'recommendations'} onClick={() => setView('recommendations')} label={`Recommended jobs${pending ? ` · ${pending}` : ''}`} />
        </div>
        {view === 'updates'
          ? <ApplicationUpdatesPanel messages={messages} jobs={jobs} onChanged={() => void loadTracking(true)} />
          : <RecommendedJobsPanel recommendations={recommendations} onChanged={() => void loadTracking(true)} />}
      </section>
    </main>
  </div>
}

function GmailConnectionState({ state, onConnect, onRetry }: { state: ConnectionState; onConnect: () => void; onRetry: () => void }) {
  const loading = state === 'loading'
  const needsConnection = state === 'no_google' || state === 'reauth'
  const title = state === 'no_google' ? 'Connect Gmail to track applications' : state === 'reauth' ? 'Gmail access needs to be renewed' : 'Could not load Gmail tracking'
  const body = state === 'no_google'
    ? 'ApplyMate reads job-related email evidence only. It never sends or changes your inbox without your confirmation.'
    : state === 'reauth' ? 'Reconnect the Gmail account that receives your application updates and job-platform recommendations.' : 'Try again, or reconnect Gmail if the problem continues.'
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
    <TopBar title="Gmail job tracker" />
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg-tertiary)' }}>
      <Card style={{ width: '100%', maxWidth: 440, padding: 34, textAlign: 'center' }}>
        <span style={{ margin: '0 auto 16px', width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(79,70,229,0.10)', color: 'var(--primary)' }}>{loading ? <RefreshCw size={22} className="gmail-spin" /> : <MailCheck size={22} />}</span>
        <h1 style={{ margin: 0, fontSize: 17 }}>{loading ? 'Checking Gmail…' : title}</h1>
        {!loading && <p style={{ margin: '9px 0 22px', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>{body}</p>}
        {!loading && (needsConnection ? <Btn variant="primary" onClick={onConnect}><Sparkles size={15} /> Connect Gmail</Btn> : <Btn variant="primary" onClick={onRetry}>Try again</Btn>)}
      </Card>
    </div>
  </div>
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{ border: 'none', borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent', background: 'transparent', padding: '8px 3px', color: active ? 'var(--primary)' : 'var(--text-muted)', fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer' }}>{label}</button>
}
