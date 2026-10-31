import { apiMutate } from '@/lib/hooks'
import type { Job } from '@/lib/types'

type DiscoveredApplication = {
  id: string; company: string; title: string; location: string; url: string
  salary?: string; description: string; source: string; keySkills?: string[]
}

type SaveOperation = {
  userId: string | null
  signal: AbortSignal
  isCurrent: () => boolean
  onSaved: (resultId: string, jobId: string) => void
  onScored: (resultId: string, score: number) => void
  onError: (message: string) => void
}

/** A completed save never grants a later account permission to continue its scoring work. */
export async function saveDiscoveredApplication(result: DiscoveredApplication, operation: SaveOperation): Promise<void> {
  const current = () => !operation.signal.aborted && operation.isCurrent()
  if (!operation.userId || !current()) return
  const { data: job, error } = await apiMutate<Job>('/api/jobs', 'POST', {
    company: result.company, role: result.title, location: result.location,
    url: result.url, salary: result.salary ?? null, description: result.description,
    source: result.source, status: 'saved', keySkills: result.keySkills ?? [],
  })
  if (!current()) return
  if (error || !job) { operation.onError(error ?? 'Save failed'); return }
  if (job.userId !== operation.userId) return
  operation.onSaved(result.id, job.id)
  if (!result.description || !current()) return
  try {
    const resumeResponse = await fetch('/api/resume/default', { signal: operation.signal })
    if (!current() || !resumeResponse.ok) return
    const resume = await resumeResponse.json() as { content?: unknown }
    if (!current() || !resume.content) return
    const response = await fetch('/api/ai/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: operation.signal,
      body: JSON.stringify({ resumeContent: resume.content, jobTitle: result.title, jobDescription: result.description.slice(0, 2000), keySkills: result.keySkills ?? [] }),
    })
    if (!current() || !response.ok) return
    const score = await response.json() as { score: number; matchedKeywords?: string[]; missingKeywords?: string[] }
    if (!current()) return
    const persisted = await apiMutate(`/api/jobs/${job.id}`, 'PATCH', {
      score: score.score,
      analysisNote: `Match: ${score.score}%\nMatched: ${score.matchedKeywords?.join(', ') || '—'}\nMissing: ${score.missingKeywords?.join(', ') || '—'}`,
    })
    if (current() && !persisted.error) operation.onScored(result.id, score.score)
  } catch { /* Saving succeeded; optional scoring must not retry or outlive its operation. */ }
}
