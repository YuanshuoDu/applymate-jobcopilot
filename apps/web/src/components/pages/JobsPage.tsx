'use client'

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, CompanyLogo, INPUT_STYLE, ScorePill, StatusBadge, useToast, useConfirm } from '@/components/ui'
import type { Job, JobStatus, Activity } from '@/lib/types'
import { apiMutate, fmtDate, fmtRelative } from '@/lib/hooks'

const KANBAN_COLS: JobStatus[] = ['saved', 'applied', 'review', 'interview', 'offer', 'rejected']
const COL_LABELS: Record<JobStatus, string> = {
  saved: 'Saved', applied: 'Applied', review: 'In Review',
  interview: 'Interview', offer: 'Offer', rejected: 'Rejected',
}
const COL_COLORS: Record<JobStatus, string> = {
  saved: '#6B7280', applied: '#185FA5', review: '#854F0B',
  interview: '#3B6D11', offer: '#0E7490', rejected: '#A32D2D',
}

// ── ListView ──────────────────────────────────────────────────────────────────
function ListView({ jobs, onRowClick }: { jobs: Job[]; onRowClick: (job: Job) => void }) {
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

  return (
    <Card style={{ overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)' }}>
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
              <td style={{ padding: '10px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CompanyLogo logo={j.logo ?? j.company.slice(0, 2).toUpperCase()} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{j.company}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{j.location}</div>
                  </div>
                </div>
              </td>
              <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)' }}>{j.role}</td>
              <td style={{ padding: '10px 16px' }}><StatusBadge status={j.status} /></td>
              <td style={{ padding: '10px 16px' }}><ScorePill score={j.score ?? 0} /></td>
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
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{job.role}</div>
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

// ── ApplyBasket ───────────────────────────────────────────────────────────────
function ApplyBasket({ cart, onRemove, onClose, onJobsUpdated }: {
  cart: Job[]
  onRemove: (id: string) => void
  onClose: () => void
  onJobsUpdated: (jobs: Job[]) => void
}) {
  const toast = useToast()
  const [tailoring, setTailoring] = useState(false)
  const [tailored, setTailored] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  async function handleTailor() {
    setTailoring(true)
    let count = 0
    for (const job of cart) {
      try {
        const res = await fetch('/api/ai/cover-letter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobTitle: job.role, jobCompany: job.company, jobDescription: job.description }),
        })
        const data = await res.json()
        if (res.ok && data.coverLetter) {
          const { error } = await apiMutate(`/api/jobs/${job.id}`, 'PATCH', { coverLetter: data.coverLetter })
          if (!error) {
            setTailored(prev => new Set(prev).add(job.id))
            count++
          }
        }
      } catch { /* skip failed items */ }
    }
    setTailoring(false)
    if (count > 0) {
      toast.success('Cover letters ready', `${count}/${cart.length} generated and saved to job details`)
    } else {
      toast.error('Generation failed', 'Could not generate cover letters. Check your AI config in Settings.')
    }
  }

  async function handleApply() {
    setApplying(true)
    const now = new Date().toISOString()
    let applied = 0
    for (const job of cart) {
      const { error } = await apiMutate(`/api/jobs/${job.id}`, 'PATCH', { status: 'applied', appliedAt: now })
      if (!error) applied++
    }
    setApplying(false)
    toast.success('Applications sent', `${applied}/${cart.length} jobs marked as applied`)
    onJobsUpdated(cart.map(j => ({ ...j, status: 'applied' as const })))
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <Card style={{ width: 520, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>🛒 Apply Basket</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cart.length} jobs queued</span>
          <Btn small variant="ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</Btn>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cart.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 12 }}>No jobs in basket yet</div>
          ) : cart.map(j => (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: 'var(--bg-secondary)', borderRadius: 8 }}>
              <CompanyLogo logo={j.logo ?? j.company.slice(0, 2).toUpperCase()} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{j.role}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{j.company} · {j.location}</div>
              </div>
              <ScorePill score={j.score ?? 0} />
              {tailored.has(j.id) && <span style={{ fontSize: 10, color: '#3B6D11', fontWeight: 500 }}>✓ Tailored</span>}
              {!tailoring && <button onClick={() => onRemove(j.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>✕</button>}
            </div>
          ))}
        </div>
        {cart.length > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '0.5px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {tailored.size > 0
                ? `${tailored.size}/${cart.length} cover letters generated. Review and apply when ready.`
                : 'AI will generate a cover letter for each job, then mark them as applied.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="ghost" style={{ flex: 1 }} disabled={tailoring} onClick={handleTailor}>
                {tailoring ? 'Generating…' : '✦ Tailor CVs'}
              </Btn>
              <Btn variant="primary" style={{ flex: 1 }} disabled={applying} onClick={handleApply}>
                {applying ? 'Applying…' : 'Review & Apply →'}
              </Btn>
            </div>
          </div>
        )}
      </Card>
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
function JobDetailDrawer({ job, onClose, onStatusChange, onUpdate, onDelete }: {
  job:            Job
  onClose:        () => void
  onStatusChange: (id: string, status: JobStatus) => void
  onUpdate:       (updated: Job) => void
  onDelete:       (id: string) => void
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
  const [editingCover, setEditingCover] = useState(false)
  const [coverText,    setCoverText]    = useState(job.coverLetter ?? '')
  const [savingCover,  setSavingCover]  = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)

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
  useEffect(() => { setCoverText(job.coverLetter ?? ''); setEditingCover(false) }, [job.coverLetter])

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

  async function saveCover() {
    if (coverText === (job.coverLetter ?? '')) return
    setSavingCover(true)
    const { data, error } = await apiMutate<Job>(`/api/jobs/${job.id}`, 'PATCH', { coverLetter: coverText })
    setSavingCover(false)
    if (error) { toast.error('Save failed', error); return }
    if (data) { onUpdate(data); setEditingCover(false); toast.success('Cover letter saved') }
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

  // Drawer uses a slightly more compact variant of the shared INPUT_STYLE
  const drawerInputSt: React.CSSProperties = { ...INPUT_STYLE, fontSize: 11, padding: '5px 8px', borderRadius: 5 }

  return (
    <>
      <ConfirmDialog />
      {/* Overlay */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={onClose} />

      {/* Drawer panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, zIndex: 91,
        background: 'var(--bg)', borderLeft: '0.5px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflowY: 'auto',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <CompanyLogo logo={job.logo ?? job.company.slice(0, 2).toUpperCase()} size={36} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{job.company}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{job.role}</div>
            {job.location && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>📍 {job.location}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0, marginTop: 2 }}>✕</button>
        </div>

        {/* Meta row */}
        <div style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <StatusBadge status={job.status} />
          {job.score != null && <ScorePill score={job.score} />}
          {job.salary && <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{renderSalary(job.salary)}</span>}
          {/* Status change */}
          <select
            value={job.status}
            onChange={e => onStatusChange(job.id, e.target.value as JobStatus)}
            onClick={e => e.stopPropagation()}
            style={{ ...drawerInputSt, width: 'auto', marginLeft: 'auto' }}>
            {KANBAN_COLS.map(c => <option key={c} value={c}>{COL_LABELS[c]}</option>)}
          </select>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* URL */}
          {job.url && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>JOB POSTING</div>
              <a href={job.url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 11, color: '#185FA5', wordBreak: 'break-all' }}>
                {job.url.length > 55 ? job.url.slice(0, 52) + '…' : job.url}
              </a>
            </div>
          )}

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

          {/* Cover Letter */}
          <div>
            <div style={{ fontSize: 10, color: '#3B6D11', fontWeight: 500, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>COVER LETTER</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {savingCover && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Saving…</span>}
                {editingCover ? (
                  <>
                    <button onClick={saveCover} style={{ fontSize: 9, color: '#3B6D11', background: 'rgba(59,109,17,0.1)', border: '0.5px solid rgba(59,109,17,0.25)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer' }}>Save</button>
                    <button onClick={() => { setEditingCover(false); setCoverText(job.coverLetter ?? '') }} style={{ fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>Cancel</button>
                  </>
                ) : job.coverLetter ? (
                  <button onClick={() => setEditingCover(true)} style={{ fontSize: 9, color: '#185FA5', background: 'rgba(24,95,165,0.08)', border: '0.5px solid rgba(24,95,165,0.2)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer' }}>Edit</button>
                ) : (
                  <button onClick={() => { setCoverText(''); setEditingCover(true) }} style={{ fontSize: 9, color: '#3B6D11', background: 'rgba(59,109,17,0.1)', border: '0.5px solid rgba(59,109,17,0.25)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer' }}>+ Add</button>
                )}
              </div>
            </div>
            {editingCover ? (
              <textarea
                value={coverText}
                onChange={e => setCoverText(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveCover() } }}
                style={{ ...drawerInputSt, width: '100%', minHeight: 120, resize: 'vertical', lineHeight: 1.6, padding: '7px 9px', fontSize: 11, boxSizing: 'border-box' }}
              />
            ) : job.coverLetter ? (
              <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.7, whiteSpace: 'pre-wrap', background: 'rgba(59,109,17,0.06)', border: '0.5px solid rgba(59,109,17,0.15)', borderRadius: 6, padding: '8px 10px', maxHeight: 200, overflowY: 'auto' }}>
                {job.coverLetter}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                No cover letter yet. Click "+ Add" above or use the Apply Basket to generate one.
              </div>
            )}
          </div>

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

// ── JobsPage ──────────────────────────────────────────────────────────────────
export function JobsPage() {
  const toast = useToast()
  const [view,         setView        ] = useState<'list' | 'kanban'>('list')
  const [search,       setSearch      ] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | JobStatus>('all')
  const [showCart,     setShowCart    ] = useState(false)
  const [showAdd,      setShowAdd     ] = useState(false)
  const [prefillStatus, setPrefillStatus] = useState<JobStatus | null>(null)
  const [cart,         setCart        ] = useState<Job[]>([])
  const [jobs,         setJobs        ] = useState<Job[]>([])
  const [total,        setTotal       ] = useState(0)
  const [loading,      setLoading     ] = useState(true)
  const [fetchError,   setFetchError  ] = useState<string | null>(null)
  const [selectedJob,  setSelectedJob ] = useState<Job | null>(null)
  const [page,         setPage        ] = useState(1)
  const [pageSize,     setPageSize    ] = useState(20)
  const [sortBy,       setSortBy      ] = useState<'createdAt' | 'score' | 'company' | 'role'>('createdAt')
  const [sortDir,      setSortDir     ] = useState<'asc' | 'desc'>('desc')

  // When navigating from Search page after a job save+score, force refresh
  const [refreshTick, setRefreshTick] = useState(0)
  const triggerRefresh = () => setRefreshTick(t => t + 1)

  // Reset page to 1 when search/filter/pageSize changes
  const doSearch = useCallback((q: string) => { setSearch(q); setPage(1) }, [])
  const doFilter  = useCallback((s: string) => { setFilterStatus(s as JobStatus | 'all'); setPage(1) }, [])

  // Debounced fetch
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setFetchError(null)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
        if (search)                params.set('q',      search)
        if (filterStatus !== 'all') params.set('status', filterStatus)
        const res  = await fetch(`/api/jobs?${params}`)
        const json = await res.json()
        if (!cancelled) {
          const rawJobs: Job[] = json.jobs ?? []
          // Client-side sort (API returns createdAt desc by default; override for other sorts)
          const sorted = [...rawJobs].sort((a, b) => {
            let cmp = 0
            if (sortBy === 'score') {
              cmp = (a.score ?? -1) - (b.score ?? -1)
            } else if (sortBy === 'company') {
              cmp = a.company.localeCompare(b.company)
            } else if (sortBy === 'role') {
              cmp = a.role.localeCompare(b.role)
            }
            // createdAt is default from API, no extra sort needed
            if (sortBy === 'createdAt' || cmp === 0) {
              cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            }
            return sortDir === 'desc' ? cmp : -cmp
          })
          setJobs(sorted)
          setTotal(json.total ?? 0)
        }
      } catch {
        if (!cancelled) setFetchError('Failed to load jobs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, search ? 300 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [search, filterStatus, page, pageSize, sortBy, sortDir, refreshTick])

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

  function addToCart(job: Job) {
    if (cart.find(c => c.id === job.id)) return
    setCart(c => [...c, job])
    toast.success('Added to Apply Basket', `${job.role} at ${job.company}`)
  }

  const savedApplied = jobs.filter(j => j.status === 'saved' || j.status === 'applied').slice(0, 4)

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Jobs">
        {/* Total count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>
            {total}
          </span>
        </div>
        {/* Search */}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search jobs…"
          style={{ width: 220, padding: '5px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }} />
        {/* Status filter */}
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'all' | JobStatus)}
          style={{ padding: '5px 8px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
          <option value="all">All Status</option>
          {KANBAN_COLS.map(c => <option key={c} value={c}>{COL_LABELS[c]}</option>)}
        </select>
        {/* View toggle */}
        <div style={{ display: 'flex', border: '0.5px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {([['list', '☰'], ['kanban', '⊞']] as const).map(([v, icon]) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '5px 10px',
              background: view === v ? '#185FA5' : 'var(--bg)',
              color:      view === v ? '#fff'     : 'var(--text-muted)',
              border: 'none', cursor: 'pointer', fontSize: 13,
            }}>{icon}</button>
          ))}
        </div>
        {/* Basket */}
        <Btn variant={cart.length ? 'primary' : 'ghost'} onClick={() => setShowCart(true)}>
          🛒 Basket {cart.length > 0 && <span style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 999, padding: '1px 6px', fontSize: 10, marginLeft: 4 }}>{cart.length}</span>}
        </Btn>
<Btn variant="ghost" onClick={() => { setPrefillStatus(null); setShowAdd(true) }}>+ Add Job</Btn>
      </TopBar>

      <div style={{ padding: 20, flex: 1 }}>
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
            {/* Quick-add to basket bar (list view only) */}
            {view === 'list' && savedApplied.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Click &quot;Add to Basket&quot; to queue jobs for AI-optimized batch apply
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {savedApplied.map(j => (
                    <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}>
                      <CompanyLogo logo={j.logo ?? j.company.slice(0, 2).toUpperCase()} size={18} />
                      <span style={{ fontSize: 11 }}>{j.company}</span>
                      <ScorePill score={j.score ?? 0} />
                      <button onClick={() => addToCart(j)} style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 999, border: '0.5px solid var(--border)',
                        background: cart.find(c => c.id === j.id) ? 'rgba(24,95,165,0.12)' : 'transparent',
                        color:      cart.find(c => c.id === j.id) ? '#185FA5'              : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}>
                        {cart.find(c => c.id === j.id) ? '✓ Added' : '+ Basket'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {view === 'list'
              ? <ListView jobs={jobs} onRowClick={setSelectedJob} />
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

      {showCart && (
        <ApplyBasket
          cart={cart}
          onRemove={id => setCart(c => c.filter(x => x.id !== id))}
          onClose={() => setShowCart(false)}
          onJobsUpdated={updated => {
            setJobs(prev => prev.map(j => {
              const u = updated.find(x => x.id === j.id)
              return u ?? j
            }))
            setCart([])
          }}
        />
      )}
      {showAdd && (
        <AddJobModal
          prefillStatus={prefillStatus}
          onClose={() => { setShowAdd(false); setPrefillStatus(null) }}
          onAdded={job => { setJobs(prev => [job, ...prev]); setTotal(t => t + 1); setPrefillStatus(null) }}
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
          }}
        />
      )}
    </div>
  )
}
