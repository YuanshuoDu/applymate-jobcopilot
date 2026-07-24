'use client'

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { Bookmark, Check, ChevronDown, ChevronRight, Clock3, FileText, Info, LayoutGrid, Link2, List, LoaderCircle, Lock, Search, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { Btn, Card, CompanyLogo, INPUT_STYLE, ScorePill, StatusBadge, useToast, useConfirm } from '@/components/ui'
import { ResumeRenderer } from '@/components/resume/ResumeRenderer'
import { CoverLetterPreview } from '@/components/coverletter/CoverLetterPanel'
import type { ApplicationAudit, CoverLetter, Job, JobStatus, Activity, Resume, ResumeListItem } from '@/lib/types'
import { apiMutate, fmtDate, fmtRelative, useApi } from '@/lib/hooks'
import { setCachedApiResponse } from '@/lib/api-cache'
import { useNav } from '@/lib/nav-context'
import { exportApplicationPackLocally } from '@/lib/bundle'

const KANBAN_COLS: JobStatus[] = ['saved', 'applied', 'review', 'interview', 'offer', 'rejected']
const COL_LABELS: Record<JobStatus, string> = {
  saved: 'Saved', applied: 'Applied', review: 'In Review',
  interview: 'Interview', offer: 'Offer', rejected: 'Rejected',
}
const COL_COLORS: Record<JobStatus, string> = {
  saved: '#6B7280', applied: '#185FA5', review: '#854F0B',
  interview: '#3B6D11', offer: '#0E7490', rejected: '#A32D2D',
}

interface JobsPageCache {
  jobs: Job[]
  total: number
}

// Preserve the default list while the latest version is fetched after returning
// to this section. Searches and filters intentionally remain uncached.
let defaultJobsCache: JobsPageCache | null = null

function sortJobs(jobs: Job[], sortBy: 'createdAt' | 'score' | 'company' | 'role', sortDir: 'asc' | 'desc') {
  return [...jobs].sort((a, b) => {
    let comparison = 0
    if (sortBy === 'score') comparison = (a.score ?? -1) - (b.score ?? -1)
    else if (sortBy === 'company') comparison = a.company.localeCompare(b.company)
    else if (sortBy === 'role') comparison = a.role.localeCompare(b.role)

    if (sortBy === 'createdAt' || comparison === 0) {
      comparison = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    }
    return sortDir === 'desc' ? comparison : -comparison
  })
}

// ── ListView ──────────────────────────────────────────────────────────────────
function ListView({ jobs, onRowClick, selectedIds, onToggle, onToggleAll }: {
  jobs: Job[]
  onRowClick: (job: Job) => void
  selectedIds: Set<string>
  onToggle: (id: string) => void
  onToggleAll: (ids: string[]) => void
}) {
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'date', dir: 'desc' })

  const sorted = useMemo(() => [...jobs].sort((a, b) => {
    if (sort.col === 'score') {
      const sa = a.score ?? 0, sb = b.score ?? 0
      return sort.dir === 'desc' ? sb - sa : sa - sb
    }
    if (sort.col === 'company') {
      return sort.dir === 'desc' ? b.company.localeCompare(a.company) : a.company.localeCompare(b.company)
    }
    // date: sort by createdAt
    const da = new Date(a.createdAt).getTime()
    const db = new Date(b.createdAt).getTime()
    return sort.dir === 'desc' ? db - da : da - db
  }), [jobs, sort])

  function SortTh({ col, label }: { col: string; label: string }) {
    return (
      <th
        onClick={() => setSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' }))}
        style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
        {label} {sort.col === col ? (sort.dir === 'desc' ? '↓' : '↑') : ''}
      </th>
    )
  }

  const visibleIds = sorted.map(job => job.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))

  return (
    <Card style={{ overflow: 'hidden', borderRadius: '0 0 14px 14px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)' }}>
            <th style={{ width: 42, padding: '8px 12px', borderBottom: '0.5px solid var(--border)' }}>
              <input type="checkbox" aria-label="Select all visible jobs" checked={allVisibleSelected} onChange={() => onToggleAll(visibleIds)} />
            </th>
            <SortTh col="company" label="Company" />
            <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)' }}>Role</th>
            <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)' }}>Status</th>
            <SortTh col="score" label="Match" />
            <SortTh col="date"  label="Added" />
            <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, borderBottom: '0.5px solid var(--border)' }}>Follow-up</th>
            <th style={{ padding: '8px 16px', borderBottom: '0.5px solid var(--border)' }} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((j, i) => (
            <tr key={j.id}
              onClick={() => onRowClick(j)}
              style={{ borderBottom: i < sorted.length - 1 ? '0.5px solid var(--border)' : 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}>
              <td style={{ padding: '10px 12px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${j.role} at ${j.company}`} checked={selectedIds.has(j.id)} onChange={() => onToggle(j.id)} />
              </td>
              <td style={{ padding: '10px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CompanyLogo logo={j.logo ?? j.company.slice(0, 2).toUpperCase()} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{j.company}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{j.location}</div>
                  </div>
                </div>
              </td>
              <td style={{ padding: '10px 16px' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{j.role}</div>
                {j.keywords ? (() => {
                  const kws = j.keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 8)
                  return kws.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {kws.map((kw, i) => (
                        <span key={i} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '0.5px solid var(--border)', whiteSpace: 'nowrap' }}>{kw}</span>
                      ))}
                    </div>
                  ) : null
                })() : null}
              </td>
              <td style={{ padding: '10px 16px' }}><StatusBadge status={j.status} /></td>
              <td style={{ padding: '10px 16px' }}><ScorePill score={j.score} /></td>
              <td style={{ padding: '10px 16px', fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtDate(j.appliedAt ?? j.createdAt)}
              </td>
              <td style={{ padding: '10px 16px', fontSize: 11, color: j.followUpAt ? '#854F0B' : 'var(--text-muted)' }}>
                {fmtDate(j.followUpAt) || '—'}
              </td>
              <td style={{ padding: '10px 16px' }}>
                <Btn small variant="ghost" onClick={() => onRowClick(j)}>···</Btn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ── KanbanView ────────────────────────────────────────────────────────────────
function KanbanView({ jobs, onStatusChange, onAddClick }: {
  jobs: Job[]
  onStatusChange: (id: string, status: JobStatus) => void
  onAddClick: (status: JobStatus) => void
}) {
  const toast  = useToast()
  const dragId = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<JobStatus | null>(null)

  function handleDrop(col: JobStatus) {
    if (dragId.current) {
      const job = jobs.find(j => j.id === dragId.current)
      if (job && job.status !== col) {
        onStatusChange(dragId.current, col)
      }
      dragId.current = null
    }
    setDragOver(null)
  }

  const cols = useMemo(() => {
    const m = {} as Record<JobStatus, Job[]>
    KANBAN_COLS.forEach(c => { m[c] = jobs.filter(j => j.status === c) })
    return m
  }, [jobs])

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
      {KANBAN_COLS.map(col => (
        <div key={col}
          onDragOver={e => { e.preventDefault(); setDragOver(col) }}
          onDragLeave={() => setDragOver(null)}
          onDrop={() => handleDrop(col)}
          onTouchMove={e => {
            // Detect which column the touch is over
            const touch = e.touches[0]
            const el = document.elementFromPoint(touch.clientX, touch.clientY)
            const colDiv = el?.closest('[data-col]') as HTMLElement | null
            if (colDiv) setDragOver(colDiv.dataset.col as JobStatus)
          }}
          data-col={col}
          style={{
            width: 200, flexShrink: 0,
            border: dragOver === col ? `1.5px dashed ${COL_COLORS[col]}` : '0.5px solid var(--border)',
            borderRadius: 10, padding: 10,
            background: dragOver === col ? `${COL_COLORS[col]}08` : 'var(--bg-secondary)',
            transition: 'border-color 0.12s, background 0.12s',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: COL_COLORS[col] }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>{COL_LABELS[col]}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 999, padding: '1px 6px' }}>
              {cols[col].length}
            </span>
          </div>
          {cols[col].map(job => (
            <div key={job.id} draggable
              onDragStart={() => { dragId.current = job.id }}
              onTouchStart={() => { dragId.current = job.id }}
              onTouchEnd={() => { dragId.current = null }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = COL_COLORS[col]; e.currentTarget.style.boxShadow = `0 2px 8px ${COL_COLORS[col]}12` }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
              style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 8, cursor: 'grab', transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.12s', touchAction: 'none', userSelect: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CompanyLogo logo={job.logo ?? job.company.slice(0, 2).toUpperCase()} size={20} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{job.company}</span>
                </div>
                {job.score != null && <ScorePill score={job.score} />}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{job.role}</div>
              {job.keywords ? (() => {
                const kws = job.keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 6)
                return kws.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
                    {kws.map((kw, i) => (
                      <span key={i} style={{ fontSize: 9, padding: '0px 5px', borderRadius: 3, background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '0.5px solid var(--border)', whiteSpace: 'nowrap' }}>{kw}</span>
                    ))}
                  </div>
                ) : null
              })() : null}
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtDate(job.appliedAt ?? job.createdAt)}</div>
            </div>
          ))}
          <button
            onClick={() => onAddClick(col)}
            style={{ width: '100%', padding: '6px 0', border: '0.5px dashed var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
            + Add {COL_LABELS[col]}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── AddJobModal ───────────────────────────────────────────────────────────────
function AddJobModal({ onClose, onAdded, prefillStatus }: {
  onClose: () => void
  onAdded: (job: Job) => void
  prefillStatus?: JobStatus | null
}) {
  const toast  = useToast()
  const [form, setForm] = useState({ company: '', role: '', location: '', url: '', salary: '', status: (prefillStatus ?? 'saved') as JobStatus })
  const [saving, setSaving] = useState(false)

  const labelSt: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company.trim() || !form.role.trim()) {
      toast.error('Required', 'Company and role are required')
      return
    }
    setSaving(true)
    const { data, error } = await apiMutate<Job>('/api/jobs', 'POST', form)
    setSaving(false)
    if (error || !data) { toast.error('Error', error ?? 'Failed to add job'); return }
    toast.success('Job added', `${form.role} at ${form.company}`)
    onAdded(data)
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <Card style={{ width: 460, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Add Job</span>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelSt}>Company *</label>
              <input style={INPUT_STYLE} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} placeholder="e.g. Stripe" />
            </div>
            <div>
              <label style={labelSt}>Role *</label>
              <input style={INPUT_STYLE} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="e.g. Backend Engineer" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelSt}>Location</label>
              <input style={INPUT_STYLE} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. Amsterdam, NL" />
            </div>
            <div>
              <label style={labelSt}>Salary</label>
              <input style={INPUT_STYLE} value={form.salary} onChange={e => setForm(f => ({ ...f, salary: e.target.value }))} placeholder="e.g. €70k–90k" />
            </div>
          </div>
          <div>
            <label style={labelSt}>Job URL</label>
            <input style={INPUT_STYLE} value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://…" />
          </div>
          <div>
            <label style={labelSt}>Initial status</label>
            <select style={INPUT_STYLE} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as JobStatus }))}>
              {KANBAN_COLS.map(c => <option key={c} value={c}>{COL_LABELS[c]}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <button type="submit" disabled={saving} style={{
              padding: '7px 16px', background: '#185FA5', color: '#fff', border: 'none', borderRadius: 6,
              fontSize: 12, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Adding…' : 'Add Job'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}

// ── JobDetailDrawer ───────────────────────────────────────────────────────────
function JobDetailDrawer({ job, onClose, onStatusChange, onUpdate, onDelete, onOpenTailoredResume }: {
  job:            Job
  onClose:        () => void
  onStatusChange: (id: string, status: JobStatus) => void
  onUpdate:       (updated: Job) => void
  onDelete:       (id: string) => void
  onOpenTailoredResume: (resumeId: string) => void
}) {
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()
  const [notes,        setNotes]        = useState(job.notes ?? '')
  const [savingNotes,  setSavingNotes]  = useState(false)
  const [followUpAt,   setFollowUpAt]   = useState(job.followUpAt ? job.followUpAt.slice(0, 10) : '')
  const [deleting,     setDeleting]     = useState(false)
  const [activity,     setActivity]     = useState<Activity[]>([])
  const [loadingAct,   setLoadingAct]   = useState(true)
  const [interviewPrep, setInterviewPrep] = useState<{
    questions: Array<{ question: string; framework: string }>
    companyResearch: string
    followUpEmail: string
  } | null>(null)
  const [loadingPrep, setLoadingPrep] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)
  const { data: resumeList } = useApi<ResumeListItem[]>('/api/resume')
  const [selectedResumeId, setSelectedResumeId] = useState('')
  const [tailoringLoading, setTailoringLoading] = useState(false)
  const [downloadingPack, setDownloadingPack] = useState(false)
  const [exportedPackFolder, setExportedPackFolder] = useState<string | null>(null)
  const [autoPreparing, setAutoPreparing] = useState(false)
  const [packStage, setPackStage] = useState<'idle' | 'resume' | 'coverLetter' | 'audit' | 'review'>('idle')
  const [auditedPackKey, setAuditedPackKey] = useState<string | null>(null)
  const [openPackItem, setOpenPackItem] = useState<'resume' | 'coverLetter' | 'audit' | null>(null)
  const [resumePreview, setResumePreview] = useState<Resume | null>(null)
  const [generatedCoverLetter, setGeneratedCoverLetter] = useState<CoverLetter | null>(null)
  const [latestAudit, setLatestAudit] = useState<ApplicationAudit | null>(null)
  const [documentPreview, setDocumentPreview] = useState<'resume' | 'coverLetter' | null>(null)
  const { data: coverLetters, refetch: refetchCoverLetters } = useApi<CoverLetter[]>(`/api/jobs/${job.id}/cover-letters`)

  // Load per-job activity on mount; reset interview prep when job changes
  useEffect(() => {
    setLoadingAct(true)
    setInterviewPrep(null)
    fetch(`/api/activity?jobId=${job.id}&limit=20`)
      .then(r => r.json())
      .then((data: Activity[]) => setActivity(Array.isArray(data) ? data : []))
      .catch(() => setActivity([]))
      .finally(() => setLoadingAct(false))
  }, [job.id])

  // Sync local state when parent job changes
  useEffect(() => { setNotes(job.notes ?? '') }, [job.notes])
  useEffect(() => { setFollowUpAt(job.followUpAt ? job.followUpAt.slice(0, 10) : '') }, [job.followUpAt])
  const baseResumes = useMemo(() => resumeList?.filter(r => r.kind === 'base') ?? [], [resumeList])
  const existingTailoredResume = useMemo(
    () => resumeList?.find(r => r.kind === 'adapted' && r.targetJobId === job.id) ?? null,
    [job.id, resumeList],
  )

  useEffect(() => {
    if (!baseResumes.length) return
    const preferred = baseResumes.find(r => r.isDefault) ?? baseResumes[0]
    setSelectedResumeId(prev => prev && baseResumes.some(r => r.id === prev) ? prev : preferred.id)
  }, [baseResumes, resumeList])
  useEffect(() => {
    const exportKey = `applymate:exported-pack:${job.id}`
    setAuditedPackKey(null)
    setOpenPackItem(null)
    setResumePreview(null)
    setGeneratedCoverLetter(null)
    setLatestAudit(null)
    setDocumentPreview(null)
    setPackStage('idle')
    try { setExportedPackFolder(window.sessionStorage.getItem(exportKey)) } catch { setExportedPackFolder(null) }
  }, [job.id])

  const previewResumeId = job.finalResumeId ?? existingTailoredResume?.id ?? null
  useEffect(() => {
    if (!previewResumeId) return
    fetch(`/api/resume/${previewResumeId}`).then(response => response.ok ? response.json() : null)
      .then((resume: Resume | null) => setResumePreview(resume))
      .catch(() => setResumePreview(null))
  }, [previewResumeId])

  // Once a package has been confirmed, every surface must show the exact
  // resume/letter pair that is exported. Do not let an in-memory draft letter
  // replace the confirmed version in the Application Pack preview.
  const selectedCoverLetter = job.finalCoverLetterId && job.finalResumeId
    ? coverLetters?.find(letter => letter.id === job.finalCoverLetterId && letter.resumeId === job.finalResumeId)
    : generatedCoverLetter
      ?? coverLetters?.find(letter => letter.resumeId === previewResumeId)
  const persistedAudit = useMemo(() => findLatestApplicationAudit(activity), [activity])
  const displayedAudit = latestAudit ?? persistedAudit?.audit ?? null
  const factualAuditFindings = (displayedAudit?.findings ?? []).filter(finding => finding.area !== 'job_match' && finding.severity !== 'pass')
  const auditNeedsRepair = Boolean(displayedAudit && displayedAudit.verdict !== 'pass')

  async function saveNotes() {
    if (notes === (job.notes ?? '')) return
    setSavingNotes(true)
    const { data, error } = await apiMutate<Job>(`/api/jobs/${job.id}`, 'PATCH', { notes })
    setSavingNotes(false)
    if (error) { toast.error('Save failed', error); return }
    if (data)  { onUpdate(data); toast.success('Notes saved') }
  }

  async function saveFollowUpAt(value: string) {
    // value is '' (clear) or 'YYYY-MM-DD'
    const prev = job.followUpAt ? job.followUpAt.slice(0, 10) : ''
    if (value === prev) return
    const { data, error } = await apiMutate<Job>(
      `/api/jobs/${job.id}`, 'PATCH',
      { followUpAt: value ? new Date(value).toISOString() : null },
    )
    if (error) { toast.error('Save failed', error); return }
    if (data)  { onUpdate(data); toast.success(value ? 'Follow-up date set' : 'Follow-up date cleared') }
  }

  async function handleDelete() {
    const ok = await confirm({
      title:        'Delete job?',
      message:      `"${job.role} at ${job.company}" will be permanently removed. This cannot be undone.`,
      danger:       true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setDeleting(true)
    const { error } = await apiMutate(`/api/jobs/${job.id}`, 'DELETE')
    setDeleting(false)
    if (error) { toast.error('Delete failed', error); return }
    onDelete(job.id)
    onClose()
  }

  async function generateInterviewPrep() {
    setLoadingPrep(true)
    try {
      const res = await fetch('/api/ai/interview-prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobTitle: job.role, jobCompany: job.company, jobDescription: job.description }),
      })
      const data = await res.json()
      if (res.ok && data.questions) {
        setInterviewPrep(data)
      } else {
        toast.error('Prep failed', data.error ?? 'Could not generate interview prep')
      }
    } catch {
      toast.error('Network error', 'Could not reach AI')
    } finally {
      setLoadingPrep(false)
    }
  }

  async function handleTailorResume() {
    if (existingTailoredResume) {
      onOpenTailoredResume(existingTailoredResume.id)
      return
    }
    if (!selectedResumeId) {
      toast.error('No resume selected', 'Create or import a resume first')
      return
    }

    setTailoringLoading(true)
    const { data, error } = await apiMutate<{ adaptedResumeId: string; reused?: boolean }>(
      `/api/jobs/${job.id}/tailor-resume`,
      'POST',
      { resumeId: selectedResumeId },
    )
    setTailoringLoading(false)

    if (error) {
      toast.error('Tailoring failed', error)
      return
    }
    if (!data) return

    if (data.reused) {
      onOpenTailoredResume(data.adaptedResumeId)
      return
    }

    toast.success('Tailored resume created', 'Review and confirm it in Resume before returning here.')
    onOpenTailoredResume(data.adaptedResumeId)
  }

  async function downloadFinalPack() {
    setDownloadingPack(true)
    try {
      const result = await exportApplicationPackLocally(job.id, Boolean(exportedPackFolder))
      setExportedPackFolder(result.folderPath)
      try { window.sessionStorage.setItem(`applymate:exported-pack:${job.id}`, result.folderPath) } catch { /* browser storage is optional */ }
      toast.success(exportedPackFolder ? 'Folder opened' : 'Application PDFs saved', result.folderPath)
    } catch (error) {
      if (exportedPackFolder) {
        setExportedPackFolder(null)
        try { window.sessionStorage.removeItem(`applymate:exported-pack:${job.id}`) } catch { /* browser storage is optional */ }
      }
      toast.error('Could not download application pack', error instanceof Error ? error.message : 'Please try again')
    } finally {
      setDownloadingPack(false)
    }
  }

  async function autoTailorAndAudit() {
    if (!selectedResumeId && !existingTailoredResume) {
      toast.error('No base resume selected', 'Create or import a resume first.')
      return
    }
    setAutoPreparing(true)
    setPackStage('resume')
    try {
      let adaptedResumeId = existingTailoredResume?.id
      if (!adaptedResumeId) {
        const { data, error } = await apiMutate<{ adaptedResumeId: string }>(`/api/jobs/${job.id}/tailor-resume`, 'POST', { resumeId: selectedResumeId })
        if (!data || error) throw new Error(error ?? 'Could not tailor the resume')
        adaptedResumeId = data.adaptedResumeId
        const response = await fetch(`/api/resume/${adaptedResumeId}`)
        if (response.ok) {
          const tailored = await response.json() as Resume
          setResumePreview(tailored)
          setCachedApiResponse(`/api/resume/${adaptedResumeId}`, tailored)
        }
      }

      let revisionFindings: ApplicationAudit['findings'] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        setPackStage('coverLetter')
        // Reuse a manually prepared (or previously generated) letter for this
        // tailored resume. A new letter is necessary only when one is missing,
        // or after a failed audit triggers an AI resume revision.
        const assignedCoverLetter = job.finalCoverLetterId
          ? coverLetters?.find(letter => letter.id === job.finalCoverLetterId)
          : undefined
        // A final letter is reusable only when it was written for this exact
        // resume version. This prevents an older letter silently travelling
        // with a revised resume after an audit failure.
        let coverLetter = attempt === 0
          ? (assignedCoverLetter?.resumeId === adaptedResumeId ? assignedCoverLetter : undefined)
            ?? coverLetters?.find(letter => letter.resumeId === adaptedResumeId)
          : undefined
        if (!coverLetter) {
          const result = await apiMutate<CoverLetter>(
            `/api/jobs/${job.id}/cover-letters/generate`, 'POST',
            { resumeId: adaptedResumeId, preferProvidedResume: true, auditFindings: revisionFindings },
          )
          if (!result.data || result.error) throw new Error(result.error ?? 'Could not generate the cover letter')
          coverLetter = result.data
        }
        setGeneratedCoverLetter(coverLetter)
        void refetchCoverLetters()

        const { data: coverAssigned, error: coverAssignError } = await apiMutate<Job>(
          `/api/jobs/${job.id}/assign`, 'PATCH', { finalCoverLetterId: coverLetter.id },
        )
        if (!coverAssigned || coverAssignError) throw new Error(coverAssignError ?? 'Could not select the cover letter')

        setPackStage('audit')
        let audit: ApplicationAudit | null = null
        let auditError: string | null = null
        for (let auditAttempt = 0; auditAttempt < 2; auditAttempt++) {
          const result = await apiMutate<ApplicationAudit>(`/api/jobs/${job.id}/audit-application`, 'POST', { resumeId: adaptedResumeId, coverLetterId: coverLetter.id })
          audit = result.data
          auditError = result.error
          if (audit || !auditError?.toLowerCase().includes('aborted')) break
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (!audit || auditError) throw new Error(auditError ?? 'Independent audit could not run')
        setLatestAudit(audit)

        if (audit.verdict === 'pass') {
          setPackStage('review')
          const { data: confirmed, error: confirmError } = await apiMutate<Job>(
            `/api/jobs/${job.id}/assign`, 'PATCH', { finalResumeId: adaptedResumeId, finalCoverLetterId: coverLetter.id },
          )
          if (!confirmed || confirmError) throw new Error(confirmError ?? 'Could not confirm the audited package')
          setAuditedPackKey(`${adaptedResumeId}:${coverLetter.id}`)
          onUpdate(confirmed)
          toast.success('Audited application pack ready', 'The final resume and cover letter are now available in this job.')
          return
        }

        if (attempt === 0) {
          revisionFindings = audit.findings
          // The just-audited letter failed. Remove it from the selected
          // package before generating a revised pair so no other surface can
          // treat the failed letter as the current final document.
          const { error: clearFailedLetterError } = await apiMutate(
            `/api/jobs/${job.id}/assign`, 'PATCH', { finalCoverLetterId: null },
          )
          if (clearFailedLetterError) throw new Error(clearFailedLetterError)
          setPackStage('resume')
          const revisionResponse: { data: { adaptedResumeId: string } | null; error: string | null } = await apiMutate<{ adaptedResumeId: string }>(
            `/api/jobs/${job.id}/tailor-resume`, 'POST',
            { resumeId: adaptedResumeId, forceRetailor: true, auditFindings: audit.findings },
          )
          if (!revisionResponse.data || revisionResponse.error) throw new Error(revisionResponse.error ?? 'Could not revise the tailored resume after audit feedback')
          adaptedResumeId = revisionResponse.data.adaptedResumeId
          const response = await fetch(`/api/resume/${adaptedResumeId}`)
          if (response.ok) {
            const revised = await response.json() as Resume
            setResumePreview(revised)
            setCachedApiResponse(`/api/resume/${adaptedResumeId}`, revised)
          }
          continue
        }

        await apiMutate(`/api/jobs/${job.id}/assign`, 'PATCH', { finalCoverLetterId: null })
        setOpenPackItem('audit')
        toast.warning('Automatic revision needs your review', audit.summary)
      }
    } catch (error) {
      setPackStage('idle')
      toast.error('Preparation could not finish', error instanceof Error ? error.message : 'Please try again')
    } finally {
      setAutoPreparing(false)
    }
  }

  // Drawer uses a slightly more compact variant of the shared INPUT_STYLE
  const drawerInputSt: React.CSSProperties = { ...INPUT_STYLE, fontSize: 11, padding: '5px 8px', borderRadius: 5 }
  const canTailorResume = Boolean(job.description && (baseResumes.length || existingTailoredResume))
  const currentPackAudited = auditedPackKey === `${job.finalResumeId}:${job.finalCoverLetterId}`
    || (persistedAudit?.audit.verdict === 'pass'
      && persistedAudit.resumeId === job.finalResumeId
      && persistedAudit.coverLetterId === job.finalCoverLetterId)

  return (
    <>
      <ConfirmDialog />
      {/* Overlay */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={onClose} />

      {/* Drawer panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 460, maxWidth: '100vw', zIndex: 91,
        background: 'var(--bg)', borderLeft: '0.5px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden', overscrollBehaviorX: 'contain',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div style={{ padding: '24px 28px 20px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.03em' }}>{job.role}</div>
            <div style={{ fontSize: 15, color: 'var(--text-muted)', marginTop: 7 }}>{job.source ? `${job.source} job` : job.company}{job.createdAt ? ` · Posted ${fmtDate(job.createdAt)}` : ''}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0, marginTop: 2 }}>✕</button>
        </div>

        <ReferenceProgress ready={currentPackAudited} />

        {/* Body */}
        <div style={{ flex: 1, padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

          <section style={{ borderBottom: '1px solid var(--border)', padding: '18px 0 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', color: '#64748b', marginBottom: 18 }}><Sparkles size={16} strokeWidth={2.4} style={{ color: '#2563eb', flexShrink: 0 }} />NEXT BEST ACTION</div>
            <div style={{ fontSize: 20, lineHeight: 1.25, fontWeight: 700, letterSpacing: '-0.025em' }}>{auditNeedsRepair ? 'Correct factual issues before applying' : existingTailoredResume ? 'Resume is tailored for this job' : 'Tailor your resume for this job'}</div>
            <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-muted)', margin: '7px 0 16px' }}>{auditNeedsRepair ? 'The Auditor found unsupported claims. AI will rewrite both documents from your original resume, then run the audit again.' : existingTailoredResume ? 'Review the AI-tailored version before preparing the application pack.' : 'Create a role-specific version, review it in Resume, then return here.'}</div>

            {auditNeedsRepair && <div style={{ marginBottom: 16, padding: '12px 14px', border: '1px solid #fecaca', background: '#fff7f7', borderRadius: 9 }}><div style={{ fontSize: 12, fontWeight: 800, color: '#b42318', marginBottom: 7 }}>FACTUAL ISSUES TO FIX</div>{factualAuditFindings.slice(0, 2).map((finding, index) => <div key={`${finding.title}-${index}`} style={{ color: '#7f1d1d', fontSize: 12, lineHeight: 1.45, marginTop: index ? 6 : 0 }}><strong>{finding.title}</strong><br />{finding.action}</div>)}</div>}

            {existingTailoredResume ? (
              <button onClick={() => onOpenTailoredResume(existingTailoredResume.id)} style={workflowDocumentButton}>
                <span style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: 10, background: '#eff6ff', color: '#2563eb' }}><FileText size={27} /></span>
                <span style={{ flex: 1, textAlign: 'left' }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{existingTailoredResume.name}</span><span style={{ display: 'block', fontSize: 13, marginTop: 5, color: 'var(--text-muted)', fontWeight: 400 }}>Tailored resume · ready to review</span></span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#2563eb', fontSize: 14, whiteSpace: 'nowrap' }}>Review in Resume <ChevronRight size={19} /></span>
              </button>
            ) : <div style={{ border: '1px solid #dbe1ea', borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 14 }}>Choose a base resume and create a tailored version. You’ll review it in Resume before returning here.</div>
              {baseResumes.length > 1 && <select value={selectedResumeId} onChange={e => setSelectedResumeId(e.target.value)} style={{ ...drawerInputSt, width: '100%', marginBottom: 12 }}>{baseResumes.map(r => <option key={r.id} value={r.id}>{r.isDefault ? 'Default — ' : ''}{r.name}</option>)}</select>}
              <Btn small onClick={handleTailorResume} disabled={tailoringLoading}>{tailoringLoading ? 'Creating tailored resume…' : 'Tailor in Resume'}</Btn>
            </div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-muted)', margin: '4px 0 20px' }}><span style={{ height: 1, background: 'var(--border)', flex: 1 }} /><span>OR</span><span style={{ height: 1, background: 'var(--border)', flex: 1 }} /></div>
            <button onClick={() => void autoTailorAndAudit()} disabled={autoPreparing || !canTailorResume} style={{ width: '100%', minHeight: 56, padding: '14px', border: `2px solid ${auditNeedsRepair ? '#dc2626' : '#2563eb'}`, borderRadius: 9, background: auditNeedsRepair ? '#fff7f7' : '#fff', color: auditNeedsRepair ? '#b42318' : '#2563eb', fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center' }}><Sparkles size={19} style={{ flexShrink: 0 }} />{autoPreparing ? 'Correcting facts and re-auditing…' : auditNeedsRepair ? 'Fix with AI and re-audit' : 'Prepare full application pack automatically'}</button>
            <div style={{ textAlign: 'center', fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)', margin: '12px 28px 28px' }}>{auditNeedsRepair ? 'This replaces unsupported claims; it does not invent experience, dates, or metrics.' : 'We’ll tailor your resume (if needed), generate a cover letter, and run an independent audit.'}</div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 22, fontSize: 12, fontWeight: 700, letterSpacing: '0.03em', color: '#64748b' }}>APPLICATION PACK</div>
            <style>{`@keyframes pack-line-grow { from { transform: scaleY(0) } to { transform: scaleY(1) } } @keyframes pack-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,.35) } 50% { box-shadow: 0 0 0 7px rgba(37,99,235,0) } }`}</style>
            <PackRow number="1" title="Resume" detail={packStage === 'resume' ? 'AI tailoring this resume…' : 'Tailored for this role'} done={Boolean(previewResumeId)} active={packStage === 'resume'} open={openPackItem === 'resume'} onToggle={() => setOpenPackItem(current => current === 'resume' ? null : 'resume')}>
              <ResumePackPreview resume={resumePreview} onReview={() => setDocumentPreview('resume')} />
            </PackRow>
            <PackRow number="2" title="Cover letter" detail={packStage === 'coverLetter' ? 'AI writing a tailored cover letter…' : selectedCoverLetter ? 'Generated for this job' : 'Created during automatic preparation'} done={Boolean(selectedCoverLetter)} active={packStage === 'coverLetter'} open={openPackItem === 'coverLetter'} onToggle={() => setOpenPackItem(current => current === 'coverLetter' ? null : 'coverLetter')}>
              <CoverLetterPackPreview coverLetter={selectedCoverLetter ?? null} applicant={resumePreview?.content.contact} fallbackName={resumePreview?.name ?? 'Applicant'} company={job.company} role={job.role} templateId={resumePreview?.templateId ?? undefined} templateOptions={resumePreview?.templateOptions ?? undefined} onReview={() => setDocumentPreview('coverLetter')} />
            </PackRow>
            <PackRow number="3" title="Independent audit" detail={packStage === 'audit' ? 'Checking changes against your original resume…' : auditNeedsRepair ? `${factualAuditFindings.length} factual issue${factualAuditFindings.length === 1 ? '' : 's'} need correction` : displayedAudit ? 'Facts verified against the original resume' : 'Runs after the resume and cover letter are ready'} done={currentPackAudited} failed={auditNeedsRepair} active={packStage === 'audit'} open={openPackItem === 'audit'} onToggle={() => setOpenPackItem(current => current === 'audit' ? null : 'audit')}>
              <AuditPackPreview audit={displayedAudit} onRepair={() => void autoTailorAndAudit()} repairing={autoPreparing} />
            </PackRow>
            {currentPackAudited && <button onClick={() => void downloadFinalPack()} disabled={downloadingPack} style={{ width: '100%', minHeight: 46, border: 0, borderRadius: 9, background: '#2563eb', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>{downloadingPack ? (exportedPackFolder ? 'Opening job folder…' : 'Saving PDFs…') : exportedPackFolder ? 'Open job folder' : 'Save audited PDFs to D:\\My Jobs resume'}</button>}
            <PackRow number="4" title="Open & fill application" detail="Available after all items are complete" done={false} locked={!currentPackAudited} last onClick={currentPackAudited && job.url ? () => window.open(job.url!, '_blank', 'noopener,noreferrer') : undefined} />
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 22 }}><div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 12 }}>REVIEW &amp; SUBMIT</div><div style={{ border: '1px solid #bfdbfe', background: '#f8fbff', borderRadius: 9, padding: '14px 16px', display: 'flex', gap: 12, fontSize: 13, lineHeight: 1.55 }}><Info size={22} color="#2563eb" style={{ flexShrink: 0, marginTop: 1 }} /><span><strong>You’ll review and submit on the employer site</strong><br /><span style={{ color: 'var(--text-muted)' }}>We’ll open the job in a new tab when your application pack is ready.</span></span></div></div>
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 28, paddingTop: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 16 }}>JOB DETAILS</div>
              <JobDetail label="Company" value={job.company} />
              {job.location && <JobDetail label="Location" value={job.location} />}
              {job.url && <JobDetail label="Job posting" value="View original posting" href={job.url} />}
            </div>
          </section>

          {/* Description */}
          {job.description && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 6 }}>DESCRIPTION</div>
              <div style={{
                fontSize: 12, color: 'var(--text)', lineHeight: 1.75, whiteSpace: 'pre-wrap',
                background: 'var(--bg-secondary)', borderRadius: 6, padding: '10px 12px',
                maxHeight: descExpanded ? 'none' : 280, overflow: descExpanded ? 'visible' : 'hidden',
                position: 'relative' as const,
              }}>
                {job.description}
                {!descExpanded && job.description.length > 500 && (
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 50, background: 'linear-gradient(transparent, var(--bg-secondary))' }} />
                )}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                {job.description.length > 500 && (
                  <button onClick={() => setDescExpanded(v => !v)}
                    style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {descExpanded ? '▲ Show less' : '▼ Read more'}
                  </button>
                )}
                {job.url && (
                  <a href={job.url} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'underline' }}>
                    View original posting ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Agent Analysis */}
          {job.analysisNote && (
            <div>
              <div style={{ fontSize: 10, color: '#185FA5', fontWeight: 500, marginBottom: 6 }}>AI ANALYSIS</div>
              <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.7, whiteSpace: 'pre-wrap', background: 'rgba(24,95,165,0.06)', border: '0.5px solid rgba(24,95,165,0.15)', borderRadius: 6, padding: '8px 10px', maxHeight: 200, overflowY: 'auto' }}>
                {job.analysisNote}
              </div>
            </div>
          )}

          {/* Dates */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 2 }}>ADDED</div>
              <div style={{ fontSize: 11 }}>{fmtDate(job.createdAt)}</div>
            </div>
            {job.appliedAt && (
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 2 }}>APPLIED</div>
                <div style={{ fontSize: 11 }}>{fmtDate(job.appliedAt)}</div>
              </div>
            )}
            {/* followUpAt — always visible, editable */}
            <div>
              <div style={{ fontSize: 10, color: followUpAt ? '#854F0B' : 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>FOLLOW-UP</div>
              <input
                type="date"
                value={followUpAt}
                onChange={e => setFollowUpAt(e.target.value)}
                onBlur={e => saveFollowUpAt(e.target.value)}
                style={{
                  ...drawerInputSt,
                  fontSize: 11,
                  color: followUpAt ? '#854F0B' : 'var(--text-muted)',
                  // Show a clear button by keeping the value accessible
                  colorScheme: 'dark',
                }}
              />
              {followUpAt && (
                <button
                  onClick={() => { setFollowUpAt(''); saveFollowUpAt('') }}
                  style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  ✕ Clear date
                </button>
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>NOTES</span>
              {savingNotes && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Saving…</span>}
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={saveNotes}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveNotes() } }}
              placeholder="Add notes, contacts, salary details…"
              style={{ ...drawerInputSt, minHeight: 90, resize: 'vertical', lineHeight: 1.6, padding: '7px 9px' }}
            />
          </div>

          {/* Activity log */}
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 8 }}>ACTIVITY</div>
            {loadingAct ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading…</div>
            ) : activity.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No activity yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {activity.map((a, i) => (
                  <div key={a.id} style={{ display: 'flex', gap: 10, paddingBottom: i < activity.length - 1 ? 10 : 0 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: a.color ?? '#6B7280', marginTop: 3 }} />
                      {i < activity.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 3 }} />}
                    </div>
                    <div style={{ paddingBottom: i < activity.length - 1 ? 6 : 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--text)' }}>{a.text}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{fmtRelative(a.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Interview Prep */}
          {job.status === 'interview' && (
            <div>
              <div style={{ fontSize: 10, color: '#3B6D11', fontWeight: 500, marginBottom: 8 }}>INTERVIEW PREP</div>
              {!interviewPrep ? (
                <button
                  onClick={generateInterviewPrep}
                  disabled={loadingPrep}
                  style={{
                    width: '100%', padding: '8px 0', borderRadius: 6, border: '0.5px solid rgba(59,109,17,0.3)',
                    background: loadingPrep ? 'var(--bg-secondary)' : 'rgba(59,109,17,0.08)',
                    color: '#3B6D11', fontSize: 11, fontWeight: 500, cursor: loadingPrep ? 'not-allowed' : 'pointer',
                    opacity: loadingPrep ? 0.6 : 1,
                  }}>
                  {loadingPrep ? 'Generating…' : 'Generate Interview Prep'}
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 6 }}>
                      Practice Questions ({interviewPrep.questions.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {interviewPrep.questions.map((q, i) => (
                        <details key={i} style={{ fontSize: 11 }}>
                          <summary style={{ color: 'var(--text)', cursor: 'pointer', fontWeight: 500, padding: '4px 0' }}>
                            {i + 1}. {q.question}
                          </summary>
                          <div style={{ color: 'var(--text-muted)', padding: '4px 8px', marginTop: 2, background: 'var(--bg-secondary)', borderRadius: 4, lineHeight: 1.6 }}>
                            {q.framework}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Company Research</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.7, background: 'var(--bg-secondary)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
                      {interviewPrep.companyResearch}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Follow-up Email Template</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.7, background: 'var(--bg-secondary)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', position: 'relative' }}>
                      {interviewPrep.followUpEmail}
                      <button
                        onClick={() => { navigator.clipboard.writeText(interviewPrep.followUpEmail); toast.success('Copied', 'Email template copied to clipboard') }}
                        style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg)', border: '0.5px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                        Copy
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => setInterviewPrep(null)}
                    style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                    Clear & regenerate
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {documentPreview === 'resume' && resumePreview && <DocumentPreviewModal title={resumePreview.name} onClose={() => setDocumentPreview(null)}><ResumeRenderer content={resumePreview.content} templateId={resumePreview.templateId} templateOptions={resumePreview.templateOptions} /></DocumentPreviewModal>}
        {documentPreview === 'coverLetter' && selectedCoverLetter && <DocumentPreviewModal title="AI-generated cover letter" onClose={() => setDocumentPreview(null)}><CoverLetterPreview content={selectedCoverLetter.content} applicant={resumePreview?.content.contact} fallbackName={resumePreview?.name ?? 'Applicant'} company={job.company} role={job.role} templateId={resumePreview?.templateId ?? selectedCoverLetter.templateId ?? 'clean'} templateOptions={resumePreview?.templateOptions ?? selectedCoverLetter.templateOptions ?? {}} /></DocumentPreviewModal>}

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8 }}>
          <Btn variant="danger" small disabled={deleting} onClick={handleDelete} style={{ flex: 1 }}>
            {deleting ? 'Deleting…' : 'Delete Job'}
          </Btn>
          <Btn variant="primary" small onClick={onClose} style={{ flex: 1 }}>Close</Btn>
        </div>
      </div>
    </>
  )
}

// Safety helper: salary DB field might be a JSON object from Google Jobs schema
function renderSalary(salary: unknown): string {
  if (!salary) return ''
  if (typeof salary === 'string') return salary
  return String(salary)
}

type StoredApplicationAudit = {
  resumeId: string
  coverLetterId: string
  audit: ApplicationAudit
}

function findLatestApplicationAudit(activity: Activity[]): StoredApplicationAudit | null {
  for (const item of activity) {
    const prefix = '[Auditor] application-audit '
    if (!item.text.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(item.text.slice(prefix.length)) as StoredApplicationAudit
      if (parsed.resumeId && parsed.coverLetterId && parsed.audit?.verdict && Array.isArray(parsed.audit.findings)) return parsed
    } catch {
      // Ignore legacy or malformed activity entries rather than breaking the job drawer.
    }
  }
  return null
}

const workflowDocumentButton: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '16px',
  border: '1px solid #dbe1ea', background: '#fff', borderRadius: 12,
  color: 'var(--text)', cursor: 'pointer', fontSize: 14,
}

