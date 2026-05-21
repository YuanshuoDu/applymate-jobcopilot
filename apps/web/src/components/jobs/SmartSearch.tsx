'use client'

import React, { useState, useRef } from 'react'
import { Btn, CompanyLogo, INPUT_STYLE, ScorePill, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { Job, ResumeListItem } from '@/lib/types'

// ── Types ────────────────────────────────────────────────────────────────────

interface Filters {
  location:   string; remote: boolean; jobType: string
  datePosted: string; experience: string; salaryMin: string; salaryMax: string
}

interface JobResult {
  id:               string
  title:            string
  company:          string
  location:         string
  salary?:          string
  description:      string
  url:              string
  postedAt?:        string | null
  jobType?:         string | null
  logo?:            string | null
  source:           string
  seniority?:       string | null
  directApply?:     boolean
  keySkills?:       string[]
  workArrangement?: string | null
  experienceLevel?: string | null
  hiringManager?:   { name: string; title: string; linkedinUrl: string; email?: string | null } | null
  score:            number
}

interface SearchMeta {
  sourcesUsed:       string[]
  sourceBreakdown?:  Record<string, number>
  routing:           string
  totalRaw:          number
  totalDeduped:      number
  totalFiltered?:    number
  durationMs:        number
  topSkills?:        string[]
  salaryContext?:    { currency: string; median: number; min: number; max: number } | null
  withHiringManager?: number
  cached?:           boolean
}

const DEFAULT_FILTERS: Filters = {
  location: '', remote: false, jobType: '', datePosted: 'any', experience: '', salaryMin: '', salaryMax: '',
}

// ── Source style ─────────────────────────────────────────────────────────────

const SOURCE_STYLE: Record<string, { label: string; color: string }> = {
  adzuna:        { label: 'Adzuna',        color: '#854F0B' },
  jsearch:       { label: 'JSearch',       color: '#185FA5' },
  linkedin:      { label: 'LinkedIn',      color: '#0077B5' },
  jobicy:        { label: 'Jobicy',        color: '#3B6D11' },
  ats:           { label: 'ATS / Direct',  color: '#6D28D9' },
  internships:   { label: 'Internships',   color: '#059669' },
  xing:          { label: 'Xing',          color: '#047857' },
  indeed:        { label: 'Indeed',        color: '#2164F3' },
  remotive:      { label: 'Remotive',      color: '#EAB308' },
  bundesagentur: { label: 'Arbeitsagentur', color: '#DC2626' },
  reed:          { label: 'Reed',          color: '#7C3AED' },
  careerjet:     { label: 'CareerJet',     color: '#F97316' },
  mantiks:       { label: 'Mantiks',       color: '#EC4899' },
  irishjobs:     { label: 'IrishJobs',     color: '#16A34A' },
}

const JT_COLOR: Record<string, string> = {
  'Full Time': '#3B6D11', 'Part Time': '#854F0B', 'Contract': '#185FA5',
  Internship: '#9333EA', 'Full-time': '#3B6D11', 'Part-time': '#854F0B',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtPosted(iso?: string | null): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7)  return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

const WA_LABELS: Record<string, string> = {
  'Remote Solely': '🏠 Fully Remote',
  'Remote OK':     '🏠 Remote OK',
  'Hybrid':        '🏢 Hybrid',
  'On-site':       '📍 On-site',
}

// ── Save + Score ─────────────────────────────────────────────────────────────

async function saveAndScore(
  r: JobResult,
  onSaved: (id: string, dbId: string) => void,
  onScored: (id: string, score: number) => void,
  onError: (msg: string) => void,
) {
  const { data: job, error } = await apiMutate<Job>('/api/jobs', 'POST', {
    company: r.company, role: r.title, location: r.location,
    url: r.url, salary: r.salary ?? null, description: r.description,
    source: r.source, status: 'saved', keySkills: r.keySkills ?? [],
  })
  if (error || !job) { onError(error ?? 'Save failed'); return }
  onSaved(r.id, job.id)
  if (!r.description) return
  try {
    const listRes = await fetch('/api/resume')
    if (!listRes.ok) return
    const resumes: ResumeListItem[] = await listRes.json()
    if (!resumes.length) return
    const pick = resumes.find(rv => rv.isDefault) ?? resumes[0]
    const resumeRes = await fetch(`/api/resume/${pick.id}`)
    if (!resumeRes.ok) return
    const full = await resumeRes.json()
    if (!full?.content) return
    const scoreRes = await fetch('/api/ai/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeContent: full.content, jobTitle: r.title, jobDescription: r.description.slice(0, 2000), keySkills: r.keySkills ?? [] }),
    })
    if (!scoreRes.ok) return
    const sd = await scoreRes.json() as { score: number; matchedKeywords: string[]; missingKeywords: string[]; strengthSummary?: string; keywords?: string }
    await apiMutate(`/api/jobs/${job.id}`, 'PATCH', {
      score: sd.score,
      keywords: sd.keywords ?? '',
      analysisNote: `Match Score: ${sd.score}%\n\nMatched: ${sd.matchedKeywords?.join(', ') || '—'}\n\nMissing: ${sd.missingKeywords?.join(', ') || '—'}${sd.strengthSummary ? `\n\n${sd.strengthSummary}` : ''}`,
    })
    onScored(r.id, sd.score)
  } catch { /* best-effort */ }
}

