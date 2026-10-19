import { modelChat } from '@/lib/model-router'
import type { AiConfig } from '@/lib/model-router'
import type { ApplicationPackage, PipelineCtx } from '../types'
import { roleAiConfig } from '../role-config'

const MAX_FIT_GAP_LENGTH = 240
const MAX_RECOMMENDATION_LENGTH = 360
const QUALITY_FIELDS = ['clScore', 'fitGap', 'recommendation', 'readyToApply']

interface QualityResult {
  clScore: number
  fitGap: string
  recommendation: string
  readyToApply: boolean
}

type QualityReviewOutcome =
  | { kind: 'not_applicable' }
  | { kind: 'valid'; result: QualityResult }
  | { kind: 'unavailable' }

type ReviewContext = Pick<PipelineCtx, 'roleConfigs' | 'aiConfig'>

function isQualityResult(value: unknown): value is QualityResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const keys = Object.keys(result)
  if (keys.length !== QUALITY_FIELDS.length || !keys.every(key => QUALITY_FIELDS.includes(key))) return false

  return typeof result.clScore === 'number'
    && Number.isFinite(result.clScore)
    && result.clScore >= 0
    && result.clScore <= 10
    && typeof result.fitGap === 'string'
    && result.fitGap.length <= MAX_FIT_GAP_LENGTH
    && typeof result.recommendation === 'string'
    && result.recommendation.length <= MAX_RECOMMENDATION_LENGTH
    && typeof result.readyToApply === 'boolean'
}

export async function reviewApplicationQuality(
  pkg: ApplicationPackage,
  ctx: ReviewContext,
): Promise<QualityReviewOutcome> {
  if (!pkg.coverLetter && !pkg.job.description) return { kind: 'not_applicable' }

  try {
    const reviewerCfg = ctx.roleConfigs.reviewer
    const aiConfig: AiConfig = roleAiConfig('reviewer', reviewerCfg, ctx.aiConfig)
    const prompt = `You are a hiring quality reviewer. Assess this application package.

JOB: ${pkg.job.role} at ${pkg.job.company}${pkg.job.location ? ` (${pkg.job.location})` : ''}
${pkg.job.description ? `JD: ${pkg.job.description.slice(0, 600)}` : ''}

MATCH SCORE: ${pkg.score}%
MATCHED KEYWORDS: ${pkg.matchedKeywords.slice(0, 5).join(', ')}
MISSING KEYWORDS: ${pkg.missingKeywords.slice(0, 4).join(', ')}

${pkg.coverLetter ? `COVER LETTER:\n${pkg.coverLetter.slice(0, 800)}` : 'NO COVER LETTER'}

Return ONLY valid JSON with exactly these fields. Keep fitGap at or below ${MAX_FIT_GAP_LENGTH} characters and recommendation at or below ${MAX_RECOMMENDATION_LENGTH} characters:
{
  "clScore": <0-10, how specific/personalized the cover letter is to THIS job. 0=generic, 10=highly tailored>,
  "fitGap": "<key missing skill or concern in one sentence>",
  "recommendation": "<one actionable improvement for this specific application>",
  "readyToApply": <true if score≥7 and materials look solid, false otherwise>
}`

    const response = await modelChat([{ role: 'user', content: prompt }], aiConfig, 300)
    const text = response.text.replace(/```json|```/g, '').trim()
    const parsed: unknown = JSON.parse(text)
    return isQualityResult(parsed) ? { kind: 'valid', result: parsed } : { kind: 'unavailable' }
  } catch {
    return { kind: 'unavailable' }
  }
}
