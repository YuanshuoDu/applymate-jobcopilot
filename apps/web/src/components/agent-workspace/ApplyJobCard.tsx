'use client'

import React, { useEffect, useState } from 'react'

export interface ApplyReadyJob {
  jobId:           string
  company:         string
  role:            string
  score:           number
  url:             string | null
  location?:       string | null
  coverLetter?:    string
  matchedKeywords: string[]
  mode?:           'manual' | 'queued'
  taskId?:         string
}

interface ApplyJobCardProps {
  job:       ApplyReadyJob
  onApplied: (id: string) => void | Promise<void>
}

export function ApplyJobCard({ job, onApplied }: ApplyJobCardProps) {
  const [showCL,   setShowCL]   = useState(false)
  const [applying, setApplying] = useState(false)
  const [workerStatus, setWorkerStatus] = useState<'submitted' | 'manual' | 'failed' | null>(null)
  const isApplied = job.url?.startsWith('_applied')
  const isQueued = job.mode === 'queued'

  useEffect(() => {
    if (!isQueued || workerStatus) return
    let active = true
    const checkResult = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.jobId}/apply-results`)
        if (!response.ok) return
        const payload = await response.json() as { results?: Array<{ status?: unknown }> }
        const status = payload.results?.[0]?.status
        if (active && (status === 'submitted' || status === 'manual' || status === 'failed')) {
          setWorkerStatus(status)
        }
      } catch {
        // The worker can be unavailable temporarily; keep the queued status visible.
      }
    }
    void checkResult()
    const interval = window.setInterval(() => void checkResult(), 5_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [isQueued, job.jobId, workerStatus])

  async function handleApply() {
    if (!job.url || isApplied) return
    setApplying(true)
    try {
      window.open(job.url, '_blank', 'noopener')
      await new Promise(r => setTimeout(r, 800))
      await onApplied(job.jobId)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div style={{
      padding: '10px 14px', borderBottom: '0.5px solid var(--border)',
      opacity: isApplied ? 0.55 : 1, transition: 'opacity 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{job.company}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{job.role}</span>
            {job.location && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>📍{job.location}</span>}
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
              background: job.score >= 80 ? 'rgba(5,150,105,0.12)' : 'rgba(234,179,8,0.12)',
              color: job.score >= 80 ? 'var(--c-success)' : '#b45309',
            }}>{job.score}%</span>
          </div>
          {job.matchedKeywords.length > 0 && (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
              match：{job.matchedKeywords.slice(0, 5).join(' · ')}
            </div>
          )}
          {job.coverLetter && (
            <button onClick={() => setShowCL(s => !s)} style={{ marginTop: 4, fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              {showCL ? '▲ Close cover letter' : '▼ View cover letter'}
            </button>
          )}
          {showCL && job.coverLetter && (
            <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6, fontSize: 10, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', border: '0.5px solid var(--border)' }}>
              {job.coverLetter}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {isQueued ? (
            <WorkerState status={workerStatus} />
          ) : isApplied ? (
            <span style={{ fontSize: 11, color: 'var(--c-success)', fontWeight: 600 }}>✓ Delivered</span>
          ) : (
            <button
              onClick={handleApply}
              disabled={applying || !job.url}
              style={{
                padding: '6px 14px', borderRadius: 7, border: 'none',
                background: applying ? 'var(--border)' : 'var(--primary)',
                color: '#fff', fontSize: 11, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {applying ? '…' : '🚀 Apply now'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkerState({ status }: { status: 'submitted' | 'manual' | 'failed' | null }) {
  const states = {
    submitted: { label: '✓ Delivery confirmed', color: 'var(--c-success)' },
    manual: { label: '⚠ Requires manual processing', color: '#b45309' },
    failed: { label: '✕ Delivery failed', color: 'var(--c-danger)' },
    queued: { label: '⏳ Posting in the background', color: 'var(--primary)' },
  }
  const state = status ? states[status] : states.queued
  return <span style={{ fontSize: 11, color: state.color, fontWeight: 600 }}>{state.label}</span>
}