function ReferenceProgress({ ready }: { ready: boolean }) {
  const steps = ['Prepare', 'Pack', 'Review', 'Apply']
  const active = ready ? 3 : 0
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '22px 28px 25px', borderBottom: '1px solid var(--border)' }}>{steps.map((label, index) => <div key={label} style={{ textAlign: 'center', position: 'relative' }}>{index < 3 && <span style={{ position: 'absolute', height: 2, background: index < active ? '#2563eb' : '#dbe1ea', top: 18, left: '62%', right: '-38%' }} />}<span style={{ position: 'relative', zIndex: 1, margin: '0 auto 8px', display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: '50%', border: `2px solid ${index === active ? '#2563eb' : '#dbe1ea'}`, color: index === active ? '#2563eb' : '#64748b', background: '#fff', fontSize: 15 }}>{index + 1}</span><div style={{ color: index === active ? '#2563eb' : '#64748b', fontSize: 12, fontWeight: index === active ? 700 : 500 }}>{label}</div></div>)}</div>
}

function PackRow({ number, title, detail, done, failed = false, active = false, locked, onClick, onToggle, open, children, last = false }: {
  number: string; title: string; detail: string; done: boolean; failed?: boolean; locked?: boolean; onClick?: () => void
  active?: boolean; onToggle?: () => void; open?: boolean; children?: React.ReactNode; last?: boolean
}) {
  const status = locked ? 'Locked' : active ? 'In progress' : failed ? 'Needs correction' : done ? (title === 'Independent audit' ? 'Passed' : 'Completed') : 'Pending'
  return <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr', gap: 12, position: 'relative' }}>
    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
      {!last && <span style={{ position: 'absolute', top: 32, bottom: 0, width: 2, background: done ? '#75b85a' : active ? '#60a5fa' : '#dbe1ea', transformOrigin: 'top', animation: 'pack-line-grow .42s ease-out both' }} />}
      <span style={{ position: 'relative', zIndex: 1, marginTop: 15, width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: '50%', background: done ? '#3b8c1a' : failed ? '#dc2626' : active ? '#2563eb' : '#eef1f6', color: done || active || failed ? '#fff' : '#64748b', fontWeight: 700, animation: active ? 'pack-pulse 1.15s ease-in-out infinite' : undefined }}>{done ? <Check size={18} strokeWidth={3} /> : number}</span>
    </div>
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--border)', padding: '15px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
        <button onClick={onClick ?? onToggle} disabled={!onClick && !onToggle} style={{ border: 'none', padding: 0, background: 'transparent', color: 'var(--text)', textAlign: 'left', cursor: onClick || onToggle ? 'pointer' : 'default' }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{title}</span><span style={{ display: 'block', marginTop: 3, fontSize: 13, color: 'var(--text-muted)', fontWeight: 400, lineHeight: 1.4 }}>{detail}</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '5px 10px', fontSize: 11, color: done ? '#3b8c1a' : failed ? '#b42318' : active ? '#2563eb' : '#64748b', background: done ? '#e9f7e5' : failed ? '#fee2e2' : active ? '#eff6ff' : '#eef1f6' }}>{locked && <Lock size={12} />}{status}</span>{onToggle && <button aria-label={`Show ${title} details`} onClick={onToggle} style={{ border: 'none', padding: 3, color: '#334155', background: 'transparent', cursor: 'pointer' }}><ChevronDown size={18} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease' }} /></button>}</div>
      </div>
      {open && children && <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: '#f8fafc', border: '1px solid #e5eaf1', animation: 'pack-line-grow .2s ease-out both', transformOrigin: 'top' }}>{children}</div>}
    </div>
  </div>
}

