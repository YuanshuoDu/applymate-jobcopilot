'use client'

import React, { useState, useCallback } from 'react'
import { Btn, CompanyLogo, INPUT_STYLE, ScorePill, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { Job, ResumeListItem } from '@/lib/types'

// ── Shared types ──────────────────────────────────────────────────────────────

export type JobSource = 'adzuna' | 'jsearch' | 'linkedin' | 'jobicy'

export interface JobResult {
  id:          string
  title:       string
  company:     string
  location:    string
  salary?:     string
  description: string
  url:         string
  postedAt?:   string | null
  jobType?:    string | null
  source:      JobSource
}

// ── Shared save + AI score logic ──────────────────────────────────────────────

async function saveAndScore(
  r: JobResult,
  onSaved:   (id: string, jobDbId: string) => void,
  onScored:  (id: string, score: number)   => void,
  onError:   (msg: string)                 => void,
) {
  const { data: job, error } = await apiMutate<Job>('/api/jobs', 'POST', {
    company:     r.company,
    role:        r.title,
    location:    r.location,
    url:         r.url,
    salary:      r.salary ?? null,
    description: r.description,
    source:      r.source,
    status:      'saved',
  })
  if (error || !job) { onError(error ?? 'Save failed'); return }
  onSaved(r.id, job.id)

  if (!r.description) return
  try {
    const listRes = await fetch('/api/resume')
    if (!listRes.ok) return
    const resumes: ResumeListItem[] = await listRes.json()
    if (!resumes.length) return
    const pick      = resumes.find(rv => rv.isDefault) ?? resumes[0]
    const resumeRes = await fetch(`/api/resume/${pick.id}`)
    if (!resumeRes.ok) return
    const full = await resumeRes.json()
    if (!full?.content) return

    const desc = r.description.slice(0, 2000)
    const scoreRes = await fetch('/api/ai/score', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeContent: full.content, jobTitle: r.title, jobDescription: desc }),
    })
    if (!scoreRes.ok) return
    const sd = await scoreRes.json() as { score: number; matchedKeywords: string[]; missingKeywords: string[] }
    const matched = sd.matchedKeywords?.join(', ') || '—'
    const missing = sd.missingKeywords?.join(', ') || '—'
    await apiMutate(`/api/jobs/${job.id}`, 'PATCH', {
      score:        sd.score,
      analysisNote: `Match Score: ${sd.score}%\n\nMatched: ${matched}\n\nMissing: ${missing}`,
    })
    onScored(r.id, sd.score)
  } catch { /* score is best-effort */ }
}

// ── Shared job card ───────────────────────────────────────────────────────────

function fmtPosted(iso?: string | null): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7)  return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

const SOURCE_BADGE: Record<JobSource, { label: string; color: string }> = {
  adzuna:   { label: 'Adzuna',   color: '#854F0B' },
  jsearch:  { label: 'JSearch',  color: '#185FA5' },
  linkedin: { label: 'LinkedIn', color: '#0077B5' },
  jobicy:   { label: 'Jobicy',   color: '#3B6D11' },
}

function JobCard({
  r, saving, saved, scoring, score, showSource, onSave,
}: {
  r:          JobResult
  saving:     boolean
  saved:      boolean
  scoring:    boolean
  score?:     number
  showSource: boolean
  onSave:     () => void
}) {
  const badge = SOURCE_BADGE[r.source]
  return (
    <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: '0.5px solid var(--border)', background: 'var(--bg)' }}>
      <CompanyLogo logo={r.company.slice(0, 2).toUpperCase()} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{r.title}</span>
          {r.jobType && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
              {r.jobType.slice(0, 20)}
            </span>
          )}
          {showSource && (
            <span style={{ fontSize: 9, color: badge.color, background: `${badge.color}14`, borderRadius: 4, padding: '1px 6px', fontWeight: 500 }}>
              {badge.label}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {r.company}{r.location ? ` · ${r.location}` : ''}
          {r.postedAt && <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.65 }}>{fmtPosted(r.postedAt)}</span>}
        </div>
        {r.salary && <div style={{ fontSize: 11, color: '#3B6D11', marginTop: 2 }}>{r.salary}</div>}
        {r.description && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{r.description}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
        {saved ? (
          scoring ? (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, border: '1.5px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />
              Scoring…
            </span>
          ) : score !== undefined ? (
            <ScorePill score={score} />
          ) : (
            <span style={{ fontSize: 10, color: '#3B6D11', fontWeight: 500 }}>✓ Saved</span>
          )
        ) : (
          <Btn small variant="primary" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : '+ Save'}
          </Btn>
        )}
        <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#185FA5', textDecoration: 'none' }}>
          View ↗
        </a>
      </div>
    </div>
  )
}

