'use client'

import { MatchScoreRing, Divider } from '@/components/ui'
import type { Job, ScoreResult, Suggestion } from '@/lib/types'

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
            <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>KEYWORD GAPS</div>
            {scoreResult.missingKeywords.length === 0 ? (
              <div style={{ fontSize: 11, color: '#3B6D11' }}>✓ No major gaps found</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {scoreResult.missingKeywords.map(kw => (
                  <button key={kw} onClick={() => onAddKeyword(kw)} title="Click to add to skills" style={{
                    fontSize: 10, background: 'rgba(163,45,45,0.1)', color: '#A32D2D', borderRadius: 999,
                    padding: '2px 8px', border: '0.5px solid rgba(163,45,45,0.2)', cursor: 'pointer',
                  }}>+ {kw}</button>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>MATCHED</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {scoreResult.matchedKeywords.map(kw => (
                <span key={kw} style={{ fontSize: 10, background: 'rgba(59,109,17,0.1)', color: '#3B6D11', borderRadius: 999, padding: '2px 7px' }}>{kw}</span>
              ))}
            </div>
          </div>
          <Divider />
        </>
      )}

      {/* AI Suggestions */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>AI SUGGESTIONS</div>
        {suggesting ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <div style={{ width: 14, height: 14, border: '2px solid rgba(24,95,165,0.3)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            Generating suggestions…
          </div>
        ) : suggestions.length > 0 ? (
          suggestions.map((s, i) => (
            <div key={i} style={{ marginBottom: 8, padding: 8, background: s.applied ? 'rgba(59,109,17,0.06)' : 'var(--bg)', border: `0.5px solid ${s.applied ? 'rgba(59,109,17,0.2)' : 'var(--border)'}`, borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: s.applied ? '#3B6D11' : 'var(--text)', marginBottom: 4, lineHeight: 1.5 }}>{s.text}</div>
              {!s.applied
                ? <button onClick={() => onApplySuggestion(i)} style={{ fontSize: 10, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}>Apply →</button>
                : <span style={{ fontSize: 10, color: '#3B6D11' }}>✓ Applied</span>}
            </div>
          ))
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {noJobSelected ? 'Select a job above to get AI-powered suggestions.' : 'Select a job and click Analyze match to get suggestions.'}
          </div>
        )}
      </div>

      {/* Section scores */}
      {scoreResult && Object.keys(scoreResult.sectionScores).length > 0 && (
        <>
          <Divider />
          <div>
            <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>SECTION SCORES</div>
            {Object.entries(scoreResult.sectionScores).map(([section, score]) => (
              <div key={section} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 11 }}>{section}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: score >= 80 ? '#3B6D11' : score >= 65 ? '#854F0B' : '#A32D2D' }}>{score}%</span>
                </div>
                <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
                  <div style={{ width: `${score}%`, height: '100%', background: score >= 80 ? '#3B6D11' : score >= 65 ? '#854F0B' : '#A32D2D', borderRadius: 2 }} />
                </div>
                {scoreResult.sectionTips?.[section] && (
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{scoreResult.sectionTips[section]}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