function ResumePackPreview({ resume, onReview }: { resume: Resume | null; onReview: () => void }) {
  if (!resume) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>The tailored resume will appear here once AI tailoring finishes.</div>
  const templateLabel = resume.templateId ? `${resume.templateId[0].toUpperCase()}${resume.templateId.slice(1)} template` : 'Clean template'
  return <div>
    <button onClick={onReview} aria-label="Open the full tailored resume preview" style={{ display: 'block', position: 'relative', width: '100%', height: 420, padding: 0, overflow: 'hidden', contain: 'layout paint', border: '1px solid #dbe1ea', borderRadius: 8, background: '#e9eef5', cursor: 'zoom-in', textAlign: 'left' }}>
      <div style={{ position: 'absolute', inset: 0, width: '222.23%', transform: 'scale(.45)', transformOrigin: 'top left', pointerEvents: 'none', background: '#fff' }}>
        <ResumeRenderer content={resume.content} templateId={resume.templateId} templateOptions={resume.templateOptions} />
      </div>
      <span style={{ position: 'absolute', right: 12, bottom: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 10px', borderRadius: 7, background: 'rgba(15,23,42,.86)', color: '#fff', fontSize: 12, fontWeight: 700 }}>View full resume <ChevronRight size={15} /></span>
    </button>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10, fontSize: 12, color: '#64748b' }}><span>AI tailored for this job</span><span>{templateLabel}</span></div>
  </div>
}

function CoverLetterPackPreview({ coverLetter, applicant, fallbackName, company, role, templateId, templateOptions, onReview }: {
  coverLetter: CoverLetter | null; applicant?: Resume['content']['contact']; fallbackName: string; company: string; role: string
  templateId?: string | null; templateOptions?: Resume['templateOptions']; onReview: () => void
}) {
  return coverLetter
    ? <button onClick={onReview} aria-label="Open the full generated cover letter" style={{ display: 'block', position: 'relative', width: '100%', height: 260, padding: 0, overflow: 'hidden', contain: 'layout paint', border: '1px solid #dbe1ea', borderRadius: 8, background: '#e9eef5', cursor: 'zoom-in', textAlign: 'left' }}><div style={{ position: 'absolute', inset: 0, width: '200%', transform: 'scale(.5)', transformOrigin: 'top left', pointerEvents: 'none' }}><CoverLetterPreview content={coverLetter.content} applicant={applicant} fallbackName={fallbackName} company={company} role={role} templateId={templateId ?? coverLetter.templateId ?? 'clean'} templateOptions={templateOptions ?? coverLetter.templateOptions ?? {}} /></div><span style={{ position: 'absolute', right: 12, bottom: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '7px 9px', borderRadius: 6, background: 'rgba(15,23,42,.86)', color: '#fff', fontSize: 11, fontWeight: 700 }}>View full letter <ChevronRight size={14} /></span></button>
    : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>The generated cover letter will appear here after automatic preparation.</div>
}

function DocumentPreviewModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, zIndex: 130, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,23,42,.62)' }} onMouseDown={onClose}>
    <div style={{ width: 'min(920px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f1f5f9', borderRadius: 14, boxShadow: '0 24px 80px rgba(15,23,42,.42)' }} onMouseDown={event => event.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '15px 20px', background: '#fff', borderBottom: '1px solid #dbe1ea' }}><div><div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{title}</div><div style={{ marginTop: 2, fontSize: 12, color: '#64748b' }}>Full application document preview</div></div><button onClick={onClose} aria-label="Close preview" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, border: 'none', borderRadius: 8, color: '#475569', background: '#f1f5f9', cursor: 'pointer' }}><X size={18} /></button></div>
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>{children}</div>
    </div>
  </div>
}

function AuditPackPreview({ audit, onRepair, repairing }: { audit: ApplicationAudit | null; onRepair: () => void; repairing: boolean }) {
  if (!audit) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No audit result yet. The audit checks the tailored resume and cover letter against the original resume before the application can be opened.</div>
  const issues = audit.findings.filter(finding => finding.area !== 'job_match' && finding.severity !== 'pass')
  const passed = audit.findings.filter(finding => finding.severity === 'pass').length
  return <div><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, fontWeight: 700 }}><span>{audit.verdict === 'pass' ? 'Factual integrity passed' : `${issues.length} factual issue${issues.length === 1 ? '' : 's'} need correction`}</span><span style={{ color: audit.verdict === 'pass' ? '#3b8c1a' : audit.verdict === 'blocked' ? '#b42318' : '#a16207', whiteSpace: 'nowrap' }}>Role match {audit.matchScore}%</span></div>{issues.length > 0 && <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>{issues.map((finding, index) => <div key={`${finding.title}-${index}`} style={{ padding: '9px 10px', borderLeft: `3px solid ${finding.severity === 'critical' ? '#dc2626' : '#d97706'}`, background: finding.severity === 'critical' ? '#fff7f7' : '#fffbeb', fontSize: 12, lineHeight: 1.45 }}><strong style={{ color: finding.severity === 'critical' ? '#b42318' : '#a16207' }}>{finding.title}</strong><div style={{ color: '#475569', marginTop: 3 }}>{finding.action}</div></div>)}</div>}{passed > 0 && <div style={{ marginTop: 10, color: '#3b8c1a', fontSize: 12 }}>{passed} supported check{passed === 1 ? '' : 's'} passed</div>}{audit.verdict !== 'pass' && <button onClick={onRepair} disabled={repairing} style={{ marginTop: 12, border: '1px solid #2563eb', background: '#fff', color: '#2563eb', borderRadius: 7, padding: '8px 10px', fontWeight: 700, cursor: 'pointer' }}>{repairing ? 'Correcting facts and re-auditing…' : 'Fix with AI and re-audit'}</button>}</div>
}

