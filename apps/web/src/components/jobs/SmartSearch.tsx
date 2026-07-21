'use client'

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { CompanyLogo, ScorePill, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { Job } from '@/lib/types'
import { extractSearchQuery } from './search-query'

// ── Types ────────────────────────────────────────────────────────────────────

interface Filters {
  location:   string; remote: boolean; jobType: string
  datePosted: string; experience: string; salaryMin: string; salaryMax: string
}
interface JobResult {
  id: string; title: string; company: string; location: string
  salary?: string; description: string; url: string; postedAt?: string | null
  jobType?: string | null; logo?: string | null; source: string
  seniority?: string | null; directApply?: boolean; keySkills?: string[]
  workArrangement?: string | null; experienceLevel?: string | null
  hiringManager?: { name: string; title: string; linkedinUrl: string; email?: string | null } | null
  score: number
}
interface SearchMeta {
  sourcesUsed: string[]; sourceBreakdown?: Record<string, number>; routing: string
  totalRaw: number; totalDeduped: number; totalFiltered?: number; durationMs: number
  topSkills?: string[]; salaryContext?: { currency: string; median: number; min: number; max: number } | null
  withHiringManager?: number; cached?: boolean
  apiKeys?: { rapidapi: boolean; adzuna: boolean; reed: boolean; careerjet: boolean }
}

const DEFAULT_FILTERS: Filters = {
  location: '', remote: false, jobType: '', datePosted: 'any', experience: '', salaryMin: '', salaryMax: '',
}

// ── SVG Icons ────────────────────────────────────────────────────────────────

const Icon = {
  Search:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  Filter:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  MapPin:    () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Briefcase: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
  Calendar:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  Dollar:    () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Home:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Rocket:    () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
  Star:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  ExternalLink: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  Bookmark:  (filled?: boolean) => filled
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>,
  Clock:     () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Globe:     () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  User:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  ChevronDown: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  ChevronUp:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>,
  X:         () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Trash:     () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  Cpu:       () => <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
  Zap:       () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
}

// ── Source styles ─────────────────────────────────────────────────────────────

const SOURCE_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  adzuna:        { label: 'Adzuna',         color: '#D97706', bg: 'rgba(217,119,6,0.10)'      },
  jsearch:       { label: 'JSearch',        color: '#6366F1', bg: 'rgba(99,102,241,0.10)'     },
  linkedin:      { label: 'LinkedIn',       color: '#0077B5', bg: 'rgba(0,119,181,0.10)'      },
  jobicy:        { label: 'Jobicy',         color: '#059669', bg: 'rgba(5,150,105,0.10)'      },
  ats:           { label: 'ATS / Direct',   color: '#7C3AED', bg: 'rgba(124,58,237,0.10)'     },
  internships:   { label: 'Internships',    color: '#059669', bg: 'rgba(5,150,105,0.10)'      },
  xing:          { label: 'Xing',           color: '#047857', bg: 'rgba(4,120,87,0.10)'       },
  indeed:        { label: 'Indeed',         color: '#2164F3', bg: 'rgba(33,100,243,0.10)'     },
  remotive:      { label: 'Remotive',       color: '#CA8A04', bg: 'rgba(202,138,4,0.10)'      },
  bundesagentur: { label: 'Arbeitsagentur', color: '#DC2626', bg: 'rgba(220,38,38,0.10)'      },
  reed:          { label: 'Reed',           color: '#7C3AED', bg: 'rgba(124,58,237,0.10)'     },
  careerjet:     { label: 'CareerJet',      color: '#EA580C', bg: 'rgba(234,88,12,0.10)'      },
  mantiks:       { label: 'Mantiks',        color: '#DB2777', bg: 'rgba(219,39,119,0.10)'     },
  irishjobs:     { label: 'IrishJobs',      color: '#16A34A', bg: 'rgba(22,163,74,0.10)'      },
}

const JOB_TYPE_COLOR: Record<string, { color: string; bg: string }> = {
  'Full Time':   { color: '#059669', bg: 'rgba(5,150,105,0.10)'    },
  'Full-time':   { color: '#059669', bg: 'rgba(5,150,105,0.10)'    },
  'Part Time':   { color: '#D97706', bg: 'rgba(217,119,6,0.10)'    },
  'Part-time':   { color: '#D97706', bg: 'rgba(217,119,6,0.10)'    },
  'Contract':    { color: '#6366F1', bg: 'rgba(99,102,241,0.10)'   },
  'Internship':  { color: '#9333EA', bg: 'rgba(147,51,234,0.10)'   },
}

const WA_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
  'Remote Solely': { icon: <Icon.Home />,    label: 'Remote',   color: '#059669', bg: 'rgba(5,150,105,0.10)'   },
  'Remote OK':     { icon: <Icon.Home />,    label: 'Remote OK',color: '#0284C7', bg: 'rgba(2,132,199,0.10)'   },
  'Hybrid':        { icon: <Icon.Briefcase/>,label: 'Hybrid',   color: '#7C3AED', bg: 'rgba(124,58,237,0.10)'  },
  'On-site':       { icon: <Icon.MapPin />,  label: 'On-site',  color: '#64748B', bg: 'rgba(100,116,139,0.10)' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPosted(iso?: string | null): string {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 7)  return `${d}d ago`
  if (d < 30) return `${Math.floor(d / 7)}w ago`
  return `${Math.floor(d / 30)}mo ago`
}

// ── Region display helper ─────────────────────────────────────────────────────

const FLAG_MAP: Record<string, string> = {
  ie: '🇮🇪', gb: '🇬🇧', de: '🇩🇪', at: '🇦🇹', ch: '🇨🇭',
  nl: '🇳🇱', fr: '🇫🇷', be: '🇧🇪', es: '🇪🇸', it: '🇮🇹',
  pl: '🇵🇱', se: '🇸🇪', dk: '🇩🇰', no: '🇳🇴', fi: '🇫🇮',
  pt: '🇵🇹', cz: '🇨🇿', hu: '🇭🇺', ro: '🇷🇴', gr: '🇬🇷',
}

function parseRoutingFlag(routing: string): string {
  const m = routing.match(/^([A-Z]{2})\s*→/)
  if (m) return FLAG_MAP[m[1].toLowerCase()] ?? ''
  if (/ireland/i.test(routing)) return '🇮🇪'
  if (/remote|远程/i.test(routing)) return '🌍'
  return ''
}

const LS_LAST   = 'applymate_last_search'
const LS_RECENT = 'applymate_recent_searches'

interface StoredSearch { q: string; filters: Filters; results: JobResult[]; meta: SearchMeta | null }
function loadLast(): StoredSearch | null { try { const r = localStorage.getItem(LS_LAST); return r ? JSON.parse(r) : null } catch { return null } }
function saveLast(s: StoredSearch) { try { localStorage.setItem(LS_LAST, JSON.stringify(s)) } catch {} }
function loadRecent(): string[] { try { const r = localStorage.getItem(LS_RECENT); return r ? JSON.parse(r) : [] } catch { return [] } }
function addRecent(q: string) { const p = loadRecent().filter(x => x.toLowerCase() !== q.toLowerCase()); try { localStorage.setItem(LS_RECENT, JSON.stringify([q, ...p].slice(0, 8))) } catch {} }
function clearHistory() { try { localStorage.removeItem(LS_LAST); localStorage.removeItem(LS_RECENT) } catch {} }

async function saveAndScore(r: JobResult, onSaved: (id: string, dbId: string) => void, onScored: (id: string, score: number) => void, onError: (msg: string) => void) {
  const { data: job, error } = await apiMutate<Job>('/api/jobs', 'POST', {
    company: r.company, role: r.title, location: r.location,
    url: r.url, salary: r.salary ?? null, description: r.description,
    source: r.source, status: 'saved', keySkills: r.keySkills ?? [],
  })
  if (error || !job) { onError(error ?? 'Save failed'); return }
  onSaved(r.id, job.id)
  if (!r.description) return
  try {
    // The default endpoint already falls back to a user's latest resume, so
    // avoid serially loading the list and then the selected document.
    const resumeResponse = await fetch('/api/resume/default'); if (!resumeResponse.ok) return
    const full = await resumeResponse.json(); if (!full?.content) return
    const sr = await fetch('/api/ai/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resumeContent: full.content, jobTitle: r.title, jobDescription: r.description.slice(0, 2000), keySkills: r.keySkills ?? [] }) })
    if (!sr.ok) return
    const sd = await sr.json() as { score: number; matchedKeywords: string[]; missingKeywords: string[] }
    await apiMutate(`/api/jobs/${job.id}`, 'PATCH', { score: sd.score, analysisNote: `Match: ${sd.score}%\nMatched: ${sd.matchedKeywords?.join(', ')||'—'}\nMissing: ${sd.missingKeywords?.join(', ')||'—'}` })
    onScored(r.id, sd.score)
  } catch {}
}

// ── Inline badge ──────────────────────────────────────────────────────────────
function Badge({ children, color, bg, style }: { children: React.ReactNode; color: string; bg: string; style?: React.CSSProperties }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, color, background: bg, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap', lineHeight: 1.5, ...style }}>
      {children}
    </span>
  )
}

// ── Glass input style ─────────────────────────────────────────────────────────
const glassInput: React.CSSProperties = {
  width: '100%', padding: '8px 11px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 9,
  background: 'var(--glass-bg)', backdropFilter: 'blur(8px)',
  color: 'var(--text)', outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s',
}

// ── Main component ────────────────────────────────────────────────────────────

export function SmartSearch({ onJobSaved }: { onJobSaved?: () => void }) {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const lastSearch = useRef(loadLast())
  const searchControllerRef = useRef<AbortController | null>(null)
  const searchRequestRef = useRef(0)

  const [q,           setQ]           = useState(lastSearch.current?.q ?? '')
  const [filters,     setFilters]     = useState<Filters>(lastSearch.current?.filters ?? DEFAULT_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [searching,   setSearching]   = useState(false)
  const [results,     setResults]     = useState<JobResult[]>(lastSearch.current?.results ?? [])
  const [meta,        setMeta]        = useState<SearchMeta | null>(lastSearch.current?.meta ?? null)
  const [searched,    setSearched]    = useState(!!lastSearch.current)
  const [savingIds,   setSavingIds]   = useState(new Set<string>())
  const [savedIds,    setSavedIds]    = useState(new Set<string>())
  const [scoringIds,  setScoringIds]  = useState(new Set<string>())
  const [scores,      setScores]      = useState<Record<string, number>>({})
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [page,        setPage]        = useState(1)
  const [pageSize,    setPageSize]    = useState(20)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('desc')
  const [translating, setTranslating] = useState(new Set<string>())
  const [translated,  setTranslated]  = useState<Record<string, { text: string; lang: string }>>({})
  const [tgtLang,     setTgtLang]     = useState('de')
  const [descExp,     setDescExp]     = useState(new Set<string>())
  const [recent,      setRecent]      = useState(loadRecent)
  const [searchFocus, setSearchFocus] = useState(false)

  // Track what params were used in the last executed search for stale detection
  const lastSearchedRef = useRef<{ q: string; filters: Filters } | null>(
    lastSearch.current ? { q: lastSearch.current.q, filters: lastSearch.current.filters } : null
  )

  const isStale = searched && !!lastSearchedRef.current && (
    q.trim() !== lastSearchedRef.current.q ||
    JSON.stringify(filters) !== JSON.stringify(lastSearchedRef.current.filters)
  )

  useEffect(() => () => searchControllerRef.current?.abort(), [])

  function setFilter<K extends keyof Filters>(k: K, v: Filters[K]) { setFilters(p => ({ ...p, [k]: v })) }

  const hasFilters = !!(filters.location || filters.remote || filters.jobType || filters.datePosted !== 'any' || filters.experience || filters.salaryMin || filters.salaryMax)

  const activePills = ([
    filters.location  && { key: 'loc',  icon: <Icon.MapPin />,    label: filters.location,  onRemove: () => { setFilter('location', ''); if (searched) triggerSearch(q, { ...filters, location: '' }) } },
    filters.remote    && { key: 'rem',  icon: <Icon.Home />,      label: 'Remote only',     onRemove: () => { setFilter('remote', false); if (searched) triggerSearch(q, { ...filters, remote: false }) } },
    filters.jobType   && { key: 'jt',   icon: <Icon.Briefcase />, label: filters.jobType,   onRemove: () => { setFilter('jobType', ''); if (searched) triggerSearch(q, { ...filters, jobType: '' }) } },
    filters.datePosted !== 'any' && { key: 'dp', icon: <Icon.Calendar />, label: filters.datePosted, onRemove: () => { setFilter('datePosted', 'any'); if (searched) triggerSearch(q, { ...filters, datePosted: 'any' }) } },
    filters.experience && { key: 'exp', icon: <Icon.Star />,      label: filters.experience,onRemove: () => { setFilter('experience', ''); if (searched) triggerSearch(q, { ...filters, experience: '' }) } },
    (filters.salaryMin || filters.salaryMax) && { key: 'sal', icon: <Icon.Dollar />, label: `${filters.salaryMin||'?'}k – ${filters.salaryMax||'?'}k`, onRemove: () => { setFilter('salaryMin', ''); setFilter('salaryMax', ''); if (searched) triggerSearch(q, { ...filters, salaryMin: '', salaryMax: '' }) } },
  ]).filter(Boolean) as { key: string; icon: React.ReactNode; label: string; onRemove: () => void }[]

  const runSearch = useCallback(async (query: string, f: Filters) => {
    if (!query.trim()) return
    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    searchControllerRef.current?.abort()
    const controller = new AbortController()
    searchControllerRef.current = controller
    setSearching(true); setSearched(true); setSavedIds(new Set()); setScores({}); setExpandedId(null); setPage(1)
    const p = new URLSearchParams({ q: query })
    if (f.location)           p.set('location', f.location)
    if (f.remote)             p.set('remote', '1')
    if (f.jobType)            p.set('jobType', f.jobType)
    if (f.datePosted !== 'any') p.set('datePosted', f.datePosted)
    if (f.experience)         p.set('experience', f.experience)
    if (f.salaryMin)          p.set('salaryMin', f.salaryMin)
    if (f.salaryMax)          p.set('salaryMax', f.salaryMax)
    try {
      const res = await fetch(`/api/search/unified?${p}`, { signal: controller.signal })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')
      if (requestId !== searchRequestRef.current) return
      setResults(json.jobs ?? [])
      setMeta(json.meta ?? null)
      lastSearchedRef.current = { q: query.trim(), filters: f }
      saveLast({ q: query.trim(), filters: f, results: json.jobs ?? [], meta: json.meta ?? null })
      addRecent(query.trim())
      setRecent(loadRecent())
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      if (requestId !== searchRequestRef.current) return
      toast.error('Search failed', (e as Error).message)
      setResults([])
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }, [toast])

  // triggerSearch: stable reference used by pill removal callbacks
  const triggerSearch = useCallback((searchQ: string, f: Filters) => {
    runSearch(searchQ, f)
  }, [runSearch])

  const doSearch = () => {
    let searchQ = q.trim()
    let searchFilters = filters

    if (searchQ) {
      const extracted = extractSearchQuery(searchQ)
      if (Object.keys(extracted.filters).length > 0) {
        searchQ = extracted.cleanQ
        searchFilters = { ...DEFAULT_FILTERS, ...extracted.filters }
        setQ(extracted.cleanQ)
        setFilters(searchFilters)
        toast.success('Filters detected', `Using this search's filters: ${Object.entries(extracted.filters).map(([key, value]) => `${key}: ${value}`).join(' · ')}`)
      }
    }
    runSearch(searchQ, searchFilters)
  }

  // Close filter panel and auto-apply if stale
  const toggleFilters = () => {
    if (showFilters && searched && isStale) {
      runSearch(q, filters)
    }
    setShowFilters(v => !v)
  }

  async function handleSave(r: JobResult) {
    setSavingIds(prev => new Set(prev).add(r.id))
    await saveAndScore(r,
      (rid) => { setSavingIds(p => { const n = new Set(p); n.delete(rid); return n }); setSavedIds(p => new Set(p).add(rid)); setScoringIds(p => new Set(p).add(rid)); toast.success('Saved', `${r.company} — scoring match…`); onJobSaved?.() },
      (rid, score) => { setScoringIds(p => { const n = new Set(p); n.delete(rid); return n }); setScores(p => ({ ...p, [rid]: score })) },
      (msg) => { setSavingIds(p => { const n = new Set(p); n.delete(r.id); return n }); toast.error('Save failed', msg) },
    )
  }

  async function handleTranslate(r: JobResult) {
    if (!r.description) return
    setTranslating(prev => new Set(prev).add(r.id))
    try {
      const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: r.description, targetLang: tgtLang }) })
      if (res.ok) { const j = await res.json(); if (j.translated) setTranslated(p => ({ ...p, [r.id]: { text: j.translated, lang: tgtLang } })) }
    } catch {} finally { setTranslating(prev => { const n = new Set(prev); n.delete(r.id); return n }) }
  }

  const sorted     = [...results].sort((a, b) => sortDir === 'desc' ? b.score - a.score : a.score - b.score)
  const start      = (page - 1) * pageSize
  const paged      = sorted.slice(start, start + pageSize)
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 1000, margin: '0 auto', width: '100%' }}>

      {/* ── Search Bar ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: searchFocus ? 'var(--primary)' : 'var(--text-muted)', transition: 'color 0.15s', pointerEvents: 'none', zIndex: 1, display: 'flex' }}>
            <Icon.Search />
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setSearchFocus(false)}
            placeholder='Search jobs — e.g. "React Developer Amsterdam" or "Data Engineer Berlin"'
            style={{
              ...glassInput,
              paddingLeft: 38, paddingRight: 12, height: 44, fontSize: 13,
              borderRadius: 12,
              border: `1.5px solid ${searchFocus ? 'rgba(79,70,229,0.5)' : 'var(--border)'}`,
              boxShadow: searchFocus ? '0 0 0 3px rgba(79,70,229,0.12)' : 'none',
            }}
          />
          {q && (
            <button onClick={() => setQ('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
              <Icon.X />
            </button>
          )}
        </div>

        <button
          onClick={doSearch}
          disabled={searching || !q.trim()}
          style={{
            padding: '0 24px', height: 44,
            background: isStale
              ? 'linear-gradient(135deg, #059669 0%, #047857 100%)'
              : 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            color: '#fff', border: 'none', borderRadius: 12,
            fontSize: 13, fontWeight: 700, cursor: searching ? 'not-allowed' : 'pointer',
            opacity: (!q.trim() || searching) ? 0.65 : 1,
            whiteSpace: 'nowrap', transition: 'all 0.25s',
            boxShadow: isStale ? '0 4px 14px rgba(5,150,105,0.45)' : '0 4px 14px rgba(79,70,229,0.40)',
            display: 'flex', alignItems: 'center', gap: 7,
            animation: isStale && !searching ? 'none' : undefined,
          }}
          onMouseEnter={e => { if (!searching && q.trim()) e.currentTarget.style.boxShadow = isStale ? '0 6px 20px rgba(5,150,105,0.6)' : '0 6px 20px rgba(79,70,229,0.55)' }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = isStale ? '0 4px 14px rgba(5,150,105,0.45)' : '0 4px 14px rgba(79,70,229,0.40)' }}
        >
          {searching
            ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /> Searching…</>
            : isStale
              ? <><Icon.Search /> Apply Filters</>
              : <><Icon.Search /> Search</>
          }
        </button>

        <button
          onClick={toggleFilters}
          style={{
            padding: '0 16px', height: 44, borderRadius: 12, cursor: 'pointer',
            background: showFilters ? 'rgba(79,70,229,0.10)' : 'var(--glass-bg)',
            backdropFilter: 'blur(8px)',
            color: showFilters ? 'var(--primary)' : 'var(--text-muted)',
            border: `1.5px solid ${showFilters ? 'rgba(79,70,229,0.40)' : 'var(--border)'}`,
            fontSize: 12, fontWeight: showFilters ? 600 : 400,
            whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
            transition: 'all 0.15s',
          }}>
          <Icon.Filter />
          Filters
          {hasFilters && <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: 999, fontSize: 9, fontWeight: 700, padding: '1px 5px', minWidth: 16, textAlign: 'center' }}>{activePills.length}</span>}
        </button>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────── */}
      {showFilters && (
        <div style={{
          background: 'var(--glass-card)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--border-glass)', borderRadius: 14, padding: '18px 20px', marginBottom: 12,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14,
          boxShadow: 'var(--shadow-md)',
        }}>
          {[
            { key: 'location', label: 'Location', icon: <Icon.MapPin />, type: 'text', placeholder: 'Amsterdam, Berlin…' },
          ].map(f => (
            <div key={f.key}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                {f.icon}{f.label}
              </label>
              <input style={glassInput} value={filters.location} onChange={e => setFilter('location', e.target.value)} placeholder={f.placeholder} />
            </div>
          ))}

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Briefcase /> Job Type
            </label>
            <select style={{ ...glassInput, height: 36 }} value={filters.jobType} onChange={e => setFilter('jobType', e.target.value)}>
              <option value="">Any type</option>
              <option value="fulltime">Full-time</option>
              <option value="parttime">Part-time</option>
              <option value="contract">Contract</option>
              <option value="internship">Internship</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Calendar /> Date Posted
            </label>
            <select style={{ ...glassInput, height: 36 }} value={filters.datePosted} onChange={e => setFilter('datePosted', e.target.value)}>
              <option value="any">Any time</option>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Star /> Experience
            </label>
            <select style={{ ...glassInput, height: 36 }} value={filters.experience} onChange={e => setFilter('experience', e.target.value)}>
              <option value="">Any level</option>
              <option value="entry">Entry / Junior</option>
              <option value="mid">Mid-level</option>
              <option value="senior">Senior</option>
              <option value="lead">Lead / Manager</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Dollar /> Min Salary (k€)
            </label>
            <input style={glassInput} type="number" min={0} max={500} value={filters.salaryMin} onChange={e => setFilter('salaryMin', e.target.value)} placeholder="e.g. 50" />
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Dollar /> Max Salary (k€)
            </label>
            <input style={glassInput} type="number" min={0} max={500} value={filters.salaryMax} onChange={e => setFilter('salaryMax', e.target.value)} placeholder="e.g. 120" />
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Home /> Remote
            </label>
            <button
              onClick={() => setFilter('remote', !filters.remote)}
              style={{
                width: '100%', height: 36, borderRadius: 9, border: `1.5px solid ${filters.remote ? 'rgba(5,150,105,0.5)' : 'var(--border)'}`,
                background: filters.remote ? 'rgba(5,150,105,0.10)' : 'var(--glass-bg)',
                color: filters.remote ? '#059669' : 'var(--text-muted)',
                fontSize: 12, fontWeight: filters.remote ? 600 : 400, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'all 0.15s',
              }}>
              {filters.remote ? <><Icon.Home />Remote only</> : 'Any location'}
            </button>
          </div>

          {hasFilters && (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setFilters(DEFAULT_FILTERS)}
                style={{
                  height: 36, borderRadius: 9, border: '1.5px solid rgba(220,38,38,0.35)',
                  background: 'rgba(220,38,38,0.06)', color: '#DC2626',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  transition: 'all 0.15s',
                }}>
                <Icon.Trash /> Clear all
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Active filter pills ───────────────────────────────────── */}
      {activePills.length > 0 && !showFilters && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {activePills.map(p => (
            <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500, padding: '4px 10px', borderRadius: 999, background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', border: '1px solid rgba(79,70,229,0.20)' }}>
              {p.icon} {p.label}
              <button onClick={p.onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', display: 'flex', lineHeight: 1 }}>
                <Icon.X />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Recent searches ───────────────────────────────────────── */}
      {!searched && recent.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Icon.Clock /> Recent:
          </span>
          {recent.slice(0, 6).map(s => (
            <button key={s} onClick={() => { setQ(s); setFilters(DEFAULT_FILTERS); runSearch(s, DEFAULT_FILTERS) }}
              style={{ fontSize: 11, padding: '4px 11px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--glass-bg)', backdropFilter: 'blur(8px)', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.13s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(79,70,229,0.35)'; e.currentTarget.style.color = 'var(--primary)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
              {s}
            </button>
          ))}
          <button
            onClick={() => { clearHistory(); setRecent([]); setQ(''); setResults([]); setMeta(null); setSearched(false); setFilters(DEFAULT_FILTERS) }}
            style={{ fontSize: 10, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon.Trash /> Clear
          </button>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────── */}
      {searched && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {searching ? (
            /* Loading state */
            <div style={{ padding: '60px 24px', textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <div style={{ position: 'relative', width: 52, height: 52 }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '3px solid rgba(79,70,229,0.12)', borderTopColor: 'var(--primary)', animation: 'spin 0.8s linear infinite' }} />
                <div style={{ position: 'absolute', inset: 6, borderRadius: '50%', border: '2px solid rgba(124,58,237,0.10)', borderBottomColor: '#7C3AED', animation: 'spin 1.2s linear infinite reverse' }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}><Icon.Zap /></div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Searching across 14 job sources…</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI routing to best sources for your query</div>
            </div>
          ) : results.length === 0 ? (
            /* No results */
            <div style={{ padding: 60, textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(79,70,229,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.Search />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>No jobs found</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65 }}>
                Try broader keywords, a different location, or remove some filters.
              </div>
              {/* API key diagnostic — shown when keys are missing */}
              {meta?.apiKeys && !meta.apiKeys.rapidapi && (
                <div style={{ marginTop: 8, padding: '10px 16px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: 8, maxWidth: 340, textAlign: 'left' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#b45309', marginBottom: 4 }}>⚠ 搜索 API 未配置</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    LinkedIn、Indeed、JSearch 等付费源需要 <code style={{ fontSize: 10, background: 'rgba(0,0,0,0.07)', padding: '1px 4px', borderRadius: 3 }}>RAPIDAPI_KEY</code> 环境变量。
                    当前仅 Remotive 等免费源可用。
                  </div>
                </div>
              )}
              {meta?.routing && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6 }}>
                  路由：{meta.routing} · {meta.durationMs}ms
                </div>
              )}
            </div>
          ) : (
            <>
              {/* ── Meta bar ── */}
              {meta && (
                <div style={{
                  padding: '10px 16px', marginBottom: 10,
                  background: 'var(--glass-card)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                  border: '1px solid var(--border-glass)', borderRadius: 12,
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{results.length} jobs found</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>·</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {meta.sourcesUsed.map(s => SOURCE_STYLE[s]?.label ?? s).join(' · ')}
                  </span>
                  {/* Region routing badge */}
                  {meta.routing && (() => {
                    const flag = parseRoutingFlag(meta.routing)
                    // Extract region label: "IE → ..." or "Ireland → ..." or "远程 → ..."
                    const m = meta.routing.match(/^(Ireland|[A-Z]{2}|Remote|[^\s→]+)/)
                    const label = m?.[1]?.trim() ?? ''
                    const display = flag || label
                    if (!display) return null
                    return (
                      <span title={meta.routing} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', border: '1px solid rgba(79,70,229,0.15)', cursor: 'help' }}>
                        {display}
                      </span>
                    )
                  })()}
                  {meta.salaryContext && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#059669', fontWeight: 600, marginLeft: 'auto' }}>
                      <Icon.Dollar />
                      {meta.salaryContext.currency === 'EUR' ? '€' : meta.salaryContext.currency === 'GBP' ? '£' : '$'}{Math.round(meta.salaryContext.median / 1000)}k median
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--text-subtle)', marginLeft: meta.salaryContext ? 0 : 'auto' }}>{meta.durationMs}ms{meta.cached ? ' · cached' : ''}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Score:</span>
                    <button onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')} style={{ fontSize: 10, padding: '3px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--glass-bg)', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                      {sortDir === 'desc' ? <><Icon.ChevronDown /> High first</> : <><Icon.ChevronUp /> Low first</>}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Skills cloud ── */}
              {meta?.topSkills?.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-subtle)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Trending skills:</span>
                  {meta.topSkills.slice(0, 10).map(sk => (
                    <span key={sk} style={{ fontSize: 10, padding: '3px 10px', borderRadius: 999, background: 'rgba(79,70,229,0.07)', color: 'var(--primary)', border: '1px solid rgba(79,70,229,0.14)', fontWeight: 500 }}>{sk}</span>
                  ))}
                </div>
              ) : null}

              {/* ── Job cards ── */}
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {paged.map(r => {
                  const src = SOURCE_STYLE[r.source] ?? { label: r.source, color: '#888', bg: 'rgba(100,100,100,0.10)' }
                  const exp = expandedId === r.id
                  const jt  = r.jobType ? JOB_TYPE_COLOR[r.jobType] : null
                  const wa  = r.workArrangement ? WA_CONFIG[r.workArrangement] : null

                  return (
                    <div
                      key={`${r.source}-${r.id}`}
                      onClick={() => setExpandedId(exp ? null : r.id)}
                      style={{
                        padding: exp ? '18px 20px' : '14px 18px',
                        display: 'flex', alignItems: exp ? 'flex-start' : 'center', gap: 14,
                        borderRadius: 14,
                        background: exp ? 'var(--glass-bg)' : 'var(--glass-card)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: exp
                          ? '1.5px solid rgba(79,70,229,0.25)'
                          : '1px solid var(--border-glass)',
                        cursor: 'pointer',
                        transition: 'all 0.18s',
                        boxShadow: exp ? 'var(--shadow-md)' : 'var(--shadow-sm)',
                      }}
                      onMouseEnter={e => { if (!exp) { e.currentTarget.style.border = '1px solid rgba(79,70,229,0.20)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)' } }}
                      onMouseLeave={e => { if (!exp) { e.currentTarget.style.border = '1px solid var(--border-glass)'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)' } }}
                    >
                      {/* Company logo */}
                      <CompanyLogo logo={r.logo || r.company.slice(0, 2).toUpperCase()} size={exp ? 40 : 34} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Row 1: Title + badges */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
                          <span style={{ fontSize: exp ? 15 : 13, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3, flex: 1, minWidth: 0 }}>
                            {r.title}
                          </span>
                          {jt && <Badge color={jt.color} bg={jt.bg}>{r.jobType}</Badge>}
                          {r.directApply && <Badge color="#7C3AED" bg="rgba(124,58,237,0.10)" style={{ gap: 4 }}><Icon.Rocket />Direct Apply</Badge>}
                        </div>

                        {/* Row 2: Company · location · WA · time · source */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{r.company}</span>
                          {r.location && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <Icon.MapPin />{r.location}
                            </span>
                          )}
                          {wa && <Badge color={wa.color} bg={wa.bg}>{wa.icon} {wa.label}</Badge>}
                          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
                            {r.postedAt && <><Icon.Clock />{fmtPosted(r.postedAt)}</>}
                          </span>
                          <Badge color={src.color} bg={src.bg}>{src.label}</Badge>
                        </div>

                        {/* Row 3: Salary + level + skills */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {r.salary && (
                            <Badge color="#059669" bg="rgba(5,150,105,0.10)">
                              <Icon.Dollar /> {r.salary}
                            </Badge>
                          )}
                          {r.seniority && (
                            <Badge color="var(--text-muted)" bg="var(--bg-secondary)">{r.seniority}</Badge>
                          )}
                          {r.keySkills?.slice(0, exp ? 12 : 4).map(sk => (
                            <span key={sk} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(79,70,229,0.07)', color: 'var(--primary)', border: '1px solid rgba(79,70,229,0.12)' }}>{sk}</span>
                          ))}
                          {!exp && (r.keySkills?.length ?? 0) > 4 && (
                            <span style={{ fontSize: 10, color: 'var(--text-subtle)' }}>+{(r.keySkills?.length ?? 0) - 4}</span>
                          )}
                        </div>

                        {/* Expanded panel */}
                        {exp && (
                          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>

                            {/* Meta chips */}
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                              {r.postedAt && <Badge color="var(--text-muted)" bg="var(--bg-secondary)"><Icon.Clock /> {fmtPosted(r.postedAt)}</Badge>}
                              {r.experienceLevel && <Badge color="var(--text-muted)" bg="var(--bg-secondary)"><Icon.Star /> {r.experienceLevel} yrs</Badge>}
                              {jt && <Badge color={jt.color} bg={jt.bg}><Icon.Briefcase /> {r.jobType}</Badge>}
                              {r.seniority && <Badge color="var(--text-muted)" bg="var(--bg-secondary)">{r.seniority}</Badge>}
                              {wa && <Badge color={wa.color} bg={wa.bg}>{wa.icon} {wa.label}</Badge>}
                              {r.directApply && <Badge color="#7C3AED" bg="rgba(124,58,237,0.10)"><Icon.Rocket /> Direct Apply</Badge>}
                              <Badge color={src.color} bg={src.bg}>{src.label}</Badge>
                            </div>

                            {/* All skills */}
                            {r.keySkills?.length ? (
                              <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>Required Skills</div>
                                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                  {r.keySkills.map(sk => (
                                    <span key={sk} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', border: '1px solid rgba(79,70,229,0.15)', fontWeight: 500 }}>{sk}</span>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {/* Description */}
                            <div style={{ marginBottom: 14 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Job Description</span>
                                {r.description && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
                                    <select
                                      value={tgtLang} onChange={e => setTgtLang(e.target.value)} onClick={e => e.stopPropagation()}
                                      style={{ fontSize: 10, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--glass-bg)', color: 'var(--text-muted)' }}>
                                      {['de','en','fr','es','nl','zh','ja'].map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
                                    </select>
                                    <button
                                      onClick={e => { e.stopPropagation(); handleTranslate(r) }}
                                      disabled={translating.has(r.id)}
                                      style={{ fontSize: 10, padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--glass-bg)', color: 'var(--primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <Icon.Globe /> {translating.has(r.id) ? 'Translating…' : 'Translate'}
                                    </button>
                                  </div>
                                )}
                              </div>

                              {r.description ? (() => {
                                const text = translated[r.id]?.text ?? r.description
                                const isExp = descExp.has(r.id)
                                const long = text.length > 400
                                return (
                                  <>
                                    <div style={{ fontSize: 13, lineHeight: 1.78, color: 'var(--text)', whiteSpace: 'pre-wrap', background: 'var(--bg-secondary)', borderRadius: 10, padding: '14px 16px', maxHeight: isExp ? 'none' : 220, overflow: isExp ? 'visible' : 'hidden', position: 'relative' }}>
                                      {text}
                                      {!isExp && long && (
                                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 64, background: 'linear-gradient(transparent, var(--bg-secondary))' }} />
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
                                      {long && (
                                        <button
                                          onClick={e => { e.stopPropagation(); setDescExp(prev => { const n = new Set(prev); isExp ? n.delete(r.id) : n.add(r.id); return n }) }}
                                          style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.20)', borderRadius: 7, cursor: 'pointer', padding: '4px 11px', display: 'flex', alignItems: 'center', gap: 4 }}>
                                          {isExp ? <><Icon.ChevronUp />Show less</> : <><Icon.ChevronDown />Show more</>}
                                        </button>
                                      )}
                                      <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, marginLeft: long ? 0 : 'auto' }}>
                                        <Icon.ExternalLink /> View original
                                      </a>
                                    </div>
                                  </>
                                )
                              })() : (
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 10, textAlign: 'center' }}>
                                  No description — <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'var(--primary)' }}>view original ↗</a>
                                </div>
                              )}
                            </div>

                            {/* Hiring manager */}
                            {r.hiringManager && (
                              <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(236,72,153,0.06)', border: '1px solid rgba(236,72,153,0.18)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ color: '#EC4899' }}><Icon.User /></span>
                                <div style={{ fontSize: 12 }}>
                                  <strong style={{ color: 'var(--text)' }}>{r.hiringManager.name}</strong>
                                  <span style={{ color: 'var(--text-muted)' }}> · {r.hiringManager.title}</span>
                                  {r.hiringManager.email && <> · <a href={`mailto:${r.hiringManager.email}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{r.hiringManager.email}</a></>}
                                </div>
                              </div>
                            )}

                            {/* Actions */}
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                              <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 22px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', borderRadius: 10, fontSize: 13, fontWeight: 700, textDecoration: 'none', boxShadow: '0 4px 14px rgba(79,70,229,0.40)' }}>
                                <Icon.ExternalLink /> View Job Posting
                              </a>

                              {savedIds.has(r.id) ? (
                                scores[r.id] !== undefined
                                  ? <ScorePill score={scores[r.id]} />
                                  : <Badge color="#059669" bg="rgba(5,150,105,0.12)">✓ Saved</Badge>
                              ) : (
                                <button
                                  onClick={e => { e.stopPropagation(); handleSave(r) }}
                                  disabled={savingIds.has(r.id)}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', border: '1.5px solid var(--border)', borderRadius: 10, background: 'var(--glass-bg)', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600, cursor: savingIds.has(r.id) ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}
                                  onMouseEnter={e => { if (!savingIds.has(r.id)) { e.currentTarget.style.borderColor = 'rgba(79,70,229,0.35)'; e.currentTarget.style.color = 'var(--primary)' } }}
                                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                                  {savingIds.has(r.id)
                                    ? <><span style={{ width: 13, height: 13, border: '2px solid rgba(79,70,229,0.2)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />Saving…</>
                                    : <>{Icon.Bookmark()}Save to Tracker</>}
                                </button>
                              )}

                              {scoringIds.has(r.id) && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <span style={{ width: 12, height: 12, border: '2px solid rgba(79,70,229,0.18)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />
                                  AI scoring match…
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Collapsed right actions */}
                      {!exp && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                          {/* Score if available */}
                          {scores[r.id] !== undefined && <ScorePill score={scores[r.id]} />}
                          {scoringIds.has(r.id) && <span style={{ width: 10, height: 10, border: '1.5px solid rgba(79,70,229,0.18)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />}

                          {/* View button */}
                          <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="View job posting" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', textDecoration: 'none', boxShadow: '0 3px 10px rgba(79,70,229,0.35)', transition: 'all 0.15s' }}>
                            <Icon.ExternalLink />
                          </a>

                          {/* Save button */}
                          {!savedIds.has(r.id) && (
                            <button onClick={e => { e.stopPropagation(); handleSave(r) }} disabled={savingIds.has(r.id)} title="Save to tracker" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--glass-bg)', color: 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.15s' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(79,70,229,0.35)'; e.currentTarget.style.color = 'var(--primary)' }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                              {savingIds.has(r.id)
                                ? <span style={{ width: 12, height: 12, border: '2px solid rgba(79,70,229,0.2)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />
                                : Icon.Bookmark()}
                            </button>
                          )}
                          {savedIds.has(r.id) && scores[r.id] === undefined && !scoringIds.has(r.id) && (
                            <span title="Saved" style={{ color: '#059669', display: 'flex' }}>✓</span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* ── Pagination ── */}
                {results.length > pageSize && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
                    padding: '12px 16px', borderTop: '1px solid var(--border)',
                    background: 'var(--glass-card)', backdropFilter: 'blur(12px)',
                    borderRadius: 12, marginTop: 4,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {start + 1}–{Math.min(start + pageSize, results.length)} of {results.length}
                      </span>
                      <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
                        style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--glass-bg)', color: 'var(--text)', cursor: 'pointer' }}>
                        <option value={20}>20 / page</option>
                        <option value={50}>50 / page</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', gap: 4 }}>
                      {[{ label: '«', action: () => setPage(1), disabled: page <= 1 },
                        { label: '‹', action: () => setPage(p => p - 1), disabled: page <= 1 },
                        ...(() => { const btns = []; for (let p = Math.max(1, page-2); p <= Math.min(totalPages, page+2); p++) btns.push(p); return btns })()
                          .map(p => ({ label: String(p), action: () => setPage(p), disabled: false, current: p === page })),
                        { label: '›', action: () => setPage(p => p + 1), disabled: page >= totalPages },
                        { label: '»', action: () => setPage(totalPages), disabled: page >= totalPages },
                      ].map((btn, i) => (
                        <button key={i} onClick={btn.action} disabled={btn.disabled} style={{
                          minWidth: 30, height: 30, padding: '0 6px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                          border: '1px solid var(--border)',
                          background: (btn as { current?: boolean }).current ? 'rgba(79,70,229,0.12)' : 'var(--glass-bg)',
                          color: btn.disabled ? 'var(--text-subtle)' : (btn as { current?: boolean }).current ? 'var(--primary)' : 'var(--text-muted)',
                          cursor: btn.disabled ? 'default' : 'pointer', transition: 'all 0.12s',
                        }}>{btn.label}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────── */}
      {!searched && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: '40px 24px' }}>
          {/* Hero icon */}
          <div style={{ width: 80, height: 80, borderRadius: 24, background: 'linear-gradient(135deg, rgba(79,70,229,0.12) 0%, rgba(124,58,237,0.08) 100%)', border: '1px solid rgba(79,70,229,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
            <Icon.Cpu />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', marginBottom: 8, letterSpacing: '-0.02em' }}>AI-Powered Job Search</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.75, maxWidth: 420 }}>
              Search <strong>14 European job boards</strong> simultaneously — LinkedIn, Indeed, Adzuna, StepStone & more.
              AI routes your query, deduplicates results, and scores each job against your resume.
            </div>
          </div>

          {/* Source badges */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 480 }}>
            {Object.values(SOURCE_STYLE).map(s => (
              <span key={s.label} style={{ fontSize: 10, padding: '3px 10px', borderRadius: 999, background: s.bg, color: s.color, fontWeight: 600 }}>{s.label}</span>
            ))}
          </div>

          {/* Quick search suggestions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {['Software Engineer Amsterdam', 'React Developer Berlin', 'Data Engineer Remote', 'Product Manager London'].map(s => (
              <button key={s} onClick={() => { setQ(s); setTimeout(() => inputRef.current?.focus(), 50) }}
                style={{ fontSize: 12, padding: '7px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--glass-bg)', backdropFilter: 'blur(8px)', color: 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.13s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(79,70,229,0.35)'; e.currentTarget.style.color = 'var(--primary)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