// ── Style constants ──────────────────────────────────────────────────────────

const labelSt: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block', fontWeight: 500 }
const filterInput: React.CSSProperties = { ...INPUT_STYLE as React.CSSProperties, height: 34, fontSize: 12 }
const chip = (active: boolean, color = '#185FA5'): React.CSSProperties => ({
  padding: '5px 14px', borderRadius: 999, border: `1px solid ${active ? color : 'var(--border)'}`,
  background: active ? `${color}14` : 'var(--bg)',
  color: active ? color : 'var(--text-muted)', cursor: 'pointer', fontSize: 12,
  fontWeight: active ? 600 : 400, whiteSpace: 'nowrap', transition: 'all 0.15s',
})
const pageBtnS = (disabled: boolean): React.CSSProperties => ({
  padding: '4px 10px', border: '0.5px solid var(--border)', borderRadius: 5,
  background: disabled ? 'var(--bg-secondary)' : 'var(--bg)',
  color: disabled ? 'var(--text-muted)' : 'var(--text)',
  cursor: disabled ? 'default' : 'pointer', fontSize: 11, fontWeight: 500,
})

// ── Persistence helpers ──────────────────────────────────────────────────────

const LS_LAST   = 'applymate_last_search'
const LS_RECENT = 'applymate_recent_searches'
const MAX_RECENT = 10

interface StoredSearch {
  q: string; filters: Filters; results: JobResult[]; meta: SearchMeta | null
}

