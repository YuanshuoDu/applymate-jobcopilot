'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, useToast } from '@/components/ui'
import { GmailConnectionScreen, type GmailConnectionState } from '@/components/gmail/GmailConnectionState'
import { GmailInboxList } from '@/components/gmail/GmailInboxList'
import { GmailInboxSidebar } from '@/components/gmail/GmailInboxSidebar'
import { GmailMessageReader } from '@/components/gmail/GmailMessageReader'
import { countInboxEmails, filterInboxEmails, type GmailEmail, type GmailInboxFilter } from '@/components/gmail/inbox-model'

interface GmailThreadsResponse {
  emails?: GmailEmail[]
  error?: string
}

const GMAIL_REAUTH_ERRORS = new Set(['GMAIL_REAUTH', 'GMAIL_SCOPE_MISSING', 'GMAIL_PERMISSION', 'TOKEN_EXPIRED'])
type InboxConnectionState = GmailConnectionState | 'ready'

/** The original Gmail inbox: filters, message list, and reading pane. */
export function GmailPage() {
  const { data: session } = useSession()
  const toast = useToast()
  const authTriggeredRef = useRef(false)
  const [connection, setConnection] = useState<InboxConnectionState>('loading')
  const [emails, setEmails] = useState<GmailEmail[]>([])
  const [selected, setSelected] = useState<GmailEmail | null>(null)
  const [filter, setFilter] = useState<GmailInboxFilter>('all')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadEmails = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!silent) setConnection('loading')
    else setRefreshing(true)
    try {
      const response = await fetch('/api/gmail/threads', { signal })
      const body = await response.json() as GmailThreadsResponse
      if (!response.ok) {
        if (body.error === 'NO_GOOGLE_ACCOUNT') setConnection('no_google')
        else if (GMAIL_REAUTH_ERRORS.has(body.error ?? '')) setConnection('no_gmail')
        else setConnection('error')
        return
      }
      setEmails(body.emails ?? [])
      setConnection('ready')
      if (silent) toast.success('Refreshed', `${body.emails?.length ?? 0} emails loaded`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setConnection('error')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(window.location.search)
    if (params.get('gmailAuth') === '1') {
      removeGmailQueryParam('gmailAuth')
      toast.success('Google account connected!', 'Loading your Gmail…')
    }
    const gmailError = params.get('gmailError')
    if (gmailError) {
      removeGmailQueryParam('gmailError')
      toast.error('Gmail connection failed', gmailError)
    }
    void loadEmails(false, controller.signal)
    return () => controller.abort()
  }, [loadEmails, toast])

  const counts = useMemo(() => countInboxEmails(emails), [emails])
  const filteredEmails = useMemo(() => filterInboxEmails(emails, filter, search), [emails, filter, search])

  function connectGoogle() {
    if (authTriggeredRef.current) return
    authTriggeredRef.current = true
    window.location.href = '/api/gmail/oauth/start?transfer=1'
  }

  const toggleStar = useCallback((id: string) => {
    setEmails(current => current.map(email => email.id === id ? { ...email, starred: !email.starred } : email))
    setSelected(current => current?.id === id ? { ...current, starred: !current.starred } : current)
  }, [])

  const markRead = useCallback((id: string) => {
    setEmails(current => current.map(email => email.id === id ? { ...email, read: true } : email))
  }, [])

  if (connection !== 'ready') return <GmailConnectionScreen state={connection} onConnect={connectGoogle} onRetry={() => { authTriggeredRef.current = false; void loadEmails() }} />

  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <TopBar title="Gmail Tracker">
      {counts.unread > 0 && <span style={{ fontSize: 11, background: 'var(--primary)', color: '#fff', borderRadius: 999, padding: '2px 8px', fontWeight: 500 }}>{counts.unread} unread</span>}
      <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search emails…" aria-label="Search emails" style={searchStyle} />
      <Btn variant="ghost" onClick={() => void loadEmails(true)} disabled={refreshing}>{refreshing ? '…' : '⟳ Refresh'}</Btn>
    </TopBar>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <GmailInboxSidebar activeFilter={filter} counts={counts} email={session?.user?.email} onFilterChange={setFilter} />
      <GmailInboxList emails={filteredEmails} selectedId={selected?.id ?? null} onSelect={setSelected} />
      {selected && <GmailMessageReader email={selected} onClose={() => setSelected(null)} onStar={toggleStar} onMarkRead={markRead} />}
    </div>
  </div>
}

function removeGmailQueryParam(name: string) {
  const url = new URL(window.location.href)
  url.searchParams.delete(name)
  window.history.replaceState({}, '', url)
}

const searchStyle = { width: 200, padding: '5px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }
