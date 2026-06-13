'use client'

import React, { useState } from 'react'
import { Btn, CompanyLogo, INPUT_STYLE, ScorePill, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { Job, ResumeListItem } from '@/lib/types'

interface AdzunaResult {
  id:            string
  title:         string
  company:       string
  location:      string
  salary?:       string
  description:   string
  url:           string
  postedAt?:     string
  contractTime?: string | null
  contractType?: string | null
}

interface Props {
  variant?:    'panel' | 'page'
  onJobSaved?: () => void
  onClose?:    () => void
}

const COUNTRIES = [
  { code: 'gb', label: '🇬🇧 UK'  },
  { code: 'de', label: '🇩🇪 DE'  },
  { code: 'fr', label: '🇫🇷 FR'  },
  { code: 'nl', label: '🇳🇱 NL'  },
  { code: 'es', label: '🇪🇸 ES'  },
  { code: 'it', label: '🇮🇹 IT'  },
  { code: 'at', label: '🇦🇹 AT'  },
  { code: 'be', label: '🇧🇪 BE'  },
  { code: 'pl', label: '🇵🇱 PL'  },
  { code: 'us', label: '🇺🇸 US'  },
  { code: 'ca', label: '🇨🇦 CA'  },
  { code: 'au', label: '🇦🇺 AU'  },
]

function fmtPosted(iso?: string): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7)  return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

// Fire-and-forget: score a saved job against the user's default resume
async function runAiScore(
  jobId: string,
  jobTitle: string,
  jobDescription: string,
): Promise<number | null> {
  try {
    // 1. Get resume list, pick default
    const listRes = await fetch('/api/resume')
    if (!listRes.ok) return null
    const resumes: ResumeListItem[] = await listRes.json()
    if (!resumes.length) return null
    const pick = resumes.find(r => r.isDefault) ?? resumes[0]

    // 2. Get full resume content
    const resumeRes = await fetch(`/api/resume/${pick.id}`)
    if (!resumeRes.ok) return null
    const resumeFull = await resumeRes.json()
    if (!resumeFull?.content) return null

    // 3. Call AI score
    const scoreRes = await fetch('/api/ai/score', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeContent:  resumeFull.content,
        jobTitle,
        jobDescription: jobDescription.slice(0, 2000),
      }),
    })
    if (!scoreRes.ok) return null
    const scoreData = await scoreRes.json() as {
      score:           number
      matchedKeywords: string[]
      missingKeywords: string[]
      keywords?: string
    }

    // 4. Patch job with score + analysisNote
    const matched = scoreData.matchedKeywords?.join(', ') || '—'
    const missing = scoreData.missingKeywords?.join(', ') || '—'
    await apiMutate(`/api/jobs/${jobId}`, 'PATCH', {
      score:        scoreData.score,
        keywords: scoreData.keywords ?? '',
      analysisNote: `Match Score: ${scoreData.score}%\n\nMatched keywords: ${matched}\n\nMissing keywords: ${missing}`,
    })

    return scoreData.score
  } catch {
    return null
  }
}

