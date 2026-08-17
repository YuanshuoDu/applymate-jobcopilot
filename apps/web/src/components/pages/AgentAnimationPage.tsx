'use client'

import React, { useEffect, useRef, useState } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, CompanyLogo, ScorePill, useToast } from '@/components/ui'
import { useI18n } from '@/lib/i18n'

const PIPELINE_STAGES = [
  { id:'scan',   icon:'🔍', color:'var(--primary)' },
  { id:'match',  icon:'🎯', color:'var(--accent)' },
  { id:'tailor', icon:'✦',  color:'var(--c-info)' },
  { id:'cover',  icon:'📝', color:'var(--c-warning)' },
  { id:'review', icon:'👁', color:'var(--c-success)' },
  { id:'submit', icon:'📤', color:'var(--primary)' },
  { id:'done',   icon:'✓',  color:'var(--c-success)' },
]

const SAMPLE_JOBS = [
  { id:1, logo:'AD', company:'Adyen',       role:'Backend Engineer',    score:91, stageIdx:6 },
  { id:2, logo:'BK', company:'Booking.com', role:'Software Engineer',   score:84, stageIdx:4 },
  { id:3, logo:'ZA', company:'Zalando',     role:'Platform Engineer',   score:81, stageIdx:2 },
  { id:4, logo:'SP', company:'Spotify',     role:'Backend Developer',   score:79, stageIdx:1 },
  { id:5, logo:'ST', company:'Stripe',      role:'Data Infra Engineer', score:88, stageIdx:0 },
]

export function AgentAnimationPage() {
  const toast = useToast()
  const { t } = useI18n()
  const [playing, setPlaying] = useState(false)
  const [currentStage, setCurrentStage] = useState(0)
  const [jobs, setJobs] = useState(SAMPLE_JOBS)
  const [scanCount, setScanCount] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setCurrentStage(s => {
          const next = (s + 1) % PIPELINE_STAGES.length
          if (next === 0) setScanCount(c => c + 1)
          return next
        })
        setScanCount(c => c + Math.floor(Math.random() * 3))
        setJobs(prev => prev.map(j => ({
          ...j,
          stageIdx: Math.min(PIPELINE_STAGES.length - 1, j.stageIdx + (Math.random() > 0.6 ? 1 : 0)),
        })))
      }, 900)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing])

  function reset() {
    setPlaying(false)
    setCurrentStage(0)
    setScanCount(0)
    setJobs(SAMPLE_JOBS)
    toast.info(t('agentDemo.reset'))
  }

  return (
    <div style={{ flex:1, overflowY:'auto', background:'var(--bg-tertiary)' }}>
      <TopBar title={t('agentDemo.title')}>
        <Btn variant="ghost" onClick={reset}>↺ {t('agentDemo.reset')}</Btn>
        <Btn variant={playing ? 'danger' : 'primary'} onClick={() => setPlaying(!playing)}>
          {playing ? `⏸ ${t('agentDemo.pause')}` : `▶ ${t('agentDemo.play')}`}
        </Btn>
      </TopBar>

      <div style={{ padding:24, display:'flex', flexDirection:'column', gap:20 }}>
        {/* Pipeline stages */}
        <Card style={{ padding:20 }}>
          <div style={{ fontSize:12, fontWeight:500, marginBottom:16 }}>{t('agentDemo.pipeline')}</div>
          <div style={{ display:'flex', alignItems:'center', gap:0, overflowX:'auto' }}>
            {PIPELINE_STAGES.map((stage, i) => (
              <React.Fragment key={stage.id}>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:80 }}>
                  <div style={{
                    width:44, height:44, borderRadius:'50%',
                    background: i <= currentStage ? stage.color : 'var(--bg-tertiary)',
                    color: i <= currentStage ? '#fff' : 'var(--text-muted)',
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize:18,
                    transition:'all 0.4s',
                    boxShadow: i === currentStage && playing ? `0 0 0 6px ${stage.color}22` : 'none',
                  }}>{stage.icon}</div>
                  <div style={{ fontSize:10, fontWeight: i === currentStage ? 500 : 400, color: i <= currentStage ? stage.color : 'var(--text-muted)', textAlign:'center' }}>{t(`agentDemo.stage.${stage.id}.label`)}</div>
                  {i === currentStage && playing && (
                    <div style={{ fontSize:9, color:stage.color, textAlign:'center', maxWidth:72, lineHeight:1.4 }}>{t(`agentDemo.stage.${stage.id}.description`)}</div>
                  )}
                </div>
                {i < PIPELINE_STAGES.length - 1 && (
                  <div style={{ flex:1, height:2, background: i < currentStage ? PIPELINE_STAGES[i].color : 'var(--border)', transition:'background 0.4s', minWidth:16 }} />
                )}
              </React.Fragment>
            ))}
          </div>
        </Card>

        {/* Live job cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(200px,1fr))', gap:12 }}>
          {jobs.map(job => {
            const stage = PIPELINE_STAGES[job.stageIdx]
            return (
              <Card key={job.id} style={{ padding:14 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <CompanyLogo logo={job.logo} />
                  <div>
                    <div style={{ fontSize:12, fontWeight:500 }}>{job.company}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)' }}>{job.role}</div>
                  </div>
                  <ScorePill score={job.score} />
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:14 }}>{stage.icon}</span>
                  <span style={{ fontSize:11, color:stage.color, fontWeight:500 }}>{t(`agentDemo.stage.${stage.id}.label`)}</span>
                </div>
                <div style={{ marginTop:8, height:3, background:'var(--bg-tertiary)', borderRadius:2, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${((job.stageIdx+1)/PIPELINE_STAGES.length)*100}%`, background:stage.color, borderRadius:2, transition:'width 0.6s' }} />
                </div>
              </Card>
            )
          })}
        </div>

        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          <Card style={{ padding:14, textAlign:'center' }}>
            <div style={{ fontSize:24, fontWeight:500, color:'var(--primary)' }}>{scanCount + 78}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{t('agentDemo.listingsScanned')}</div>
          </Card>
          <Card style={{ padding:14, textAlign:'center' }}>
            <div style={{ fontSize:24, fontWeight:500, color:'var(--c-success)' }}>{Math.floor(scanCount * 0.1) + 8}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{t('agentDemo.applicationsSent')}</div>
          </Card>
          <Card style={{ padding:14, textAlign:'center' }}>
            <div style={{ fontSize:24, fontWeight:500, color:'var(--c-warning)' }}>3</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{t('agentDemo.awaitingReview')}</div>
          </Card>
        </div>
      </div>
    </div>
  )
}