// ── Generic source panel ──────────────────────────────────────────────────────

interface SourcePanelProps {
  fetchJobs:   (params: Record<string, string>, page: number) => Promise<{ jobs: JobResult[]; total: number }>
  formFields:  React.ReactNode
  placeholder: string
  q:           string
  onJobSaved?: () => void
  showSource?: boolean
}

function SourcePanel({ fetchJobs, formFields, placeholder, q: qProp, onJobSaved, showSource = false }: SourcePanelProps) {
  const toast = useToast()
  const [searching,   setSearching  ] = useState(false)
  const [loadingMore, setLoadingMore ] = useState(false)
  const [results,     setResults    ] = useState<JobResult[]>([])
  const [total,       setTotal      ] = useState(0)
  const [page,        setPage       ] = useState(1)
  const [searched,    setSearched   ] = useState(false)
  const [savingIds,   setSavingIds  ] = useState<Set<string>>(new Set())
  const [savedIds,    setSavedIds   ] = useState<Set<string>>(new Set())
  const [scoringIds,  setScoringIds ] = useState<Set<string>>(new Set())
  const [scores,      setScores     ] = useState<Record<string, number>>({})
  const [formState,   setFormState  ] = useState<Record<string, string>>({})

  async function doSearch(pg: number, append = false) {
    const { jobs, total: t } = await fetchJobs(formState, pg)
    setResults(prev => {
      if (!append) return jobs
      const seen = new Set(prev.map(j => j.id))
      return [...prev, ...jobs.filter(j => !seen.has(j.id))]
    })
    setTotal(t)
    return jobs.length
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!qProp.trim()) return
    setSearching(true); setSearched(true); setPage(1); setSavedIds(new Set()); setScores({})
    try { await doSearch(1, false) }
    catch (ex) { toast.error('Search failed', (ex as Error).message); setResults([]) }
    finally    { setSearching(false) }
  }

  async function handleLoadMore() {
    const next = page + 1; setPage(next); setLoadingMore(true)
    try { await doSearch(next, true) }
    catch { toast.error('Load more failed', '') }
    finally { setLoadingMore(false) }
  }

  async function handleSave(r: JobResult) {
    setSavingIds(prev => new Set(prev).add(r.id))
    await saveAndScore(
      r,
      (rid) => {
        setSavingIds(prev => { const n = new Set(prev); n.delete(rid); return n })
        setSavedIds(prev => new Set(prev).add(rid))
        setScoringIds(prev => new Set(prev).add(rid))
        toast.success('Job saved', `${r.title} at ${r.company} — scoring…`)
        onJobSaved?.()
      },
      (rid, score) => {
        setScoringIds(prev => { const n = new Set(prev); n.delete(rid); return n })
        setScores(prev => ({ ...prev, [rid]: score }))
        toast.success('Match scored', `${r.company}: ${score}% match`)
      },
      (msg) => {
        setSavingIds(prev => { const n = new Set(prev); n.delete(r.id); return n })
        toast.error('Save failed', msg)
      },
    )
  }

  // Expose formState setter to children via context-like pattern
  const updateForm = useCallback((key: string, val: string) => {
    setFormState(prev => ({ ...prev, [key]: val }))
  }, [])

  return (
    <FormStateContext.Provider value={{ formState, updateForm }}>
      <form onSubmit={handleSearch} style={{ padding: '0 0 16px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {formFields}
        <button type="submit" disabled={searching || !qProp.trim()} style={{
          padding: '8px 18px', background: '#185FA5', color: '#fff', border: 'none', borderRadius: 6,
          fontSize: 12, fontWeight: 500, cursor: searching ? 'not-allowed' : 'pointer', opacity: searching ? 0.7 : 1, whiteSpace: 'nowrap',
        }}>
          {searching ? 'Searching…' : 'Search'}
        </button>
        {searched && !searching && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
            {total.toLocaleString()} results
          </span>
        )}
      </form>

      {searched && (
        <div style={{ borderTop: '0.5px solid var(--border)', flex: 1, display: 'flex', flexDirection: 'column' }}>
          {searching ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ width: 22, height: 22, border: '2px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 10px' }} />
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Searching {placeholder}…</div>
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              No jobs found. Try different keywords or a broader location.
            </div>
          ) : (
            <>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {results.map(r => (
                  <JobCard
                    key={r.id} r={r}
                    saving={savingIds.has(r.id)} saved={savedIds.has(r.id)}
                    scoring={scoringIds.has(r.id)} score={scores[r.id]}
                    showSource={showSource}
                    onSave={() => handleSave(r)}
                  />
                ))}
              </div>
              {results.length < total && (
                <div style={{ padding: '12px 16px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Showing {results.length} of {total.toLocaleString()}</span>
                  <Btn small variant="ghost" disabled={loadingMore} onClick={handleLoadMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Btn>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </FormStateContext.Provider>
  )
}

// ── Form state context ────────────────────────────────────────────────────────

const FormStateContext = React.createContext<{
  formState:  Record<string, string>
  updateForm: (key: string, val: string) => void
}>({ formState: {}, updateForm: () => {} })

function useFormField(key: string, initial = '') {
  const { formState, updateForm } = React.useContext(FormStateContext)
  const value = formState[key] ?? initial
  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => updateForm(key, e.target.value)
  return { value, onChange }
}

// ── Field components ──────────────────────────────────────────────────────────

const labelSt: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }

function TextField({ fieldKey, label, placeholder, flex = '2 1 200px' }: { fieldKey: string; label: string; placeholder: string; flex?: string }) {
  const { value, onChange } = useFormField(fieldKey)
  return (
    <div style={{ flex }}>
      <label style={labelSt}>{label}</label>
      <input style={INPUT_STYLE} value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  )
}

function SelectField({ fieldKey, label, options, width = 120 }: { fieldKey: string; label: string; options: { value: string; label: string }[]; width?: number }) {
  const { value, onChange } = useFormField(fieldKey)
  return (
    <div style={{ width }}>
      <label style={labelSt}>{label}</label>
      <select style={INPUT_STYLE} value={value} onChange={onChange}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// ── Source definitions ────────────────────────────────────────────────────────

const COUNTRIES_ADZUNA = [
  { code: 'gb', label: '🇬🇧 UK' }, { code: 'de', label: '🇩🇪 DE' },
  { code: 'fr', label: '🇫🇷 FR' }, { code: 'nl', label: '🇳🇱 NL' },
  { code: 'es', label: '🇪🇸 ES' }, { code: 'it', label: '🇮🇹 IT' },
  { code: 'at', label: '🇦🇹 AT' }, { code: 'be', label: '🇧🇪 BE' },
  { code: 'pl', label: '🇵🇱 PL' }, { code: 'us', label: '🇺🇸 US' },
  { code: 'ca', label: '🇨🇦 CA' }, { code: 'au', label: '🇦🇺 AU' },
]

const JOB_TYPES_ADZUNA = [
  { value: '', label: 'Any' }, { value: 'fulltime', label: 'Full-time' },
  { value: 'parttime', label: 'Part-time' }, { value: 'contract', label: 'Contract' },
]

const EMP_TYPES_JSEARCH = [
  { value: '', label: 'Any' }, { value: 'FULLTIME', label: 'Full-time' },
  { value: 'PARTTIME', label: 'Part-time' }, { value: 'CONTRACTOR', label: 'Contract' },
  { value: 'INTERN', label: 'Internship' },
]

const GEO_JOBICY = [
  { value: '', label: 'Anywhere' }, { value: 'usa', label: '🇺🇸 USA' },
  { value: 'europe', label: '🌍 Europe' }, { value: 'uk', label: '🇬🇧 UK' },
  { value: 'germany', label: '🇩🇪 Germany' }, { value: 'netherlands', label: '🇳🇱 Netherlands' },
  { value: 'worldwide', label: '🌐 Worldwide' },
]

// ── Main unified component ────────────────────────────────────────────────────

const SOURCES: { id: JobSource; label: string; desc: string; color: string }[] = [
  { id: 'adzuna',   label: '🌍 Adzuna',   desc: '欧洲 12 国本地职位（默认）',   color: '#854F0B' },
  { id: 'jsearch',  label: '🔍 JSearch',  desc: '聚合 LinkedIn · Indeed · 等',  color: '#185FA5' },
  { id: 'linkedin', label: '💼 LinkedIn', desc: '最近 1 小时实时新职位',        color: '#0077B5' },
  { id: 'jobicy',   label: '🌐 Jobicy',   desc: '远程职位，完全免费',           color: '#3B6D11' },
]

interface Props {
  onJobSaved?: () => void
}

export function UnifiedJobSearch({ onJobSaved }: Props) {
  const [source, setSource] = useState<JobSource>('adzuna')

  // Shared q state (carried across tab switches)
  const [q, setQ] = useState('')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Source tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '0.5px solid var(--border)' }}>
        {SOURCES.map(s => (
          <button key={s.id} onClick={() => setSource(s.id)} style={{
            padding: '8px 16px', border: 'none', borderBottom: source === s.id ? `2px solid ${s.color}` : '2px solid transparent',
            background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: source === s.id ? 600 : 400,
            color: source === s.id ? s.color : 'var(--text-muted)', whiteSpace: 'nowrap',
          }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Shared keyword input */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 4 }}>
        <div style={{ flex: '2 1 220px' }}>
          <label style={labelSt}>Keywords *</label>
          <input style={INPUT_STYLE} value={q} onChange={e => setQ(e.target.value)}
            placeholder={source === 'jobicy' ? 'e.g. Python, React, DevOps' : 'e.g. Software Engineer, Product Manager'}
            onKeyDown={e => { if (e.key === 'Enter') { const form = (e.target as HTMLElement).closest('form'); form?.requestSubmit() } }}
          />
        </div>
        {/* Source-specific extra fields + submit rendered per-panel below */}
      </div>

      {/* Per-source panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {source === 'adzuna'   && <AdzunaPanel   q={q} onJobSaved={onJobSaved} />}
        {source === 'jsearch'  && <JSearchPanel  q={q} onJobSaved={onJobSaved} />}
        {source === 'linkedin' && <LinkedInPanel q={q} onJobSaved={onJobSaved} />}
        {source === 'jobicy'   && <JobicyPanel   q={q} onJobSaved={onJobSaved} />}
      </div>
    </div>
  )
}

// ── Per-source panel wrappers ─────────────────────────────────────────────────

function AdzunaPanel({ q, onJobSaved }: { q: string; onJobSaved?: () => void }) {
  const fetch_ = useCallback(async (fs: Record<string, string>, page: number) => {
    const p = new URLSearchParams({ q, page: String(page) })
    if (fs.where)    p.set('where', fs.where)
    if (fs.country)  p.set('country', fs.country || 'gb')
    if (fs.jobType)  p.set('job_type', fs.jobType)
    const res  = await fetch(`/api/adzuna/search?${p}`)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Search failed')
    return { jobs: (json.jobs ?? []).map((j: JobResult) => ({ ...j, source: 'adzuna' as const })), total: json.total ?? 0 }
  }, [q])

  return (
    <SourcePanel
      fetchJobs={fetch_} q={q} placeholder="Adzuna" onJobSaved={onJobSaved}
      formFields={<>
        <TextField fieldKey="where"   label="Location"    placeholder="e.g. Berlin, London" flex="1 1 140px" />
        <SelectField fieldKey="country" label="Country"   options={COUNTRIES_ADZUNA.map(c => ({ value: c.code, label: c.label }))} width={100} />
        <SelectField fieldKey="jobType" label="Type"      options={JOB_TYPES_ADZUNA.map(o => ({ value: o.value, label: o.label }))} width={120} />
      </>}
    />
  )
}

function JSearchPanel({ q, onJobSaved }: { q: string; onJobSaved?: () => void }) {
  const fetch_ = useCallback(async (fs: Record<string, string>, page: number) => {
    const p = new URLSearchParams({ q, page: String(page) })
    if (fs.location)    p.set('location', fs.location)
    if (fs.empType)     p.set('employment_type', fs.empType)
    if (fs.remote === '1') p.set('remote', '1')
    const res  = await fetch(`/api/jsearch/search?${p}`)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Search failed')
    return { jobs: json.jobs ?? [], total: json.total ?? 0 }
  }, [q])

  return (
    <SourcePanel
      fetchJobs={fetch_} q={q} placeholder="JSearch" onJobSaved={onJobSaved}
      formFields={<>
        <TextField fieldKey="location" label="Location" placeholder="e.g. London, Berlin, Remote" flex="1 1 140px" />
        <SelectField fieldKey="empType" label="Type"    options={EMP_TYPES_JSEARCH.map(o => ({ value: o.value, label: o.label }))} width={120} />
        <SelectField fieldKey="remote"  label="Remote"  options={[{ value: '', label: 'Any' }, { value: '1', label: 'Remote only' }]} width={110} />
      </>}
    />
  )
}

function JobicyPanel({ q, onJobSaved }: { q: string; onJobSaved?: () => void }) {
  const fetch_ = useCallback(async (fs: Record<string, string>) => {
    const p = new URLSearchParams({ q })
    if (fs.geo)      p.set('geo', fs.geo)
    if (fs.industry) p.set('industry', fs.industry)
    const res  = await fetch(`/api/jobicy/search?${p}`)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Search failed')
    return { jobs: json.jobs ?? [], total: json.total ?? 0 }
  }, [q])

  return (
    <SourcePanel
      fetchJobs={fetch_} q={q} placeholder="Jobicy" onJobSaved={onJobSaved}
      formFields={<>
        <SelectField fieldKey="geo"      label="Region"   options={GEO_JOBICY.map(o => ({ value: o.value, label: o.label }))} width={140} />
        <TextField  fieldKey="industry" label="Industry" placeholder="e.g. Software, Design" flex="1 1 140px" />
      </>}
    />
  )
}

function LinkedInPanel({ q, onJobSaved }: { q: string; onJobSaved?: () => void }) {
  const fetch_ = useCallback(async (fs: Record<string, string>, page: number) => {
    const p = new URLSearchParams({ q, page: String(page) })
    if (fs.location) p.set('location', fs.location)
    const res  = await fetch(`/api/linkedin/search?${p}`)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Search failed')
    return { jobs: json.jobs ?? [], total: json.total ?? 0 }
  }, [q])

  return (
    <SourcePanel
      fetchJobs={fetch_} q={q} placeholder="LinkedIn" onJobSaved={onJobSaved}
      formFields={<>
        <TextField fieldKey="location" label="Location (OR syntax)"
          placeholder="e.g. Germany OR Netherlands OR United Kingdom" flex="1 1 240px" />
      </>}
    />
  )
}