export function AdzunaSearchPanel({ variant = 'panel', onJobSaved, onClose }: Props) {
  const isPage = variant === 'page'
  const toast  = useToast()

  const [q,           setQ          ] = useState('')
  const [where,       setWhere      ] = useState('')
  const [country,     setCountry    ] = useState('gb')
  const [jobType,     setJobType    ] = useState('')
  const [page,        setPage       ] = useState(1)
  const [searching,   setSearching  ] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [results,     setResults    ] = useState<AdzunaResult[]>([])
  const [total,       setTotal      ] = useState(0)
  const [searched,    setSearched   ] = useState(false)
  const [savingIds,   setSavingIds  ] = useState<Set<string>>(new Set())
  const [savedIds,    setSavedIds   ] = useState<Set<string>>(new Set())
  const [scoringIds,  setScoringIds ] = useState<Set<string>>(new Set())
  const [scores,      setScores     ] = useState<Record<string, number>>({})

  async function doSearch(nextPage: number, append = false) {
    const params = new URLSearchParams({ q, where, country, page: String(nextPage) })
    if (jobType) params.set('job_type', jobType)
    const res  = await fetch(`/api/adzuna/search?${params}`)
    const json = await res.json() as { jobs?: AdzunaResult[]; total?: number; error?: string }
    if (!res.ok) throw new Error(json.error ?? 'Search failed')
    const jobs = json.jobs ?? []
    setResults(prev => {
      if (!append) return jobs
      const seen = new Set(prev.map(j => j.id))
      return [...prev, ...jobs.filter(j => !seen.has(j.id))]
    })
    setTotal(json.total ?? 0)
    return jobs.length
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!q.trim()) return
    setSearching(true)
    setSearched(true)
    setPage(1)
    setSavedIds(new Set())
    setScores({})
    try {
      await doSearch(1, false)
    } catch (ex) {
      toast.error('Search failed', (ex as Error).message)
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  async function handleLoadMore() {
    const next = page + 1
    setPage(next)
    setLoadingMore(true)
    try { await doSearch(next, true) }
    catch { toast.error('Load more failed', 'Could not fetch next page') }
    finally { setLoadingMore(false) }
  }

  async function saveJob(r: AdzunaResult) {
    setSavingIds(prev => new Set(prev).add(r.id))
    const { data: job, error } = await apiMutate<Job>('/api/jobs', 'POST', {
      company:     r.company,
      role:        r.title,
      location:    r.location,
      url:         r.url,
      salary:      r.salary ?? null,
      description: r.description,
      source:      'adzuna',
      status:      'saved',
    })
    setSavingIds(prev => { const n = new Set(prev); n.delete(r.id); return n })

    if (error || !job) { toast.error('Save failed', error ?? 'Unknown error'); return }

    setSavedIds(prev => new Set(prev).add(r.id))
    toast.success('Job saved', `${r.title} at ${r.company} — scoring…`)
    onJobSaved?.()

    // AI match score — background, non-blocking
    if (r.description) {
      setScoringIds(prev => new Set(prev).add(r.id))
      runAiScore(job.id, r.title, r.description)
        .then(score => {
          if (score !== null) {
            setScores(prev => ({ ...prev, [r.id]: score }))
            toast.success('Match scored', `${r.company}: ${score}% match`)
          }
        })
        .finally(() => setScoringIds(prev => { const n = new Set(prev); n.delete(r.id); return n }))
    }
  }

  const labelSt: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }
  const hasMore = results.length < total

  const wrapper: React.CSSProperties = isPage
    ? { flex: 1, display: 'flex', flexDirection: 'column' }
    : { border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg)', marginBottom: 16 }

  return (
    <div style={wrapper}>

      {/* Header — panel only */}
      {!isPage && (
        <div style={{ padding: '12px 16px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>🌍 Search Jobs via Adzuna</span>
            {searched && !searching && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 999, padding: '1px 8px' }}>
                {total.toLocaleString()} results
              </span>
            )}
          </div>
          {onClose && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
          )}
        </div>
      )}

      {/* Search form */}
      <form onSubmit={handleSearch} style={{ padding: isPage ? '0 0 16px' : 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 200px' }}>
          <label style={labelSt}>Keywords *</label>
          <input style={INPUT_STYLE} value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. Software Engineer, React" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={labelSt}>Location</label>
          <input style={INPUT_STYLE} value={where} onChange={e => setWhere(e.target.value)} placeholder="e.g. Berlin, London" />
        </div>
        <div style={{ width: 100 }}>
          <label style={labelSt}>Country</label>
          <select style={INPUT_STYLE} value={country} onChange={e => setCountry(e.target.value)}>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div style={{ width: 120 }}>
          <label style={labelSt}>Type</label>
          <select style={INPUT_STYLE} value={jobType} onChange={e => setJobType(e.target.value)}>
            <option value="">Any</option>
            <option value="fulltime">Full-time</option>
            <option value="parttime">Part-time</option>
            <option value="contract">Contract</option>
            <option value="permanent">Permanent</option>
          </select>
        </div>
        <button type="submit" disabled={searching || !q.trim()} style={{
          padding: '8px 18px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6,
          fontSize: 12, fontWeight: 500, cursor: searching ? 'not-allowed' : 'pointer',
          opacity: searching ? 0.7 : 1, whiteSpace: 'nowrap',
        }}>
          {searching ? 'Searching…' : 'Search'}
        </button>
        {/* result count — page mode */}
        {isPage && searched && !searching && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 4 }}>
            {total.toLocaleString()} results
          </span>
        )}
      </form>

      {/* Results */}
      {searched && (
        <div style={{ borderTop: isPage ? 'none' : '0.5px solid var(--border)', flex: isPage ? 1 : undefined, display: 'flex', flexDirection: 'column' }}>
          {searching ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ width: 22, height: 22, border: '2px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 10px' }} />
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Searching Adzuna…</div>
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              No jobs found. Try different keywords or a broader location.
            </div>
          ) : (
            <>
              <div style={{ overflowY: 'auto', maxHeight: isPage ? undefined : 480, flex: isPage ? 1 : undefined }}>
                {results.map((r, i) => (
                  <div key={r.id} style={{
                    padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10,
                    borderBottom: i < results.length - 1 ? '0.5px solid var(--border)' : 'none',
                    background: 'var(--bg)',
                  }}>
                    <CompanyLogo logo={r.company.slice(0, 2).toUpperCase()} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{r.title}</span>
                        {r.contractTime && (
                          <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                            {r.contractTime.replace('_', ' ')}
                          </span>
                        )}
                        {r.contractType && (
                          <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                            {r.contractType}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {r.company}{r.location ? ` · ${r.location}` : ''}
                        {r.postedAt && <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.65 }}>{fmtPosted(r.postedAt)}</span>}
                      </div>
                      {r.salary && <div style={{ fontSize: 11, color: 'var(--c-success)', marginTop: 2 }}>{r.salary}</div>}
                      {r.description && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{r.description}</div>}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
                      {savedIds.has(r.id) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          {scoringIds.has(r.id) ? (
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px solid rgba(79,70,229,0.30)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                              Scoring…
                            </span>
                          ) : scores[r.id] !== undefined ? (
                            <ScorePill score={scores[r.id]} />
                          ) : (
                            <span style={{ fontSize: 10, color: 'var(--c-success)', fontWeight: 500 }}>✓ Saved</span>
                          )}
                        </div>
                      ) : (
                        <Btn small variant="primary" disabled={savingIds.has(r.id)} onClick={() => saveJob(r)}>
                          {savingIds.has(r.id) ? 'Saving…' : '+ Save'}
                        </Btn>
                      )}
                      <a href={r.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 10, color: 'var(--primary)', textDecoration: 'none' }}>
                        View ↗
                      </a>
                    </div>
                  </div>
                ))}
              </div>

              {hasMore && (
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
    </div>
  )
}
