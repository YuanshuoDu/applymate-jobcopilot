'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, Mail, RefreshCw } from 'lucide-react'
import { Btn, useToast } from '@/components/ui'
import { GmailConnectionScreen, type GmailConnectionState } from '@/components/gmail/GmailConnectionState'
import { RecommendationList } from '@/components/gmail/RecommendationList'
import { DEFAULT_RECOMMENDATION_FILTERS, filterRecommendations, type RecommendationFilters } from '@/components/gmail/recommendations-model'
import type { GmailRecommendation, GmailTrackingResponse } from '@/components/gmail/types'
import { useNav } from '@/lib/nav-context'
import './JobRecommendationsPage.css'

type ConnectionState = GmailConnectionState | 'ready'
const REAUTH_ERRORS = new Set(['GMAIL_REAUTH', 'GMAIL_SCOPE_MISSING', 'GMAIL_PERMISSION', 'TOKEN_EXPIRED'])
const RECOMMENDATIONS_CACHE_KEY = 'applymate:gmail-recommendations'

export function JobRecommendationsPage() {
  const { navigate } = useNav()
  const toast = useToast()
  const cachedRecommendations = useRef(readRecommendationCache())
  const [connection, setConnection] = useState<ConnectionState>(() => cachedRecommendations.current ? 'ready' : 'loading')
  const [recommendations, setRecommendations] = useState<GmailRecommendation[]>(() => cachedRecommendations.current ?? [])
  const [filters, setFilters] = useState<RecommendationFilters>(DEFAULT_RECOMMENDATION_FILTERS)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [showMoreFilters, setShowMoreFilters] = useState(false)

  const loadRecommendations = useCallback(async (silent = false, signal?: AbortSignal, notify = silent, refresh = false) => {
    if (!silent) setConnection('loading')
    else setRefreshing(true)
    try {
      const response = await fetch(`/api/gmail/tracking${refresh ? '?refresh=1' : ''}`, { signal })
      const body = await response.json() as GmailTrackingResponse & { error?: string }
      if (!response.ok) {
        if (body.error === 'NO_GOOGLE_ACCOUNT') setConnection('no_google')
        else if (REAUTH_ERRORS.has(body.error ?? '')) setConnection('no_gmail')
        else setConnection('error')
        return
      }
      setRecommendations(body.recommendations ?? [])
      writeRecommendationCache(body.recommendations ?? [])
      setConnection('ready')
      if (notify) toast.success('Inbox refreshed', `${body.pendingRecommendationCount ?? 0} jobs ready to review.`)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setConnection('error')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    void loadRecommendations(Boolean(cachedRecommendations.current), controller.signal, false)
    return () => controller.abort()
  }, [loadRecommendations])

  const visible = useMemo(() => filterRecommendations(recommendations, filters), [recommendations, filters])
  const platforms = useMemo(() => uniqueValues(recommendations.map(item => item.platform)), [recommendations])
  const locations = useMemo(() => uniqueValues(recommendations.map(item => item.location)), [recommendations])
  const selectedCount = selectedIds.size

  async function updateRecommendation(id: string, action: 'save' | 'dismiss') {
    setBusyIds(current => new Set(current).add(id))
    try {
      const response = await fetch(`/api/gmail/recommendations/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not update recommendation')
      setRecommendations(current => current.map(item => item.id === id ? { ...item, status: action === 'save' ? 'saved' : 'dismissed' } : item))
      setSelectedIds(current => { const next = new Set(current); next.delete(id); return next })
      if (action === 'save') {
        window.dispatchEvent(new Event('applymate:jobs-changed'))
        toast.success('Saved to My Jobs')
      } else toast.info('Job dismissed')
    } catch (error) {
      toast.error('Could not update job', error instanceof Error ? error.message : 'Try again')
    } finally {
      setBusyIds(current => { const next = new Set(current); next.delete(id); return next })
    }
  }

  async function saveSelected() {
    const candidates = visible.filter(item => selectedIds.has(item.id) && item.status === 'pending')
    for (const item of candidates) await updateRecommendation(item.id, 'save')
  }

  function updateFilters(partial: Partial<RecommendationFilters>) {
    setFilters(current => ({ ...current, ...partial }))
    setSelectedIds(new Set())
  }

  function toggleAll() {
    const candidates = visible.filter(item => item.status === 'pending')
    const everySelected = candidates.length > 0 && candidates.every(item => selectedIds.has(item.id))
    setSelectedIds(everySelected ? new Set() : new Set(candidates.map(item => item.id)))
  }

  function connectGoogle() { window.location.href = '/api/gmail/oauth/start?transfer=1' }

  if (connection !== 'ready') return <GmailConnectionScreen pageTitle="Job recommendations" state={connection} onConnect={connectGoogle} onRetry={() => void loadRecommendations()} />

  return <div className="job-recommendations-page">
    <header className="job-recommendations-heading">
      <div><h1>Job recommendations</h1><p>Jobs parsed from your subscription emails. Review and decide which jobs to save.</p></div>
      <button type="button" className="job-recommendations-heading-link" onClick={() => navigate('gmail')}><Mail size={14} />Gmail · Job recommendations</button>
      <div className="job-recommendations-toolbar">
        <Btn variant="ghost" onClick={() => void loadRecommendations(true, undefined, true, true)} disabled={refreshing}><RefreshCw size={15} />{refreshing ? 'Refreshing…' : 'Refresh inbox'}</Btn>
        <Btn variant="primary" onClick={() => void saveSelected()} disabled={selectedCount === 0 || busyIds.size > 0}><CheckSquare size={15} />Save selected{selectedCount ? ` · ${selectedCount}` : ''}</Btn>
      </div>
    </header>
    <main className="job-recommendations-content">
      <section className="job-recommendations-filters" aria-label="Filter job recommendations">
        <FilterSelect value={filters.platform} label="All sources" options={platforms} onChange={platform => updateFilters({ platform })} />
        <FilterSelect value={filters.status} label="All statuses" options={['all', 'pending', 'saved', 'dismissed']} onChange={status => updateFilters({ status: status as RecommendationFilters['status'] })} />
        <FilterSelect value={filters.location} label="All locations" options={locations} onChange={location => updateFilters({ location })} />
        <button type="button" className="job-recommendations-more" onClick={() => setShowMoreFilters(value => !value)}>More filters</button>
      </section>
      {showMoreFilters && <div className="job-recommendations-search"><input value={filters.search} onChange={event => updateFilters({ search: event.target.value })} placeholder="Search jobs, companies, or keywords" aria-label="Search recommendations" /></div>}
      {selectedCount > 0 && <div className="job-recommendations-selection"><span>{selectedCount} selected</span><button type="button" onClick={() => setSelectedIds(new Set())}>Clear selection</button></div>}
      <RecommendationList recommendations={visible} selectedIds={selectedIds} expandedId={expandedId} busyIds={busyIds} onToggle={id => setSelectedIds(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next })} onToggleAll={toggleAll} onExpand={id => setExpandedId(current => current === id ? null : id)} onAction={updateRecommendation} />
    </main>
  </div>
}

function FilterSelect({ value, label, options, onChange }: { value: string; label: string; options: string[]; onChange: (value: string) => void }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    <option value="all">{label}</option>
    {options.filter(option => option !== 'all').map(option => <option key={option} value={option}>{option === 'pending' ? 'New' : option[0].toUpperCase() + option.slice(1)}</option>)}
  </select>
}

function uniqueValues(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))].sort((left, right) => left.localeCompare(right))
}

function readRecommendationCache(): GmailRecommendation[] | null {
  if (typeof window === 'undefined') return null
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(RECOMMENDATIONS_CACHE_KEY) ?? 'null')
    return Array.isArray(value) ? value as GmailRecommendation[] : null
  } catch { return null }
}

function writeRecommendationCache(recommendations: GmailRecommendation[]) {
  try { window.sessionStorage.setItem(RECOMMENDATIONS_CACHE_KEY, JSON.stringify(recommendations)) } catch { /* Storage is optional. */ }
}
