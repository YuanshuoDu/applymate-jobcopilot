'use client'

import React, { useState } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, CompanyLogo, MatchScoreRing, ScorePill, StatusBadge, useToast } from '@/components/ui'

const JD_MOCK = {
  company: 'Adyen',
  logo: 'AD',
  role: 'Backend Engineer',
  location: 'Amsterdam, NL · Hybrid',
  salary: '€70,000 – €90,000',
  score: 91,
  tags: ['Python','Kafka','PostgreSQL','AWS','gRPC','Microservices'],
  missing: ['Go','Rust','Prometheus'],
  snippet: 'We are looking for a Backend Engineer to join our Payments Core team. You will build and maintain high-throughput, low-latency services that process millions of transactions daily...',
}

const RECENT_JOBS = [
  { id:1, logo:'BK', company:'Booking.com', role:'Software Engineer',   status:'applied'   as const, score:84 },
  { id:2, logo:'ZA', company:'Zalando',     role:'Platform Engineer',   status:'saved'     as const, score:81 },
  { id:3, logo:'SP', company:'Spotify',     role:'Backend Developer',   status:'saved'     as const, score:79 },
]

export function ExtensionPage() {
  const toast = useToast()
  const [added, setAdded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'popup'|'sidebar'>('popup')

  return (
    <div style={{ flex:1, overflowY:'auto', background:'var(--bg-tertiary)' }}>
      <TopBar title="Extension — Chrome Preview">
        <div style={{ display:'flex', border:'0.5px solid var(--border)', borderRadius:6, overflow:'hidden' }}>
          {(['popup','sidebar'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding:'5px 12px', background: tab===t ? 'var(--primary)' : 'var(--bg)',
              color: tab===t ? '#fff' : 'var(--text-muted)', border:'none', cursor:'pointer', fontSize:11, textTransform:'capitalize',
            }}>{t}</button>
          ))}
        </div>
        <span style={{ fontSize:11, color:'var(--text-muted)' }}>Simulated chrome extension UI</span>
      </TopBar>

      <div style={{ padding:24, display:'flex', gap:20, alignItems:'flex-start' }}>
        {tab === 'popup' ? (
          /* ── Popup view ── */
          <div style={{ display:'flex', gap:24, alignItems:'flex-start' }}>
            {/* Fake browser frame */}
            <div style={{ background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:12, overflow:'hidden', width:640 }}>
              <div style={{ padding:'10px 14px', borderBottom:'0.5px solid var(--border)', display:'flex', alignItems:'center', gap:8, background:'#f1f3f4' }}>
                <div style={{ display:'flex', gap:5 }}>
                  {['#FF5F57','#FEBC2E','#28C840'].map(c => <div key={c} style={{ width:10, height:10, borderRadius:'50%', background:c }} />)}
                </div>
                <div style={{ flex:1, background:'white', borderRadius:4, padding:'4px 10px', fontSize:11, color:'#666' }}>careers.adyen.com/jobs/backend-engineer</div>
              </div>
              <div style={{ padding:20 }}>
                <div style={{ fontSize:18, fontWeight:500, marginBottom:6 }}>{JD_MOCK.role}</div>
                <div style={{ fontSize:13, color:'#666', marginBottom:12 }}>{JD_MOCK.company} · {JD_MOCK.location}</div>
                <div style={{ fontSize:12, color:'#444', lineHeight:1.8, marginBottom:16 }}>{JD_MOCK.snippet}</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:16 }}>
                  {JD_MOCK.tags.map(t => <span key={t} style={{ fontSize:11, background:'#e8f0fe', color:'#1a73e8', borderRadius:4, padding:'2px 8px' }}>{t}</span>)}
                </div>
                {/* Injected ApplyMate button */}
                <div style={{ padding:12, background:'rgba(79,70,229,0.06)', border:'1px solid rgba(79,70,229,0.20)', borderRadius:8, display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:20, height:20, borderRadius:4, background:'var(--primary)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10, fontWeight:700 }}>A</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:11, fontWeight:500, color:'var(--primary)' }}>ApplyMate AI</div>
                    <div style={{ fontSize:10, color:'#666' }}>Match score: <strong style={{ color:'var(--primary)' }}>91%</strong> · 3 keyword gaps</div>
                  </div>
                  <button onClick={() => { setAdded(true); toast.success('Added to basket', 'Adyen · Backend Engineer') }}
                    style={{ padding:'5px 12px', background: added ? 'var(--c-success)' : 'var(--primary)', color:'#fff', border:'none', borderRadius:6, fontSize:11, cursor:'pointer', fontWeight:500 }}>
                    {added ? '✓ Added' : '+ Add to Basket'}
                  </button>
                </div>
              </div>
            </div>

            {/* Popup widget */}
            <div style={{ width:300, background:'var(--bg)', border:'0.5px solid var(--border)', borderRadius:12, overflow:'hidden', boxShadow:'0 8px 32px rgba(0,0,0,0.12)' }}>
              <div style={{ padding:'12px 14px', borderBottom:'0.5px solid var(--border)', background:'var(--primary)', display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ width:20, height:20, borderRadius:5, background:'rgba(255,255,255,0.2)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10, fontWeight:700 }}>A</div>
                <span style={{ fontSize:13, fontWeight:500, color:'#fff' }}>ApplyMate AI</span>
                <span style={{ marginLeft:'auto', fontSize:10, color:'rgba(255,255,255,0.7)' }}>Adyen detected</span>
              </div>

              <div style={{ padding:14 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                  <CompanyLogo logo={JD_MOCK.logo} size={32} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontWeight:500 }}>{JD_MOCK.role}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)' }}>{JD_MOCK.company} · {JD_MOCK.location}</div>
                  </div>
                  <MatchScoreRing score={JD_MOCK.score} size="sm" />
                </div>

                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:4 }}>KEYWORD GAPS</div>
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                    {JD_MOCK.missing.map(k => <span key={k} style={{ fontSize:10, background:'rgba(220,38,38,0.10)', color:'var(--c-danger)', borderRadius:999, padding:'1px 7px' }}>{k}</span>)}
                  </div>
                </div>

                <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                  <Btn small variant="ghost" style={{ flex:1, justifyContent:'center' }} onClick={() => toast.info('Opening resume…')}>✎ Tailor CV</Btn>
                  <Btn small variant="primary" style={{ flex:1, justifyContent:'center' }} onClick={() => { setAdded(true); toast.success('Added to basket', `${JD_MOCK.role} at ${JD_MOCK.company}`) }}>
                    {added ? '✓ Added' : '+ Basket'}
                  </Btn>
                </div>

                <div style={{ borderTop:'0.5px solid var(--border)', paddingTop:10 }}>
                  <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:6 }}>RECENT</div>
                  {RECENT_JOBS.map(j => (
                    <div key={j.id} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:6 }}>
                      <CompanyLogo logo={j.logo} size={18} />
                      <span style={{ fontSize:11, flex:1 }}>{j.company}</span>
                      <ScorePill score={j.score} />
                      <StatusBadge status={j.status} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Sidebar view ── */
          <div style={{ display:'flex', gap:24, alignItems:'flex-start' }}>
            <div style={{ background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:12, overflow:'hidden', width:480 }}>
              <div style={{ padding:'10px 14px', borderBottom:'0.5px solid var(--border)', display:'flex', alignItems:'center', gap:8, background:'#f1f3f4' }}>
                <div style={{ display:'flex', gap:5 }}>
                  {['#FF5F57','#FEBC2E','#28C840'].map(c => <div key={c} style={{ width:10, height:10, borderRadius:'50%', background:c }} />)}
                </div>
                <div style={{ flex:1, background:'white', borderRadius:4, padding:'4px 10px', fontSize:11, color:'#666' }}>linkedin.com/jobs/view/123456</div>
              </div>
              <div style={{ padding:20, fontSize:12, color:'#444', lineHeight:1.8 }}>
                <div style={{ fontSize:16, fontWeight:600, marginBottom:4 }}>Backend Engineer</div>
                <div style={{ color:'#666', marginBottom:12 }}>Adyen · Amsterdam · Full-time</div>
                <div style={{ marginBottom:12 }}>We are seeking a talented Backend Engineer to join our Payments Core team. Build high-throughput, distributed payment processing services at scale.</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                  {JD_MOCK.tags.map(t => <span key={t} style={{ fontSize:10, background:'#e8f0fe', color:'#1a73e8', borderRadius:4, padding:'2px 7px' }}>{t}</span>)}
                </div>
              </div>
            </div>

            <div style={{ width:280, background:'var(--bg)', border:'0.5px solid var(--border)', borderRadius:12, overflow:'hidden' }}>
              <div style={{ padding:'10px 14px', background:'var(--primary)', display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:18, height:18, borderRadius:4, background:'rgba(255,255,255,0.2)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:9, fontWeight:700 }}>A</div>
                <span style={{ fontSize:12, fontWeight:500, color:'#fff' }}>ApplyMate Sidebar</span>
              </div>
              <div style={{ padding:14, display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <MatchScoreRing score={91} size="lg" showLabel />
                  <div>
                    <div style={{ fontSize:12, fontWeight:500 }}>Strong match</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)' }}>Your profile aligns well</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:10, fontWeight:500, color:'var(--text-muted)', marginBottom:6 }}>QUICK ACTIONS</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    <Btn variant="primary" style={{ width:'100%', justifyContent:'center' }} onClick={() => { setAdded(true); toast.success('Added to basket') }}>
                      {added ? '✓ In Basket' : '+ Add to Apply Basket'}
                    </Btn>
                    <Btn variant="ghost" style={{ width:'100%', justifyContent:'center' }} onClick={() => toast.info('Tailoring CV…')}>✦ Tailor CV for this role</Btn>
                    <Btn variant="ghost" style={{ width:'100%', justifyContent:'center' }} onClick={() => toast.info('Generating cover letter…')}>📝 Generate Cover Letter</Btn>
                  </div>
                </div>
                <div style={{ borderTop:'0.5px solid var(--border)', paddingTop:10 }}>
                  <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:4 }}>MISSING KEYWORDS</div>
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                    {JD_MOCK.missing.map(k => <span key={k} style={{ fontSize:10, background:'rgba(220,38,38,0.10)', color:'var(--c-danger)', borderRadius:999, padding:'2px 7px' }}>{k}</span>)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
