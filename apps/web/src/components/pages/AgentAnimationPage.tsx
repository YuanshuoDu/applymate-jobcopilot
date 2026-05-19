'use client'

import React, { useEffect, useRef, useState } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, CompanyLogo, ScorePill, useToast } from '@/components/ui'

const PIPELINE_STAGES = [
  { id:'scan',   icon:'🔍', label:'Scanning',    color:'var(--primary)',   desc:'Crawling LinkedIn · Indeed · Career pages' },
  { id:'match',  icon:'🎯', label:'Matching',    color:'var(--accent)',    desc:'AI scoring against your profile' },
  { id:'tailor', icon:'✦',  label:'Tailoring CV', color:'var(--c-info)',   desc:'Rewriting keywords + optimizing bullets' },
  { id:'cover',  icon:'📝', label:'Cover Letter', color:'var(--c-warning)', desc:'Generating personalised letter' },
  { id:'review', icon:'👁', label:'Your Review', color:'var(--c-success)', desc:'Human approval required' },
  { id:'submit', icon:'📤', label:'Submitting',  color:'var(--primary)',   desc:'Auto-filling and sending' },
  { id:'done',   icon:'✓',  label:'Confirmed',   color:'var(--c-success)', desc:'Tracker updated · Gmail watching' },
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
    toast.info('Demo reset')
  }

  return (
    <div style={{ flex:1, overflowY:'auto', background:'var(--bg-tertiary)' }}>
      <TopBar title="Flow Demo — AI Agent Pipeline">
        <Btn variant="ghost" onClick={reset}>↺ Reset</Btn>
        <Btn variant={playing ? 'danger' : 'primary'} onClick={() => setPlaying(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play Demo'}
        </Btn>
      </TopBar>

      <div style={{ padding:24, display:'flex', flexDirection:'column', gap:20 }}>
        {/* Pipeline stages */}
        <Card style={{ padding:20 }}>
          <div style={{ fontSize:12, fontWeight:500, marginBottom:16 }}>Application Pipeline</div>
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
                  <div style={{ fontSize:10, fontWeight: i === currentStage ? 500 : 400, color: i <= currentStage ? stage.color : 'var(--text-muted)', textAlign:'center' }}>{stage.label}</div>
                  {i === currentStage && playing && (
                    <div style={{ fontSize:9, color:stage.color, textAlign:'center', maxWidth:72, lineHeight:1.4 }}>{stage.desc}</div>
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
                  <span style={{ fontSize:11, color:stage.color, fontWeight:500 }}>{stage.label}</span>
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
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Listings scanned</div>
          </Card>
          <Card style={{ padding:14, textAlign:'center' }}>
            <div style={{ fontSize:24, fontWeight:500, color:'var(--c-success)' }}>{Math.floor(scanCount * 0.1) + 8}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Applications sent</div>
          </Card>
          <Card style={{ padding:14, textAlign:'center' }}>
            <div style={{ fontSize:24, fontWeight:500, color:'var(--c-warning)' }}>3</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Awaiting review</div>
          </Card>
        </div>
      </div>
    </div>
  )
}
