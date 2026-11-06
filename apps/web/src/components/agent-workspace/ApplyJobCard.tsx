'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useI18n } from '@/lib/i18n'
import {
  createApplyJobActions,
  manualRecordLabel,
  readManualRecordStatus,
  writeManualRecordStatus,
  type ManualRecordState,
  type ManualRecordStatus,
} from './apply-job-actions'

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
  manualRecordStatuses?: Record<string, ManualRecordStatus>
}

interface ApplyJobCardProps {
  job:       ApplyReadyJob
  onApplied: (id: string) => void | Promise<void>
}

export function ApplyJobCard({ job, onApplied }: ApplyJobCardProps) {
  const { t, lang } = useI18n()
  const { data: authSession, status: authStatus } = useSession()
  const userId = authStatus === 'authenticated' ? authSession?.user?.id ?? null : null
  const jobRecordStatus = userId ? job.manualRecordStatuses?.[userId] : undefined
  const [showCL,   setShowCL]   = useState(false)
  const [workerStatus, setWorkerStatus] = useState<'submitted' | 'manual' | 'failed' | null>(null)
  const [localRecordState, setLocalRecordState] = useState<ManualRecordState>(jobRecordStatus ?? 'idle')
  const recordScope = userId ? JSON.stringify([userId, job.jobId]) : null
  const activeRecordScopeRef = useRef(recordScope)
  activeRecordScopeRef.current = recordScope
  const [loadedRecordScope, setLoadedRecordScope] = useState<string | null>(
    jobRecordStatus && recordScope ? recordScope : null,
  )
  const recordStateRef = useRef<ManualRecordState>(jobRecordStatus ?? 'idle')
  const recordState = loadedRecordScope === recordScope ? localRecordState : jobRecordStatus ?? 'idle'
  const recordStateLoaded = Boolean(recordScope && loadedRecordScope === recordScope)
  const isReported = recordState === 'reported'
  const isQueued = job.mode === 'queued'

  function setRecordStateForScope(scope: string | null, state: ManualRecordState) {
    if (activeRecordScopeRef.current !== scope) return
    recordStateRef.current = state
    setLocalRecordState(state)
  }

  useEffect(() => {
    if (isQueued) {
      setLoadedRecordScope(null)
      return
    }
    if (!userId || !recordScope) {
      recordStateRef.current = 'idle'
      setLocalRecordState('idle')
      setLoadedRecordScope(null)
      return
    }
    const persisted = readManualRecordStatus(userId, job.jobId)
    if (!persisted.available) {
      recordStateRef.current = 'unknown'
      setLocalRecordState('unknown')
    } else if (persisted.status) {
      recordStateRef.current = persisted.status
      setLocalRecordState(persisted.status)
    } else if (jobRecordStatus) {
      recordStateRef.current = jobRecordStatus
      setLocalRecordState(jobRecordStatus)
      writeManualRecordStatus(userId, job.jobId, jobRecordStatus)
    } else {
      recordStateRef.current = 'idle'
      setLocalRecordState('idle')
    }
    setLoadedRecordScope(recordScope)
  }, [isQueued, job.jobId, jobRecordStatus, recordScope, userId])

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

  const actions = createApplyJobActions({
    jobId: job.jobId,
    jobUrl: job.url,
    onApplied,
    openWindow: (url, target, features) => window.open(url, target, features),
    isCurrentScope: () => activeRecordScopeRef.current === recordScope,
    getRecordState: () => recordStateRef.current,
    setRecordState: state => setRecordStateForScope(recordScope, state),
    readPersistedStatus: () => readManualRecordStatus(userId, job.jobId),
    writePersistedStatus: status => writeManualRecordStatus(userId, job.jobId, status),
  })

  return (
    <div style={{
      padding: '10px 14px', borderBottom: '0.5px solid var(--border)',
      opacity: isReported ? 0.7 : 1, transition: 'opacity 0.3s',
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
              {t('agent.match')}: {job.matchedKeywords.slice(0, 5).join(' · ')}
            </div>
          )}
          {job.coverLetter && (
            <button onClick={() => setShowCL(s => !s)} style={{ marginTop: 4, fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              {showCL ? `▲ ${t('agent.closeCoverLetter')}` : `▼ ${t('agent.viewCoverLetter')}`}
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
          ) : isReported ? (
            <span style={{ fontSize: 11, color: 'var(--c-success)', fontWeight: 600 }}>✓ {manualRecordLabel(lang, 'reported')}</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
              <button
                onClick={actions.openEmployer}
                disabled={!job.url}
                style={{
                  padding: '6px 14px', borderRadius: 7, border: 'none',
                  background: 'var(--primary)', color: '#fff', fontSize: 11,
                  fontWeight: 600, cursor: job.url ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
                }}
              >
                🚀 {t('agent.applyNow')}
              </button>
              {recordState === 'idle' ? (
                <button
                  onClick={() => void actions.recordSubmitted()}
                  disabled={!recordStateLoaded}
                  style={{
                    padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: 10,
                    cursor: recordStateLoaded ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
                  }}
                >
                  {manualRecordLabel(lang, 'idle')}
                </button>
              ) : (
                <span style={{ maxWidth: 190, textAlign: 'right', fontSize: 10, color: recordState === 'pending' ? 'var(--primary)' : '#b45309', fontWeight: 600 }}>
                  {manualRecordLabel(lang, recordState)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkerState({ status }: { status: 'submitted' | 'manual' | 'failed' | null }) {
  const { t } = useI18n()
  const states = {
    submitted: { label: `✓ ${t('agent.deliveryConfirmed')}`, color: 'var(--c-success)' },
    manual: { label: `⚠ ${t('agent.manualProcessing')}`, color: '#b45309' },
    failed: { label: `✕ ${t('agent.deliveryFailed')}`, color: 'var(--c-danger)' },
    queued: { label: `⏳ ${t('agent.postingBackground')}`, color: 'var(--primary)' },
  }
  const state = status ? states[status] : states.queued
  return <span style={{ fontSize: 11, color: state.color, fontWeight: 600 }}>{state.label}</span>
}
