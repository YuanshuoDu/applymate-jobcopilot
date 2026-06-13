'use client'

import React, { useState } from 'react'
import { Btn, Card, CompanyLogo, INPUT_STYLE, ScorePill, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { Job } from '@/lib/types'

interface SearchResult {
  id: string
  title: string
  company: string
  location: string
  salary?: string
  url: string
}

interface Props {
  onJobSaved?: () => void
  onClose: () => void
}

export function IndeedSearchPanel({ onJobSaved, onClose }: Props) {
  const toast = useToast()
  const [search, setSearch]   = useState('')
  const [location, setLocation] = useState('')
  const [country, setCountry]   = useState('US')
  const [jobType, setJobType]   = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults]   = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!search.trim()) return
    setSearching(true)
    setSearched(true)

    const { data, error } = await apiMutate<{ jobs: SearchResult[] }>('/api/indeed/search', 'POST', {
      search: search.trim(),
      location: location.trim() || 'remote',
      country_code: country,
      ...(jobType ? { job_type: jobType } : {}),
    })

    setSearching(false)
    if (error) {
      toast.error('Indeed Search', error)
      setResults([])
      return
    }
    setResults(data?.jobs ?? [])
    if ((data?.jobs ?? []).length === 0) {
      toast.info('No results', 'Try broadening your search terms')
    }
  }

  async function saveJob(result: SearchResult) {
    setSavingIds(prev => new Set(prev).add(result.id))
    const { error } = await apiMutate<Job>('/api/jobs', 'POST', {
      company: result.company,
      role: result.title,
      location: result.location,
      url: result.url,
      salary: result.salary ?? null,
      source: 'indeed',
      status: 'saved',
    })
    setSavingIds(prev => { const next = new Set(prev); next.delete(result.id); return next })
    if (error) {
      toast.error('Save failed', error)
    } else {
      toast.success('Job saved', `${result.title} at ${result.company}`)
      onJobSaved?.()
    }
  }

  const labelSt: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }

  return (
    <div style={{
      border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden',
      background: 'var(--bg)', marginBottom: 16,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>🔍 Search Indeed</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} style={{ padding: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={labelSt}>Job Title / Keywords *</label>
          <input style={INPUT_STYLE} value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. Software Engineer" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={labelSt}>Location</label>
          <input style={INPUT_STYLE} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. New York, NY" />
        </div>
        <div style={{ width: 90 }}>
          <label style={labelSt}>Country</label>
          <select style={INPUT_STYLE} value={country} onChange={e => setCountry(e.target.value)}>
            <option value="US">US</option>
            <option value="GB">UK</option>
            <option value="DE">DE</option>
            <option value="FR">FR</option>
            <option value="NL">NL</option>
            <option value="CA">CA</option>
            <option value="AU">AU</option>
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label style={labelSt}>Type</label>
          <select style={INPUT_STYLE} value={jobType} onChange={e => setJobType(e.target.value)}>
            <option value="">Any</option>
            <option value="fulltime">Full-time</option>
            <option value="parttime">Part-time</option>
            <option value="contract">Contract</option>
            <option value="internship">Internship</option>
          </select>
        </div>
        <button type="submit" disabled={searching || !search.trim()} style={{
          padding: '8px 16px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6,
          fontSize: 12, fontWeight: 500, cursor: searching ? 'not-allowed' : 'pointer',
          opacity: searching ? 0.7 : 1, whiteSpace: 'nowrap',
        }}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Results */}
      {searched && (
        <div style={{ borderTop: '0.5px solid var(--border)' }}>
          {searching ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ width: 22, height: 22, border: '2px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 10px' }} />
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Searching Indeed…</div>
            </div>
          ) : results.length > 0 ? (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {results.map((r, i) => (
                <div key={r.id} style={{
                  padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10,
                  borderBottom: i < results.length - 1 ? '0.5px solid var(--border)' : 'none',
                }}>
                  <CompanyLogo logo={r.company.slice(0, 2).toUpperCase()} size={28} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{r.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {r.company}{r.location ? ` · ${r.location}` : ''}
                    </div>
                    {r.salary && <div style={{ fontSize: 11, color: 'var(--c-success)', marginTop: 2 }}>{r.salary}</div>}
                  </div>
                  <Btn
                    small
                    variant="primary"
                    disabled={savingIds.has(r.id)}
                    onClick={() => saveJob(r)}>
                    {savingIds.has(r.id) ? 'Saving…' : '+ Save'}
                  </Btn>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              No jobs found. Try different keywords or a broader location.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