function JobDetail({ label, value, href }: { label: string; value: string; href?: string }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr', gap: 12, alignItems: 'center', marginBottom: 16 }}>
    <span style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 8, background: '#f3f6fb', color: '#64748b' }}>{href ? <Link2 size={16} /> : <FileText size={16} />}</span>
    <span><span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{label}</span>{href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2, color: '#2563eb', fontSize: 13, textDecoration: 'none' }}>{value} <ChevronRight size={14} /></a> : <span style={{ display: 'block', marginTop: 2, color: 'var(--text-muted)', fontSize: 13 }}>{value}</span>}</span>
  </div>
}

// ── PaginationBar ────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTS = [20, 50]
const SORT_OPTS: { value: string; label: string }[] = [
  { value: 'createdAt', label: 'Date' },
  { value: 'score',     label: 'Score' },
  { value: 'company',   label: 'Company' },
  { value: 'role',      label: 'Role' },
]

function PaginationBar({
  total, page, pageSize, onChangePage, onChangeSize,
  sortBy, sortDir, onChangeSort,
}: {
  total:        number; page: number; pageSize: number
  onChangePage: (p: number) => void; onChangeSize: (s: number) => void
  sortBy:       string; sortDir: string
  onChangeSort: (by: any, dir: any) => void
}) {
  const totalPages = Math.ceil(total / pageSize)
  const from = (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, total)

  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: '4px 10px', border: '0.5px solid var(--border)', borderRadius: 5,
    background: disabled ? 'var(--bg-secondary)' : 'var(--bg)',
    color: disabled ? 'var(--text-muted)' : 'var(--text)',
    cursor: disabled ? 'default' : 'pointer', fontSize: 11, fontWeight: 500,
  })

  const pageNums: number[] = []
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) {
    pageNums.push(p)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '10px 16px', borderTop: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
      {/* Left: page info + size selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {from}–{to} of {total}
        </span>
        <select value={pageSize} onChange={e => onChangeSize(Number(e.target.value))}
          style={{ padding: '3px 6px', fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)' }}>
          {PAGE_SIZE_OPTS.map(s => <option key={s} value={s}>{s} / page</option>)}
        </select>
      </div>

      {/* Center: sort */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Sort:</span>
        <select value={sortBy} onChange={e => onChangeSort(e.target.value, sortDir)}
          style={{ padding: '3px 6px', fontSize: 10, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)' }}>
          {SORT_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={() => onChangeSort(sortBy, sortDir === 'asc' ? 'desc' : 'asc')}
          style={{ ...btnStyle(false), fontSize: 12, padding: '3px 7px' }}>
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {/* Right: page nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button onClick={() => onChangePage(1)} disabled={page <= 1} style={btnStyle(page <= 1)}>«</button>
        <button onClick={() => onChangePage(page - 1)} disabled={page <= 1} style={btnStyle(page <= 1)}>‹</button>
        {pageNums.map(p => (
          <button key={p} onClick={() => onChangePage(p)}
            style={{ ...btnStyle(false), minWidth: 28, textAlign: 'center', fontWeight: p === page ? 700 : 400, background: p === page ? 'rgba(24,95,165,0.08)' : 'var(--bg)', color: p === page ? '#185FA5' : 'var(--text)' }}>
            {p}
          </button>
        ))}
        <button onClick={() => onChangePage(page + 1)} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>›</button>
        <button onClick={() => onChangePage(totalPages)} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>»</button>
      </div>
    </div>
  )
}

function ScoreJobButton({ job, onUpdate }: { job: Job; onUpdate: (updated: Job) => void }) {
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  async function handleScore() {
    setLoading(true)
    try {
      const resumeRes = await fetch('/api/resume/default')
      if (!resumeRes.ok) {
        toast.error('No default resume', 'Set a default resume first')
        return
      }
      const resumeData = await resumeRes.json()
      const resumeContent = resumeData.content   // unwrap ok() wrapper

      const scoreRes = await fetch('/api/ai/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeContent,
          jobTitle: job.role,
          jobCompany: job.company,
          jobDescription: job.description,
          keySkills: job.keywords ? job.keywords.split(',').map(s => s.trim()) : undefined,
        }),
      })
      if (!scoreRes.ok) {
        const d = await scoreRes.json().catch(() => ({}))
        toast.error(d.error ?? 'Scoring failed')
        return
      }
      const result = await scoreRes.json()

      const patchRes = await fetch('/api/jobs/' + job.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: result.score, keywords: result.keywords }),
      })
      if (patchRes.ok) {
        const updated = await patchRes.json()
        onUpdate(updated)
        toast.success('Scored: ' + result.score + '/100')
      } else {
        toast.error('Failed to save score')
      }
    } catch {
      toast.error('Network error — try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleScore}
      disabled={loading}
      style={{
        padding: '6px 14px', fontSize: 12, borderRadius: 6, fontWeight: 500,
        background: 'var(--bg-secondary)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        cursor: loading ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
        opacity: loading ? 0.7 : 1,
        width: 'fit-content',
      }}
    >
      {loading ? '⏳ Scoring…' : job.score != null ? '🔄 Re-score' : '📊 Score'}
    </button>
  )
}

// ── JobsPage ──────────────────────────────────────────────────────────────────
export function JobsPage() {
  const toast = useToast()
  const { navigate } = useNav()
  const [confirm, ConfirmDialog] = useConfirm()
  const [view,         setView        ] = useState<'list' | 'kanban'>('list')
  const [search,       setSearch      ] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | JobStatus>('all')
  const [showAdd,      setShowAdd     ] = useState(false)
  const [prefillStatus, setPrefillStatus] = useState<JobStatus | null>(null)
  const [jobs,         setJobs        ] = useState<Job[]>(() => defaultJobsCache?.jobs ?? [])
  const [total,        setTotal       ] = useState(() => defaultJobsCache?.total ?? 0)
  const [loading,      setLoading     ] = useState(() => defaultJobsCache === null)
  const [fetchError,   setFetchError  ] = useState<string | null>(null)
  const [selectedJob,  setSelectedJob ] = useState<Job | null>(null)
  const [page,         setPage        ] = useState(1)
  const [pageSize,     setPageSize    ] = useState(20)
  const [sortBy,       setSortBy      ] = useState<'createdAt' | 'score' | 'company' | 'role'>('createdAt')
  const [sortDir,      setSortDir     ] = useState<'asc' | 'desc'>('desc')
  const sortByRef = useRef(sortBy)
  const sortDirRef = useRef(sortDir)
  const [selectedIds,  setSelectedIds ] = useState<Set<string>>(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [scoringAll,   setScoringAll   ] = useState(false)

  // When navigating from Search page after a job save+score, force refresh
  const [refreshTick, setRefreshTick] = useState(0)
  const triggerRefresh = () => setRefreshTick(t => t + 1)

  // Reset page to 1 when search/filter/pageSize changes
  const doSearch = useCallback((q: string) => { setSearch(q); setPage(1) }, [])
  const doFilter  = useCallback((s: string) => { setFilterStatus(s as JobStatus | 'all'); setPage(1) }, [])

  // Debounced fetch
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const isDefaultView = !search && filterStatus === 'all' && page === 1 && pageSize === 20
      setLoading(!isDefaultView || defaultJobsCache === null)
      setFetchError(null)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
        if (search)                params.set('q',      search)
        if (filterStatus !== 'all') params.set('status', filterStatus)
        const res  = await fetch(`/api/jobs?${params}`, { signal: controller.signal })
        const json = await res.json()
        if (!cancelled) {
          const rawJobs: Job[] = json.jobs ?? []
          const sorted = sortJobs(rawJobs, sortByRef.current, sortDirRef.current)
          const nextTotal = json.total ?? 0
          if (isDefaultView) defaultJobsCache = { jobs: sorted, total: nextTotal }
          setJobs(sorted)
          setTotal(nextTotal)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (!cancelled) setFetchError('Failed to load jobs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, search ? 300 : 0)
    return () => { cancelled = true; controller.abort(); clearTimeout(timer) }
  }, [search, filterStatus, page, pageSize, refreshTick])

  // Sorting is entirely local: avoid turning a simple UI operation into a
  // round-trip to the jobs API.
  useEffect(() => {
    sortByRef.current = sortBy
    sortDirRef.current = sortDir
    setJobs(previous => sortJobs(previous, sortBy, sortDir))
  }, [sortBy, sortDir])

  // When the component gains focus (user navigates back from Search), refresh
  useEffect(() => {
    const onFocus = () => triggerRefresh()
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'job-saved' || e.data?.type === 'nav-refresh') triggerRefresh()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('message', onMessage) }
  }, [])

  // Deep-link: ?highlight=<jobId> from extension sidebar/popup — auto-open the job drawer
  useEffect(() => {
    if (loading || jobs.length === 0) return
    const params = new URLSearchParams(window.location.search)
    const highlightId = params.get('highlight')
    if (!highlightId) return
    const match = jobs.find(j => j.id === highlightId)
    if (match) {
      setSelectedJob(match)
      // Clean up the URL param without triggering a navigation
      const url = new URL(window.location.href)
      url.searchParams.delete('highlight')
      window.history.replaceState({}, '', url.toString())
    }
  }, [loading, jobs])

  async function handleStatusChange(jobId: string, newStatus: JobStatus) {
    // Optimistic update
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: newStatus } : j))
    const { error } = await apiMutate(`/api/jobs/${jobId}`, 'PATCH', { status: newStatus })
    if (error) {
      toast.error('Error', error)
      // Revert by re-fetching
      const params = new URLSearchParams({ pageSize: '100' })
      if (search)                params.set('q',      search)
      if (filterStatus !== 'all') params.set('status', filterStatus)
      fetch(`/api/jobs?${params}`).then(r => r.json()).then(json => {
        setJobs(json.jobs ?? [])
        setTotal(json.total ?? 0)
      })
    } else {
      toast.success('Moved', `Job moved to ${COL_LABELS[newStatus]}`)
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible(ids: string[]) {
    setSelectedIds(previous => {
      const next = new Set(previous)
      const selectAll = !ids.every(id => next.has(id))
      ids.forEach(id => selectAll ? next.add(id) : next.delete(id))
      return next
    })
  }

  async function deleteSelectedJobs() {
    const ids = [...selectedIds]
    if (!ids.length) return
    const approved = await confirm({
      title: 'Delete selected jobs?',
      message: `${ids.length} job${ids.length === 1 ? '' : 's'} will be permanently removed. This cannot be undone.`,
      danger: true,
      confirmLabel: `Delete ${ids.length}`,
    })
    if (!approved) return

    setBulkDeleting(true)
    const { data, error } = await apiMutate<{ deleted: number }>('/api/jobs', 'DELETE', { ids })
    setBulkDeleting(false)
    if (error) { toast.error('Delete failed', error); return }

    const deletedCount = data?.deleted ?? ids.length
    const deleted = new Set(ids)
    const remainingTotal = Math.max(0, total - deletedCount)
    const lastPage = Math.max(1, Math.ceil(remainingTotal / pageSize))

    setSelectedIds(new Set())
    defaultJobsCache = null
    window.dispatchEvent(new Event('applymate:jobs-changed'))
    if (page > lastPage) setPage(lastPage)
    else triggerRefresh()
    toast.success('Jobs deleted', `${deletedCount} job${deletedCount === 1 ? '' : 's'} removed`)
  }

  async function scoreAllJobs() {
    setScoringAll(true)
    const { data, error } = await apiMutate<{ scored: number; failed: number; remaining: number }>('/api/jobs/score-all', 'POST')
    setScoringAll(false)
    if (error) { toast.error('Scoring failed', error); return }

    triggerRefresh()
    if (!data?.scored) {
      toast.success('All jobs are already scored')
      return
    }
    toast.success('Match scores ready', `${data.scored} job${data.scored === 1 ? '' : 's'} scored${data.failed ? `; ${data.failed} failed` : ''}${data.remaining ? `; ${data.remaining} remaining` : ''}`)
  }

  const statusCounts = useMemo(() => ({
    saved: jobs.filter(job => job.status === 'saved').length,
    review: jobs.filter(job => job.status === 'review').length,
    interview: jobs.filter(job => job.status === 'interview').length,
  }), [jobs])
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '28px 30px 18px', background: 'var(--bg-tertiary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 28, letterSpacing: '-0.03em' }}>My Jobs</h1>
              <span style={{ fontSize: 12, color: 'var(--primary)', background: 'rgba(79,70,229,0.09)', borderRadius: 999, padding: '4px 9px', fontWeight: 600 }}>{total}</span>
            </div>
            <p style={{ margin: '7px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>Track your applications and move closer to your next opportunity.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {([
              [Bookmark, 'Saved', statusCounts.saved, '#6D5DFB'],
              [Clock3, 'In review', statusCounts.review, '#C27A12'],
              [UsersRound, 'Interviews', statusCounts.interview, '#3B6D11'],
            ] as const).map(([Icon, label, count, color]) => (
              <div key={label} style={{ minWidth: 148, padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10 }}>
                <Icon size={18} color={color} strokeWidth={1.8} /><span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{label}</span><strong style={{ marginLeft: 'auto', fontSize: 16 }}>{count}</strong>
              </div>
            ))}
            <Btn variant="primary" onClick={() => { setPrefillStatus(null); setShowAdd(true) }} style={{ minWidth: 148, height: 46, justifyContent: 'center' }}>+ Add job</Btn>
          </div>
        </div>
      </header>

      <div style={{ padding: '0 30px 30px', flex: 1 }}>
        <div style={{ padding: 14, marginBottom: 0, background: 'var(--bg)', border: '0.5px solid var(--border)', borderBottom: 'none', borderRadius: '12px 12px 0 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ width: 420, maxWidth: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', border: '0.5px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
            <Search size={17} color="var(--text-muted)" />
            <input value={search} onChange={e => doSearch(e.target.value)} placeholder="Search jobs…"
              style={{ width: '100%', padding: '10px 0', fontSize: 13, border: 'none', background: 'transparent', color: 'var(--text)', outline: 'none' }} />
          </div>
          <button onClick={scoreAllJobs} disabled={scoringAll} style={{ height: 38, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 7, border: scoringAll || selectedIds.size ? '1px solid rgba(79,70,229,0.38)' : '0.5px solid var(--border)', borderRadius: 8, background: scoringAll || selectedIds.size ? 'rgba(79,70,229,0.08)' : 'var(--bg)', color: scoringAll || selectedIds.size ? 'var(--primary)' : 'var(--text)', cursor: scoringAll ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, opacity: scoringAll ? 0.9 : 1, animation: scoringAll ? 'glowPulse 1.3s ease-in-out infinite' : 'none', transition: 'background 0.18s, border-color 0.18s, color 0.18s' }}>
            {scoringAll ? <LoaderCircle size={15} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Sparkles size={15} />} {scoringAll ? 'Scoring…' : selectedIds.size ? `Score ${selectedIds.size}` : 'Score'}
          </button>
          <button onClick={deleteSelectedJobs} disabled={!selectedIds.size || bulkDeleting} style={{ height: 38, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 7, border: '0.5px solid', borderColor: selectedIds.size ? '#E5A5A5' : 'var(--border)', borderRadius: 8, background: selectedIds.size ? '#FFF7F7' : 'var(--bg)', color: selectedIds.size ? '#A32D2D' : 'var(--text-muted)', cursor: selectedIds.size && !bulkDeleting ? 'pointer' : 'default', fontSize: 12, fontWeight: 500, opacity: bulkDeleting ? 0.65 : 1 }}>
            <Trash2 size={15} /> {bulkDeleting ? 'Deleting…' : selectedIds.size ? `Delete ${selectedIds.size}` : 'Delete'}
          </button>
          <select value={filterStatus} onChange={e => doFilter(e.target.value)} style={{ marginLeft: 'auto', padding: '10px 12px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
            <option value="all">All statuses</option>
            {KANBAN_COLS.map(c => <option key={c} value={c}>{COL_LABELS[c]}</option>)}
          </select>
          <div style={{ display: 'flex', border: '0.5px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {([['list', List], ['kanban', LayoutGrid]] as const).map(([v, Icon]) => <button key={v} onClick={() => setView(v)} aria-label={`${v} view`} style={{ padding: '8px 12px', background: view === v ? '#185FA5' : 'var(--bg)', color: view === v ? '#fff' : 'var(--text-muted)', border: 'none', cursor: 'pointer', display: 'inline-flex' }}><Icon size={17} /></button>)}
          </div>
        </div>
{loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 12 }}>
              <div style={{ width: 20, height: 20, border: '2px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Loading jobs…
            </div>
          </div>
        ) : fetchError ? (
          <Card style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{fetchError}</div>
            <Btn variant="ghost" onClick={() => setSearch(s => s)}>Retry</Btn>
          </Card>
        ) : jobs.length === 0 ? (
          <Card style={{ padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>No jobs found</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              {search || filterStatus !== 'all' ? 'Try adjusting your search or filter.' : 'Add your first job or let the AI Agent find matches for you.'}
            </div>
            <Btn variant="primary" onClick={() => { setPrefillStatus(null); setShowAdd(true) }}>+ Add Job</Btn>
          </Card>
        ) : (
          <>
            {view === 'list'
              ? <ListView jobs={jobs} onRowClick={setSelectedJob} selectedIds={selectedIds} onToggle={toggleSelected} onToggleAll={toggleAllVisible} />
              : <KanbanView jobs={jobs} onStatusChange={handleStatusChange} onAddClick={col => { setPrefillStatus(col); setShowAdd(true) }} />}

            {/* ── Pagination bar ── */}
            {total > pageSize && (
              <PaginationBar total={total} page={page} pageSize={pageSize}
                onChangePage={setPage} onChangeSize={v => { setPageSize(v); setPage(1) }}
                sortBy={sortBy} sortDir={sortDir}
                onChangeSort={(by, dir) => { setSortBy(by); setSortDir(dir) }} />
            )}
          </>
        )}
      </div>

      {showAdd && (
        <AddJobModal
          prefillStatus={prefillStatus}
          onClose={() => { setShowAdd(false); setPrefillStatus(null) }}
          onAdded={job => {
            setJobs(prev => [job, ...prev])
            setTotal(t => t + 1)
            defaultJobsCache = null
            window.dispatchEvent(new Event('applymate:jobs-changed'))
            setPrefillStatus(null)
          }}
        />
      )}

      {selectedJob && (
        <JobDetailDrawer
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onStatusChange={(id, status) => {
            handleStatusChange(id, status)
            setSelectedJob(prev => prev && prev.id === id ? { ...prev, status } : prev)
          }}
          onUpdate={updated => {
            setJobs(prev => prev.map(j => j.id === updated.id ? updated : j))
            setSelectedJob(updated)
          }}
          onDelete={id => {
            setJobs(prev => prev.filter(j => j.id !== id))
            setTotal(t => t - 1)
            setSelectedIds(prev => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
            defaultJobsCache = null
            window.dispatchEvent(new Event('applymate:jobs-changed'))
          }}
          onOpenTailoredResume={resumeId => {
            sessionStorage.setItem('applymate:resume-return', JSON.stringify({ resumeId, jobId: selectedJob.id }))
            const url = new URL(window.location.href)
            url.searchParams.set('resumeId', resumeId)
            url.searchParams.set('returnToJobs', '1')
            url.searchParams.set('returnJobId', selectedJob.id)
            window.history.replaceState({}, '', url.toString())
            navigate('resume')
          }}
        />
      )}
      <ConfirmDialog />
    </div>
  )
}
