'use client'

import { useState } from 'react'
import { MatchScoreRing, Divider } from '@/components/ui'
import type { Job, ScoreResult, Suggestion } from '@/lib/types'

function SectionHeader({ label, count, collapsed, onToggle }: {
  label: string; count?: number; collapsed: boolean; onToggle: () => void
}) {
  return (
    <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}>
      <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>
        {label}
        {count !== undefined && count > 0 && (
          <span style={{ marginLeft: 5, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '1px 6px', fontSize: 9, fontWeight: 600 }}>{count}</span>
        )}
      </span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{collapsed ? '▶' : '▼'}</span>
    </div>
  )
}

// Keys in both Title Case (sectionMatches) and lowercase (missingItems.target) for safe lookups
const SEC_LABELS: Record<string, string> = {
  Summary: '📝 Summary',    summary: '📝 Summary',
  Experience: '💼 Experience', experience: '💼 Experience',
  Skills: '🏷 Skills',      skills: '🏷 Skills',
  Education: '🎓 Education', education: '🎓 Education',
  Projects: '📦 Projects',  projects: '📦 Projects',
}
const SEC_ORDER = ['Summary', 'Skills', 'Experience', 'Education', 'Projects']

export function AiPanel({ selectedJob, scoreResult, suggestions, scoring, suggesting, noJobSelected, onApplySuggestion, onAnalyze, onAddKeyword, onApplyTargeted, onEditSection, currentSummary, currentSkills, contentChangedSinceAnalysis }: {
  selectedJob:       Job | null
  scoreResult:                  ScoreResult | null
  suggestions:                  Suggestion[]
  scoring:                      boolean
  suggesting:                   boolean
  noJobSelected:                boolean
  onApplySuggestion:            (i: number) => void
  onAnalyze:                    () => void
  onAddKeyword:                 (kw: string) => void
  onApplyTargeted?:             (t: { type: string; section: string; keyword: string; value?: string }) => void
  onEditSection?:               (section: string) => void
  currentSummary?:              string
  currentSkills?:               string[]
  contentChangedSinceAnalysis?: boolean
}) {
  const [suggestCollapsed, setSuggestCollapsed] = useState(false)
  const [scoresCollapsed,  setScoresCollapsed]  = useState(false)
  const [copied,           setCopied]           = useState<number | null>(null)

  function copySuggestion(text: string, i: number) {
    navigator.clipboard.writeText(text).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1500) })
  }

  const pendingSuggestions = suggestions.filter(s => !s.applied).length
  const hasAnalysis = scoreResult || suggestions.length > 0
  const hasJob      = selectedJob && !noJobSelected

  // Group suggestions by section target
  const suggByTarget: Record<string, Suggestion[]> = {}
  for (const s of suggestions) {
    (suggByTarget[s.target] ??= []).push(s)
  }

  return (
    <div className="resume-ai-panel" style={{ width: 280, flexShrink: 0, borderLeft: '0.5px solid var(--border)', background: 'var(--bg-secondary)', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Job context + score */}
      <div style={{ background: 'rgba(79,70,229,0.06)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 7, padding: 10 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>TAILORING FOR</div>
        {selectedJob ? (
          <>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{selectedJob.role}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selectedJob.company}</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              {scoring ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 16, height: 16, border: '2px solid rgba(79,70,229,0.30)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Analyzing…</span>
                </div>
              ) : scoreResult ? (
                <>
                  {(() => {
                    // CV optimisation: base score + section bonuses + per-suggestion delta
                    const applied = suggestions.filter(s => s.applied).length
                    const secBonus = (suggestions.some(s => s.target==='summary' && s.applied) ? 8 : 0)
                      + (suggestions.some(s => s.target==='skills' && s.applied) ? 6 : 0)
                      + (suggestions.some(s => s.target==='experience' && s.applied) ? 6 : 0)
                    const optScore = Math.min(100, scoreResult.score + applied * 3 + secBonus)
                    const delta = optScore - scoreResult.score
                    return (<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ textAlign: 'center' }}>
                        <MatchScoreRing score={scoreResult.score} size="sm" showLabel />
                        <div style={{ fontSize: 7, color: 'var(--text-muted)', marginTop: 1 }}>Position Match</div>
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>→</span>
                      <div style={{ textAlign: 'center' }}>
                        <MatchScoreRing score={optScore} size="sm" showLabel />
                        <div style={{ fontSize: 7, color: delta > 0 ? 'var(--c-success)' : 'var(--text-muted)', marginTop: 1 }}>
                          CV Optimisation {delta > 0 ? `↑${delta}` : ''}
                        </div>
                      </div>
                      <button onClick={onAnalyze} title="Re-analyze" style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>↻</button>
                    </div>)})()}
                </>
              ) : (
                <button onClick={onAnalyze} style={{ fontSize: 11, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' }}>
                  ✦ Analyze match
                </button>
              )}
            </div>
            {/* Stale analysis banner — shown when resume was edited after last analysis */}
            {contentChangedSinceAnalysis && scoreResult && !scoring && (
              <div style={{ marginTop: 8, padding: '5px 8px', background: 'rgba(133,79,11,0.07)', border: '0.5px solid rgba(133,79,11,0.22)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 9, color: 'var(--c-warning)' }}>✎ Resume changed</span>
                <button onClick={onAnalyze} style={{ fontSize: 9, color: 'var(--c-warning)', background: 'rgba(217,119,6,0.10)', border: '0.5px solid rgba(217,119,6,0.25)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>↻ Re-analyze</button>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Select a job above to see how well your resume matches it.</div>
        )}
      </div>

      {/* ── Section-by-section analysis ── */}
      {scoreResult && (
        <>
          {/* Missing items — section-aware badges */}
          {scoreResult.missingItems?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>🔍 GAPS — click to apply to the right section</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {scoreResult.missingItems.map((mi, i) => {
                  const secLabel = SEC_LABELS[mi.target] ?? mi.target
                  return (
                    <button key={i} onClick={() => {
                      if (onApplyTargeted) {
                        onApplyTargeted({ type: 'add_keyword', section: mi.target, keyword: mi.keyword })
                      } else {
                        onAddKeyword(mi.keyword)
                      }
                    }}
                      style={{
                        textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: '0.5px solid rgba(220,38,38,0.20)',
                        background: 'rgba(163,45,45,0.04)', cursor: 'pointer', transition: 'all 0.1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(220,38,38,0.10)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(163,45,45,0.04)' }}>
                      <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--c-danger)' }}>+ {mi.keyword}</div>
                      <div style={{ fontSize: 8, color: 'var(--text-muted)', marginTop: 1 }}>
                        {secLabel} — {mi.tip}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Divider />

          {/* Section matches + scores */}
          <div>
            <SectionHeader label="SECTION ANALYSIS" collapsed={scoresCollapsed} onToggle={() => setScoresCollapsed(v => !v)} />
            {!scoresCollapsed && (
              <div style={{ marginTop: 8 }}>
                {SEC_ORDER.filter(sec => {
                  const m = scoreResult.sectionMatches?.find(sm => sm.section === sec)
                  return m || scoreResult.sectionScores?.[sec] !== undefined
                }).map(sec => {
                  const m     = scoreResult.sectionMatches?.find(sm => sm.section === sec)
                  const score = scoreResult.sectionScores?.[sec]
                  const tip   = scoreResult.sectionTips?.[sec]
                  const targetKey = sec.toLowerCase()
                  const secSuggestions = suggByTarget[targetKey] ?? []

                  return (
                    <div key={sec} style={{ marginBottom: 12, padding: '8px 10px', background: 'var(--bg)', borderRadius: 7, border: `1px solid ${secSuggestions.some(s => s.applied) ? 'rgba(5,150,105,0.30)' : 'var(--border)'}` }}>
                      {/* Section header + score bar */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>
                          {secSuggestions.some(s => s.applied) ? '✓ ' : ''}{SEC_LABELS[sec] ?? sec}
                        </span>
                        {score !== undefined && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: score >= 80 ? 'var(--c-success)' : score >= 60 ? 'var(--c-warning)' : 'var(--c-danger)' }}>{score}%</span>
                        )}
                      </div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}>
                        <div style={{ width: `${score ?? 0}%`, height: '100%', background: (score ?? 0) >= 80 ? 'var(--c-success)' : (score ?? 0) >= 60 ? 'var(--c-warning)' : 'var(--c-danger)', borderRadius: 2, transition: 'width 0.5s' }} />
                      </div>
                      {/* Matched keywords in this section */}
                      {m?.keywords?.length ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 4 }}>
                          <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>✓ Matched:</span>
                          {m.keywords.map(k => (
                            <span key={k} style={{ fontSize: 9, background: 'rgba(59,109,17,0.08)', color: 'var(--c-success)', borderRadius: 4, padding: '1px 5px' }}>{k}</span>
                          ))}
                        </div>
                      ) : null}
                      {/* Tip + Edit button */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                        {tip && <div style={{ fontSize: 9, color: 'var(--text-muted)', flex: 1 }}>💡 {tip}</div>}
                        <button onClick={() => onEditSection?.(targetKey)}
                          style={{ fontSize: 9, color: 'var(--primary)', background: 'rgba(79,70,229,0.06)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 4, padding: '2px 7px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, fontWeight: 500 }}>
                          ✏️ Edit
                        </button>
                      </div>
                      {/* Suggestions for this section */}
                      {secSuggestions.filter(s => !s.applied).map((s, si) => {
                        const idx = suggestions.indexOf(s)
                        const actionLabel = s.action === 'rewrite' ? 'Apply rewrite' : s.action === 'reorder' ? 'Apply reorder' : 'Apply'
                        return (
                          <div key={si} style={{ marginTop: 6, padding: 6, background: '#FFFBEB', borderRadius: 5, border: '0.5px solid rgba(234,179,8,0.3)' }}>
                            <div style={{ fontSize: 10, color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>{s.text}</div>
                            {s.proposed && (
                              <div style={{ fontSize: 9, color: 'var(--c-success)', padding: '3px 6px', borderRadius: 4, background: 'rgba(59,109,17,0.04)', borderLeft: '2px solid #EAB308', marginBottom: 4, fontStyle: 'italic', maxHeight: 60, overflow: 'hidden' }}>
                                {s.proposed.length > 180 ? s.proposed.slice(0, 180) + '…' : s.proposed}
                              </div>
                            )}
                            <button onClick={() => onApplySuggestion(idx)}
                              style={{ fontSize: 9, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontWeight: 600 }}>
                              {actionLabel} →
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <Divider />
        </>
      )}

      {/* Uncategorized suggestions (target=general) — shown separately */}
      {(() => {
        const uncategorized = suggestions.filter(s => !['summary','skills','experience','education','projects'].includes(s.target))
        if (uncategorized.length === 0) return null
        return (<div>
          <SectionHeader label="OTHER SUGGESTIONS" count={uncategorized.filter(s => !s.applied).length || undefined} collapsed={suggestCollapsed} onToggle={() => setSuggestCollapsed(v => !v)} />
          {!suggestCollapsed && (
            <div style={{ marginTop: 8 }}>
              {uncategorized.filter(s => !s.applied).map((s, i) => {
                const idx = suggestions.indexOf(s)
                return (
                  <div key={i} style={{ marginBottom: 6, padding: 8, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7 }}>
                    <div style={{ fontSize: 10, color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>{s.text}</div>
                    {s.proposed && (
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', padding: '3px 6px', borderRadius: 4, background: 'var(--bg-secondary)', borderLeft: '2px solid #EAB308', marginBottom: 4, fontStyle: 'italic', maxHeight: 50, overflow: 'hidden' }}>
                        {s.proposed.length > 150 ? s.proposed.slice(0, 150) + '…' : s.proposed}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => onApplySuggestion(idx)} style={{ fontSize: 9, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>Apply →</button>
                      <button onClick={() => copySuggestion(s.text, idx)} style={{ fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{copied === idx ? '✓ Copied' : 'Copy'}</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )})()}

      {/* Empty state */}
      {hasJob && !hasAnalysis && !scoring && !suggesting && (
        <div style={{ padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            Job selected — click below to analyse and get targeted suggestions for each section.
          </div>
          <button onClick={onAnalyze}
            style={{ fontSize: 11, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.30)', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}>
            ✦ Analyze Match
          </button>
        </div>
      )}

      {!hasJob && (
        <div className="resume-ai-empty-state">
          <div className="resume-ai-empty-icon">✦</div>
          <strong>Ready to tailor this version</strong>
          <span>Link a saved job in the editor, then AI will score the match and suggest improvements section by section.</span>
        </div>
      )}
    </div>
  )
}