function loadLastSearch(): StoredSearch | null {
  try { const raw = localStorage.getItem(LS_LAST); return raw ? JSON.parse(raw) : null } catch { return null }
}
function saveLastSearch(s: StoredSearch) {
  try { localStorage.setItem(LS_LAST, JSON.stringify(s)) } catch {}
}
function loadRecent(): string[] {
  try { const raw = localStorage.getItem(LS_RECENT); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
function saveRecent(queries: string[]) {
  try { localStorage.setItem(LS_RECENT, JSON.stringify(queries.slice(0, MAX_RECENT))) } catch {}
}
function addRecent(q: string) {
  const prev = loadRecent().filter(x => x.toLowerCase() !== q.toLowerCase())
  saveRecent([q, ...prev])
}
function clearHistory() {
  try { localStorage.removeItem(LS_LAST); localStorage.removeItem(LS_RECENT) } catch {}
}

// ── Main Component ───────────────────────────────────────────────────────────

export function SmartSearch({ onJobSaved }: { onJobSaved?: () => void }) {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)

  // Restore last search on mount
  const lastSearch = useRef(loadLastSearch())
  const recentRef  = useRef(loadRecent())
  const [recentSearches, setRecentSearches] = useState(recentRef.current)

  const [q, setQ] = useState(lastSearch.current?.q ?? '')
  const [filters, setFilters] = useState<Filters>(lastSearch.current?.filters ?? DEFAULT_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<JobResult[]>(lastSearch.current?.results ?? [])
  const [meta, setMeta] = useState<SearchMeta | null>(lastSearch.current?.meta ?? null)
  const [searched, setSearched] = useState(!!lastSearch.current)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [scoringIds, setScoringIds] = useState<Set<string>>(new Set())
  const [scores, setScores] = useState<Record<string, number>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [page,       setPage      ] = useState(1)
  const [pageSize,   setPageSize  ] = useState(20)
  const [sortDir,    setSortDir   ] = useState<'asc' | 'desc'>('desc')
  const [translating, setTranslating] = useState<Set<string>>(new Set())
  const [translated,  setTranslated ] = useState<Record<string, { text: string; lang: string }>>({})
  const [translateLang, setTgtLang] = useState('zh')
  const [descExpanded, setDescExpanded] = useState<Set<string>>(new Set())

  function setFilter<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters(prev => ({ ...prev, [k]: v }))
  }

  const hasFilters = filters.location || filters.remote || filters.jobType ||
    filters.datePosted !== 'any' || filters.experience || filters.salaryMin || filters.salaryMax

  async function runSearch(query: string, f: Filters = filters) {
    if (!query.trim()) return
    setSearching(true); setSearched(true); setSavedIds(new Set()); setScores({}); setExpandedId(null); setPage(1)
    const params = new URLSearchParams({ q: query })
    if (f.location)             params.set('location', f.location)
    if (f.remote)               params.set('remote', '1')
    if (f.jobType)              params.set('jobType', f.jobType)
    if (f.datePosted !== 'any') params.set('datePosted', f.datePosted)
    if (f.experience)           params.set('experience', f.experience)
    if (f.salaryMin)            params.set('salaryMin', f.salaryMin)
    if (f.salaryMax)            params.set('salaryMax', f.salaryMax)
    try {
      const res = await fetch(`/api/search/unified?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')
      setResults(json.jobs ?? [])
      setMeta(json.meta ?? null)
      saveLastSearch({ q: query.trim(), filters: f, results: json.jobs ?? [], meta: json.meta ?? null })
      addRecent(query.trim())
      setRecentSearches(loadRecent())
    } catch (e) {
      toast.error('Search failed', (e as Error).message)
      setResults([])
    } finally { setSearching(false) }
  }

  async function doSearch() {
    await runSearch(q, filters)
  }

  async function handleSave(r: JobResult) {
    setSavingIds(prev => new Set(prev).add(r.id))
    await saveAndScore(r,
      (rid) => {
        setSavingIds(prev => { const n = new Set(prev); n.delete(rid); return n })
        setSavedIds(prev => new Set(prev).add(rid))
        setScoringIds(prev => new Set(prev).add(rid))
        toast.success('Saved', `${r.title} at ${r.company} — scoring…`)
        onJobSaved?.()
      },
      (rid, score) => {
        setScoringIds(prev => { const n = new Set(prev); n.delete(rid); return n })
        setScores(prev => ({ ...prev, [rid]: score }))
        toast.success('Scored', `${r.company}: ${score}% match`)
      },
      (msg) => {
        setSavingIds(prev => { const n = new Set(prev); n.delete(r.id); return n })
        toast.error('Save failed', msg)
      },
    )
  }

  async function handleTranslate(r: JobResult) {
    if (!r.description) return
    setTranslating(prev => new Set(prev).add(r.id))
    try {
      const res = await fetch('/api/ai/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: r.description, targetLang: translateLang }),
      })
      if (res.ok) {
        const json = await res.json() as { translated?: string }
        if (json.translated) setTranslated(prev => ({ ...prev, [r.id]: { text: json.translated!, lang: translateLang } }))
      }
    } catch {} finally { setTranslating(prev => { const n = new Set(prev); n.delete(r.id); return n }) }
  }

  const activePills = ([
    filters.location    && { label: `📍 ${filters.location}`,        onRemove: () => setFilter('location', '') },
    filters.remote      && { label: '🏠 Remote',                      onRemove: () => setFilter('remote', false) },
    filters.jobType     && { label: `💼 ${filters.jobType}`,          onRemove: () => setFilter('jobType', '') },
    filters.datePosted !== 'any' && { label: `📅 ${filters.datePosted}`, onRemove: () => setFilter('datePosted', 'any') },
    filters.experience  && { label: `⭐ ${filters.experience}`,       onRemove: () => setFilter('experience', '') },
    (filters.salaryMin || filters.salaryMax) && {
      label: `💰 ${filters.salaryMin ? `${filters.salaryMin}k` : ''}–${filters.salaryMax ? `${filters.salaryMax}k` : ''}`,
      onRemove: () => { setFilter('salaryMin', ''); setFilter('salaryMax', '') },
    },
  ] as { label: string; onRemove: () => void }[]).filter(Boolean)

  // ── Computed: client-side pagination ──────────────────────────────────────
  const sorted     = [...results].sort((a, b) => sortDir === 'desc' ? b.score - a.score : a.score - b.score)
  const start      = (page - 1) * pageSize
  const paged      = sorted.slice(start, start + pageSize)
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 960, margin: '0 auto', width: '100%' }}>

      {/* ── Search bar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: 'var(--text-muted)', pointerEvents: 'none', zIndex: 1 }}>🔍</span>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
            placeholder='"Software Engineer Dublin" or "React Developer Ireland"'
            style={{ ...INPUT_STYLE as React.CSSProperties, boxSizing: 'border-box', width: '100%', paddingLeft: 38, height: 42, fontSize: 13, borderRadius: 10, border: '1.5px solid var(--border)', transition: 'border-color 0.15s' }}
          />
        </div>
        <button onClick={doSearch} disabled={searching || !q.trim()}
          style={{ padding: '0 28px', height: 42, background: '#185FA5', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: searching ? 'not-allowed' : 'pointer', opacity: searching ? 0.7 : 1, whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
          {searching ? 'Searching…' : 'Search Jobs'}
        </button>
        <button onClick={() => setShowFilters(v => !v)}
          style={{ padding: '0 16px', height: 42, background: showFilters ? 'rgba(24,95,165,0.07)' : 'var(--bg-secondary)', color: showFilters ? '#185FA5' : 'var(--text-muted)', border: `1.5px solid ${showFilters ? '#185FA5' : 'var(--border)'}`, borderRadius: 10, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
          ⚙ Filters{hasFilters ? ` (${activePills.length})` : ''}
        </button>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 12,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}>
          <div><label style={labelSt}>📍 Location</label><input style={filterInput} value={filters.location} onChange={e => setFilter('location', e.target.value)} placeholder="Dublin, Berlin…" /></div>
          <div><label style={labelSt}>💼 Job Type</label><select style={filterInput} value={filters.jobType} onChange={e => setFilter('jobType', e.target.value)}>
            <option value="">Any</option><option value="fulltime">Full-time</option><option value="parttime">Part-time</option><option value="contract">Contract</option><option value="internship">Internship</option>
          </select></div>
          <div><label style={labelSt}>📅 Posted</label><select style={filterInput} value={filters.datePosted} onChange={e => setFilter('datePosted', e.target.value)}>
            <option value="any">Any time</option><option value="today">Today</option><option value="week">This week</option><option value="month">This month</option>
          </select></div>
          <div><label style={labelSt}>⭐ Level</label><select style={filterInput} value={filters.experience} onChange={e => setFilter('experience', e.target.value)}>
            <option value="">Any</option><option value="entry">Entry / Junior</option><option value="mid">Mid-level</option><option value="senior">Senior</option><option value="lead">Lead / Manager</option>
          </select></div>
          <div><label style={labelSt}>💰 Min (k)</label><input style={filterInput} type="number" min={0} max={500} value={filters.salaryMin} onChange={e => setFilter('salaryMin', e.target.value)} placeholder="e.g. 50" /></div>
          <div><label style={labelSt}>💰 Max (k)</label><input style={filterInput} type="number" min={0} max={500} value={filters.salaryMax} onChange={e => setFilter('salaryMax', e.target.value)} placeholder="e.g. 120" /></div>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <label style={labelSt}>🏠 Remote</label>
            <button onClick={() => setFilter('remote', !filters.remote)} style={chip(filters.remote)}>
              {filters.remote ? '✓ Remote only' : 'Any'}  </button>
          </div>
          {hasFilters && (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label style={{ ...labelSt, opacity: 0 }}>x</label>
              <button onClick={() => setFilters(DEFAULT_FILTERS)} style={{ ...chip(false), color: '#DC2626', borderColor: 'rgba(220,38,38,0.4)' }}>
                Clear all  </button>
            </div>
          )}
        </div>
      )}

      {/* ── Active pills ── */}
      {activePills.length > 0 && !showFilters && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {activePills.map((p, i) => (
            <span key={i} style={{ ...chip(true), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {p.label}
              <button onClick={p.onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, color: 'inherit', lineHeight: 1 }}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* ── Recent searches + history ── */}
      {!searched && recentSearches.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>🕐 Recent:</span>
          {recentSearches.slice(0, 6).map(s => (
            <button key={s} onClick={() => { setQ(s); setFilters(DEFAULT_FILTERS); runSearch(s, DEFAULT_FILTERS) }}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {s}
            </button>
          ))}
          <button onClick={() => {
            clearHistory()
            setRecentSearches([])
            setQ('')
            setResults([])
            setMeta(null)
            setSearched(false)
            setFilters(DEFAULT_FILTERS)
            toast.success('Cleared', 'Search history cleared')
          }}
            style={{ fontSize: 10, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>
            Clear history
          </button>
        </div>
      )}
      {/* ── Inline clear when results are shown ── */}
      {searched && results.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <button onClick={() => {
            clearHistory()
            setRecentSearches([])
            setQ('')
            setResults([])
            setMeta(null)
            setSearched(false)
            setFilters(DEFAULT_FILTERS)
          }}
            style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: '0.5px solid var(--border)', borderRadius: 5, padding: '3px 8px', cursor: 'pointer' }}>
            🗑 Clear search
          </button>
        </div>
      )}

      {/* ── Results area ── */}
      {searched && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {searching ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <div style={{ width: 28, height: 28, border: '2.5px solid rgba(24,95,165,0.12)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 14px' }} />
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>AI analysing your search, routing to best sources…</div>
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, color: 'var(--text)' }}>No matching jobs found</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>Try broader keywords or a different location</div>
            </div>
          ) : (
            <>
              {/* ── Meta bar ── */}
              {meta && (
                <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderRadius: 10, marginBottom: 8, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{results.length} jobs found</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>via {meta.sourcesUsed.map(s => SOURCE_STYLE[s]?.label ?? s).join(' · ')}</span>
                  {meta.salaryContext && (
                    <span style={{ fontSize: 11, color: '#3B6D11', fontWeight: 500, marginLeft: 'auto' }}>
                      💰 Market: {meta.salaryContext.currency === 'EUR' ? '€' : meta.salaryContext.currency === 'GBP' ? '£' : '$'}{Math.round(meta.salaryContext.median / 1000)}k median
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{meta.durationMs}ms {meta.cached ? '(cached)' : ''}</span>
                </div>
              )}

              {/* ── Skills cloud ── */}
              {meta?.topSkills?.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>Trending skills:</span>
                  {meta.topSkills.slice(0, 8).map(sk => (
                    <span key={sk} style={{ fontSize: 10, padding: '3px 9px', borderRadius: 999, background: 'rgba(24,95,165,0.06)', color: '#185FA5' }}>{sk}</span>
                  ))}
                </div>
              ) : null}

              {/* ── Job cards ── */}
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {paged.map(r => { const src = SOURCE_STYLE[r.source] ?? { label: r.source, color: '#666' }
                  const expanded = expandedId === r.id
                  return (
                    <div key={`${r.source}-${r.id}`}
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      style={{
                        padding: expanded ? '18px 20px' : '14px 20px',
                        marginBottom: expanded ? 10 : 6,
                        display: 'flex', alignItems: expanded ? 'stretch' : 'center', gap: 14,
                        borderRadius: 10,
                        border: expanded ? '1.5px solid var(--border)' : '1px solid var(--border)',
                        background: expanded ? 'var(--bg)' : 'var(--bg)',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        boxShadow: expanded ? '0 4px 16px rgba(0,0,0,0.06)' : 'none',
                      }}>
                      <CompanyLogo logo={r.logo || r.company.slice(0, 2).toUpperCase()} size={expanded ? 36 : 32} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Row 1: title + badges */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                          <span style={{ fontSize: expanded ? 14 : 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
                            {r.title}
                          </span>
                          {r.jobType && (
                            <span style={{ fontSize: 9, fontWeight: 500, color: JT_COLOR[r.jobType] ?? 'var(--text-muted)', background: `${JT_COLOR[r.jobType] ?? 'var(--text-muted)'}14`, borderRadius: 5, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                              {r.jobType}
                            </span>
                          )}
                        </div>

                        {/* Row 2: company · location · time · remote badge */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
                          <span style={{ fontWeight: 500, color: 'var(--text)' }}>{r.company}</span>
                          {r.location && <span>📍 {r.location}</span>}
                          {r.workArrangement && WA_LABELS[r.workArrangement] && (
                            <span style={{ fontSize: 10, background: 'rgba(5,150,105,0.08)', color: '#059669', borderRadius: 5, padding: '1px 7px' }}>
                              {WA_LABELS[r.workArrangement]}
                            </span>
                          )}
                          {r.postedAt && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>{fmtPosted(r.postedAt)}</span>}
                          <span style={{ fontSize: 9, color: src.color, background: `${src.color}14`, borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>
                            {src.label}
                          </span>
                        </div>

                        {/* Row 3: salary + skills */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
                          {r.salary && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#3B6D11', background: 'rgba(59,109,17,0.06)', borderRadius: 5, padding: '2px 8px' }}>
                              💰 {r.salary}
                            </span>
                          )}
                          {r.seniority && (
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderRadius: 5, padding: '2px 7px' }}>
                              {r.seniority}
                            </span>
                          )}
                          {r.directApply && (
                            <span style={{ fontSize: 10, color: '#6D28D9', background: 'rgba(109,40,217,0.06)', borderRadius: 5, padding: '2px 7px', fontWeight: 500 }}>
                              🚀 Direct Apply
                            </span>
                          )}
                          {r.keySkills?.slice(0, expanded ? 10 : 4).map(sk => (
                            <span key={sk} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 999, background: 'rgba(24,95,165,0.05)', color: '#185FA5' }}>
                              {sk}
                            </span>
                          ))}
                          {!expanded && r.keySkills?.length && r.keySkills.length > 4 && (
                            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>+{r.keySkills.length - 4} more</span>
                          )}
                        </div>

                        {/* Expanded content */}
                        {expanded && (
                          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>

                            {/* ── Metadata chips ── */}
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                              {r.postedAt && <span>📅 Posted: <strong>{fmtPosted(r.postedAt)}</strong></span>}
                              {r.experienceLevel && <span>⭐ Level: <strong>{r.experienceLevel} years</strong></span>}
                              {r.workArrangement && <span>{WA_LABELS[r.workArrangement] ?? r.workArrangement}</span>}
                              {r.jobType && <span>💼 <strong>{r.jobType}</strong></span>}
                              {r.seniority && <span>📊 <strong>{r.seniority}</strong></span>}
                              {r.directApply && <span style={{ color: '#6D28D9' }}>🚀 <strong>Direct Apply</strong></span>}
                              <span style={{ color: src.color }}>📡 Source: <strong>{src.label}</strong></span>
                            </div>

                            {/* ── All skills ── */}
                            {r.keySkills?.length ? (
                              <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Skills Required</div>
                                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                  {r.keySkills.map(sk => (
                                    <span key={sk} style={{ fontSize: 10, padding: '3px 9px', borderRadius: 999, background: 'rgba(24,95,165,0.08)', color: '#185FA5', fontWeight: 500 }}>{sk}</span>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {/* ── Full description ── */}
                            <div style={{ marginBottom: 14 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Job Description</span>
                                {r.description && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <select value={translateLang} onChange={e => setTgtLang(e.target.value)}
                                      style={{ fontSize: 9, padding: '2px 4px', border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text-muted)' }}>
                                      {['zh','en','de','fr','es','ja'].map(l => <option key={l} value={l}>{l==='zh'?'中文':l==='en'?'EN':l==='de'?'DE':l==='fr'?'FR':l==='es'?'ES':'JA'}</option>)}
                                    </select>
                                    <button onClick={e => { e.stopPropagation(); handleTranslate(r) }}
                                      disabled={translating.has(r.id)}
                                      style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg)', color: '#185FA5', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                      {translating.has(r.id) ? 'Translating…' : '🌐 Translate'}
                                    </button>
                                  </div>
                                )}
                              </div>
                              {r.description ? (
                                <>
                                  {(() => {
                                    const text = translated[r.id] ? translated[r.id].text : r.description
                                    const expanded = descExpanded.has(r.id)
                                    const long = text.length > 600
                                    return <>
                                      <div style={{
                                        fontSize: 12, lineHeight: 1.75, color: 'var(--text)', whiteSpace: 'pre-wrap',
                                        background: 'var(--bg-secondary)', borderRadius: 8, padding: '12px 14px',
                                        maxHeight: expanded ? 'none' : 300, overflow: expanded ? 'visible' : 'hidden',
                                        position: 'relative' as const,
                                      }}>
                                        {text}
                                        {!expanded && long && (
                                          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, var(--bg-secondary))' }} />
                                        )}
                                      </div>
                                      <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                                        {long && (
                                          <button onClick={e => { e.stopPropagation(); setDescExpanded(prev => { const n = new Set(prev); expanded ? n.delete(r.id) : n.add(r.id); return n }) }}
                                            style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                            {expanded ? '▲ Show less' : '▼ Read more'}
                                          </button>
                                        )}
                                        <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                                          style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'underline' }}>
                                          View full posting on original site ↗
                                        </a>
                                      </div>
                                    </>
                                  })()}
                                </>
                              ) : (
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 8, textAlign: 'center' }}>
                                  No description available. <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#185FA5' }}>View original posting ↗</a>
                                </div>
                              )}
                            </div>

                            {/* ── Hiring manager ── */}
                            {r.hiringManager && (
                              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(236,72,153,0.06)', border: '1px solid rgba(236,72,153,0.2)', marginBottom: 12 }}>
                                <span style={{ fontSize: 10, fontWeight: 600, color: '#EC4899' }}>👤 Hiring Manager</span>
                                <div style={{ fontSize: 11, marginTop: 4 }}>
                                  <strong>{r.hiringManager.name}</strong> · {r.hiringManager.title}
                                  {r.hiringManager.email && <> · <a href={`mailto:${r.hiringManager.email}`} style={{ color: '#185FA5', textDecoration: 'none' }}>{r.hiringManager.email}</a></>}
                                </div>
                              </div>
                            )}

                            {/* ── Actions row ── */}
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                              <a href={r.url} target="_blank" rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                style={{ padding: '8px 24px', background: '#185FA5', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, transition: 'background 0.15s' }}>
                                🔗 View Original Job Posting
                              </a>
                              {savedIds.has(r.id) ? (
                                scores[r.id] !== undefined ? <ScorePill score={scores[r.id]} /> : <span style={{ fontSize: 11, color: '#3B6D11', fontWeight: 500 }}>✓ Saved</span>
                              ) : (
                                <span onClick={e => e.stopPropagation()}>
                                  <Btn variant="ghost" disabled={savingIds.has(r.id)} onClick={() => handleSave(r)}>
                                    {savingIds.has(r.id) ? 'Saving…' : '💾 Save'}
                                  </Btn>
                                </span>
                              )}
                              {scoringIds.has(r.id) && (
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ width: 10, height: 10, border: '1.5px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />
                                  AI scoring…
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Collapsed quick actions */}
                      {!expanded && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                          <a href={r.url} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            title="View original job posting"
                            style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: '#185FA5', color: '#fff', fontSize: 14, textDecoration: 'none', transition: 'background 0.15s', flexShrink: 0 }}>
                            ↗
                          </a>
                          {savedIds.has(r.id) ? (
                            scores[r.id] !== undefined ? <ScorePill score={scores[r.id]} /> : <span style={{ fontSize: 9, color: '#3B6D11', fontWeight: 500 }}>Saved</span>
                          ) : (
                            <button onClick={e => { e.stopPropagation(); handleSave(r) }}
                              disabled={savingIds.has(r.id)}
                              title="Save to job tracker"
                              style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 16, cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0 }}>
                              {savingIds.has(r.id) ? '…' : '💾'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* ── Search pagination ── */}
                {results.length > pageSize && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderTop: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {start + 1}–{Math.min(start + pageSize, results.length)} of {results.length}
                      </span>
                      <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
                        style={{ padding: '3px 6px', fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)' }}>
                        <option value={20}>20 / page</option>
                        <option value={50}>50 / page</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Sort: Score {sortDir === 'desc' ? '↓' : '↑'}</span>
                      <button onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                        style={{ padding: '3px 8px', fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', cursor: 'pointer' }}>
                        {sortDir === 'desc' ? '↓ High first' : '↑ Low first'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button onClick={() => setPage(1)} disabled={page <= 1}
                        style={pageBtnS(page <= 1)}>«</button>
                      <button onClick={() => setPage(p => p - 1)} disabled={page <= 1}
                        style={pageBtnS(page <= 1)}>‹</button>
                      {(() => {
                        const btns: number[] = []
                        for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) btns.push(p)
                        return btns.map(p => (
                          <button key={p} onClick={() => setPage(p)}
                            style={{ ...pageBtnS(false), minWidth: 28, textAlign: 'center', fontWeight: p === page ? 700 : 400, background: p === page ? 'rgba(24,95,165,0.08)' : 'var(--bg)', color: p === page ? '#185FA5' : 'var(--text)' }}>
                            {p}
                          </button>
                        ))
                      })()}
                      <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}
                        style={pageBtnS(page >= totalPages)}>›</button>
                      <button onClick={() => setPage(totalPages)} disabled={page >= totalPages}
                        style={pageBtnS(page >= totalPages)}>»</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!searched && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 44 }}>🤖</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>AI-Powered Job Search</div>
          <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 400, lineHeight: 1.8 }}>
            Search across <strong>14 job sources</strong> simultaneously.<br />
            AI routes your query to the best sources for your location,<br />
            deduplicates results, and enriches jobs with salary & skills data.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
            {['Software Engineer Dublin', 'Data Engineer Ireland', 'React Developer Remote'].map(s => (
              <button key={s} onClick={() => { setQ(s); setTimeout(() => inputRef.current?.focus(), 50) }}
                style={{ fontSize: 11, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
