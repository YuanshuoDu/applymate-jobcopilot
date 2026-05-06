'use client'

import { useState } from 'react'
import { MatchScoreRing, Divider } from '@/components/ui'
import type { Job, ScoreResult, Suggestion } from '@/lib/types'

function SectionHeader({ label, count, collapsed, onToggle }: {
  label:     string
  count?:    number
  collapsed: boolean
  onToggle:  () => void
}) {
  return (
    <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}>
      <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>
        {label}
        {count !== undefined && count > 0 && (
          <span style={{ marginLeft: 5, background: 'rgba(24,95,165,0.12)', color: '#185FA5', borderRadius: 999, padding: '1px 6px', fontSize: 9, fontWeight: 600 }}>{count}</span>
        )}
      </span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{collapsed ? '▶' : '▼'}</span>
    </div>
  )
}

export function AiPanel({ selectedJob, scoreResult, suggestions, scoring, suggesting, noJobSelected, onApplySuggestion, onAnalyze, onAddKeyword }: {
  selectedJob:       Job | null
  scoreResult:       ScoreResult | null
  suggestions:       Suggestion[]
  scoring:           boolean
  suggesting:        boolean
  noJobSelected:     boolean
  onApplySuggestion: (i: number) => void
  onAnalyze:         () => void
  onAddKeyword:      (kw: string) => void
}) {
  const [kwCollapsed,      setKwCollapsed]      = useState(false)
  const [suggestCollapsed, setSuggestCollapsed] = useState(false)
  const [scoresCollapsed,  setScoresCollapsed]  = useState(false)
  const [copied,           setCopied]           = useState<number | null>(null)

  function copySuggestion(text: string, i: number) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(i)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const pendingSuggestions = suggestions.filter(s => !s.applied).length

  return (
    <div style={{ width: 280, flexShrink: 0, borderLeft: '0.5px solid var(--border)', background: 'var(--bg-secondary)', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Job context + score ring */}
      <div style={{ background: 'rgba(24,95,165,0.06)', border: '0.5px solid rgba(24,95,165,0.2)', borderRadius: 7, padding: 10 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>TAILORING FOR</div>
        {selectedJob ? (
          <>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{selectedJob.role}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selectedJob.company}</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              {scoring ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 16, height: 16, border: '2px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Analyzing…</span>
                </div>
              ) : scoreResult ? (
                <>
                  <MatchScoreRing score={scoreResult.score} size="sm" showLabel />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>match score</span>
                  <button onClick={onAnalyze} title="Re-analyze" style={{ fontSize: 11, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>↻</button>
                </>
              ) : (
                <button onClick={onAnalyze} style={{ fontSize: 11, color: '#185FA5', background: 'rgba(24,95,165,0.08)', border: '0.5px solid rgba(24,95,165,0.2)', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' }}>
                  ✦ Analyze match
                </button>
              )}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Select a job above to see how well your resume matches it.</div>
        )}
      </div>

      {/* Keyword analysis */}
      {scoreResult && (
        <>
          <div>
            <SectionHeader
              label="KEYWORD GAPS"
              count={scoreResult.missingKeywords.length}
              collapsed={kwCollapsed}
              onToggle={() => setKwCollapsed(v => !v)}
            />
            {!kwCollapsed && (
              <div style={{ marginTop: 8 }}>
                {scoreResult.missingKeywords.length === 0 ? (
                  <div style={{ fontSize: 11, color: '#3B6D11' }}>✓ No major gaps found</div>
                ) : (
                  <>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>Click to add to skills</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                      {scoreResult.missingKeywords.map(kw => (
                        <button key={kw} onClick={() => onAddKeyword(kw)} title="Add to skills" style={{
                          fontSize: 10, background: 'rgba(163,45,45,0.1)', color: '#A32D2D', borderRadius: 999,
                          padding: '2px 8px', border: '0.5px solid rgba(163,45,45,0.2)', cursor: 'pointer',
                          transition: 'all 0.1s',
                        }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(163,45,45,0.2)' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(163,45,45,0.1)' }}>
                          + {kw}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>MATCHED ({scoreResult.matchedKeywords.length})</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {scoreResult.matchedKeywords.map(kw => (
                    <span key={kw} style={{ fontSize: 10, background: 'rgba(59,109,17,0.1)', color: '#3B6D11', borderRadius: 999, padding: '2px 7px' }}>{kw}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Divider />
        </>
      )}

      {/* AI Suggestions */}
      <div>
        <SectionHeader
          label="AI SUGGESTIONS"
          count={pendingSuggestions || undefined}
          collapsed={suggestCollapsed}
          onToggle={() => setSuggestCollapsed(v => !v)}
        />
        {!suggestCollapsed && (
          <div style={{ marginTop: 8 }}>
            {suggesting ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                <div style={{ width: 14, height: 14, border: '2px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                Generating suggestions…
              </div>
            ) : suggestions.length > 0 ? (
              suggestions.map((s, i) => (
                <div key={i} style={{ marginBottom: 8, padding: 8, background: s.applied ? 'rgba(59,109,17,0.06)' : 'var(--bg)', border: `0.5px solid ${s.applied ? 'rgba(59,109,17,0.2)' : 'var(--border)'}`, borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: s.applied ? '#3B6D11' : 'var(--text)', marginBottom: 6, lineHeight: 1.5 }}>{s.text}</div>
                  {!s.applied ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button onClick={() => onApplySuggestion(i)} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}>Apply →</button>
                      <button onClick={() => copySuggestion(s.text, i)} style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        {copied === i ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 10, color: '#3B6D11' }}>✓ Applied</span>
                  )}
                </div>
              ))
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {noJobSelected ? 'Select a job above to get AI-powered suggestions.' : 'Select a job and click Analyze match to get suggestions.'}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Section scores */}
      {scoreResult && Object.keys(scoreResult.sectionScores).length > 0 && (
        <>
          <Divider />
          <div>
            <SectionHeader
              label="SECTION SCORES"
              collapsed={scoresCollapsed}
              onToggle={() => setScoresCollapsed(v => !v)}
            />
            {!scoresCollapsed && (
              <div style={{ marginTop: 8 }}>
                {Object.entries(scoreResult.sectionScores).map(([section, score]) => (
                  <div key={section} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 11 }}>{section}</span>
                      <span style={{ fontSize: 11, fontWeight: 500, color: score >= 80 ? '#3B6D11' : score >= 65 ? '#854F0B' : '#A32D2D' }}>{score}%</span>
                    </div>
                    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
                      <div style={{ width: `${score}%`, height: '100%', background: score >= 80 ? '#3B6D11' : score >= 65 ? '#854F0B' : '#A32D2D', borderRadius: 2, transition: 'width 0.5s ease' }} />
                    </div>
                    {scoreResult.sectionTips?.[section] && (
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{scoreResult.sectionTips[section]}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
