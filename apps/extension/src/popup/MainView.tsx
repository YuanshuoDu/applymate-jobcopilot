import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Bookmark, ChevronRight, ExternalLink, Folder, LoaderCircle, Sparkles } from 'lucide-react'
import { getResume, listResumes, scoreResume } from '@/lib/api'
import { getCurrentResumeId } from '@/lib/storage'
import type { DashboardStats, ExtensionSettings, SavedJob, ScoreResult, ScrapedJob } from '@/lib/types'
import { C } from './popup-constants'
import { ActionRow, countPill, Divider, EmptyJob, footerLink, InlineMessage, primaryAction } from './PopupActions'
import { PopupHeader } from './PopupHeader'
import { DetectionRow, JobSummary } from './PopupJobCard'
import { getLabels, isSavedJobsResponse, isSaveResponse, isScrapedJob, isStatsResponse, openSidePanel, sameJob } from './popup-utils'

export function PopupMainView({ settings, onSettings, onLogout }: {
  settings: ExtensionSettings
  onSettings: () => void
  onLogout: () => void
}) {
  const labels = getLabels()
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [savedJobs, setSavedJobs] = useState<SavedJob[]>([])
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [score, setScore] = useState<ScoreResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: 'PING' }).catch(() => {})
      const local = await chrome.storage.local.get('currentJob')
      const current = isScrapedJob(local.currentJob) ? local.currentJob : null
      const [recentResponse, statsResponse] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }).catch(() => null),
        chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => null),
      ])
      if (cancelled) return
      setCurrentJob(current)
      setSavedJobs(isSavedJobsResponse(recentResponse) ? recentResponse.jobs : [])
      setStats(isStatsResponse(statsResponse) ? statsResponse.stats : null)
      setLoading(false)
    }
    void load()

    const onJobDetected = (messageEvent: { type: string; job?: ScrapedJob }) => {
      if (messageEvent.type === 'JOB_SCRAPED' && isScrapedJob(messageEvent.job)) setCurrentJob(messageEvent.job)
    }
    chrome.runtime.onMessage.addListener(onJobDetected)
    return () => { cancelled = true; chrome.runtime.onMessage.removeListener(onJobDetected) }
  }, [])

  const savedJob = useMemo(() => currentJob ? savedJobs.find(job => sameJob(currentJob, job)) ?? null : null, [currentJob, savedJobs])
  const matchScore = savedJob?.score ?? score?.score ?? null
  const count = stats?.total ?? savedJobs.length

  async function handleSave() {
    if (!currentJob || savedJob || saving) return
    setSaving(true)
    setMessage('')
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob }).catch(() => null)
      if (!isSaveResponse(response) || !response.success) throw new Error(response?.error ?? 'Save failed')
      if (response.savedJob) setSavedJobs(previous => [response.savedJob!, ...previous])
      setMessage('saved')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleAnalyze() {
    if (!currentJob || analyzing) return
    setAnalyzing(true)
    setMessage('')
    try {
      const resumeList = await listResumes(settings)
      const currentResumeId = await getCurrentResumeId()
      const resumeId = currentResumeId && resumeList.some(resume => resume.id === currentResumeId) ? currentResumeId : resumeList[0]?.id
      if (!resumeId) throw new Error(labels.noResume)
      const resume = await getResume(settings, resumeId)
      const result = await scoreResume(settings, { resumeContent: resume.content, jobTitle: currentJob.title, jobCompany: currentJob.company, jobDescription: currentJob.description })
      setScore(result)
      setMessage('analyzed')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : labels.analyzeError)
    } finally {
      setAnalyzing(false)
    }
  }

  const openDashboard = () => chrome.tabs.create({ url: `${settings.apiBaseUrl}/jobs` })
  if (loading) return <PopupLoading />

  return (
    <div style={{ background: C.bg, color: C.navy, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <PopupHeader user={settings.userName || settings.userEmail} onSettings={onSettings} onLogout={onLogout} onDashboard={openDashboard} labels={labels} />
      <main style={{ padding: '18px 12px 0' }}>
        <DetectionRow job={currentJob} labels={labels} />
        {currentJob ? <>
          <JobSummary job={currentJob} score={matchScore} labels={labels} />
          <div style={{ marginTop: 12, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: C.shadow }}>
            <ActionRow icon={<Bookmark size={21} strokeWidth={1.8} />} title={savedJob ? labels.savedJob : labels.saveJob} subtitle={savedJob ? 'Synced to your ApplyMate workspace' : labels.saveJobSub} onClick={handleSave} loading={saving} success={!!savedJob || message === 'saved'} />
            <Divider />
            <ActionRow icon={<BarChart3 size={21} strokeWidth={1.8} />} title={labels.analyzeMatch} subtitle={analyzing ? 'AI is reviewing your profile…' : labels.analyzeMatchSub} onClick={() => void handleAnalyze()} loading={analyzing} success={message === 'analyzed'} />
            <div style={{ padding: 12 }}><button type="button" onClick={openSidePanel} style={primaryAction}><Sparkles size={21} strokeWidth={1.8} /><span style={{ flex: 1, textAlign: 'left' }}><strong>{labels.prepare}</strong><small>{labels.prepareSub}</small></span><ChevronRight size={21} strokeWidth={2} /></button></div>
          </div>
          {message && message !== 'saved' && message !== 'analyzed' && <InlineMessage text={message} />}
        </> : <EmptyJob labels={labels} />}
      </main>
      <footer style={{ marginTop: 12, padding: '14px 16px 16px', borderTop: `1px solid ${C.border}`, background: C.panel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button type="button" onClick={openDashboard} style={footerLink}><Folder size={20} strokeWidth={1.8} /><span>{labels.savedJobs}</span><span style={countPill}>{count}</span></button>
        <button type="button" onClick={openSidePanel} style={{ ...footerLink, color: C.primary, fontWeight: 650 }}><span>{labels.openSidebar}</span><ExternalLink size={17} strokeWidth={1.8} /></button>
      </footer>
    </div>
  )
}

function PopupLoading() {
  return <div style={{ height: 280, display: 'grid', placeItems: 'center', background: C.bg, color: C.muted }}><LoaderCircle size={22} strokeWidth={1.8} className="am-spin" /></div>
}
