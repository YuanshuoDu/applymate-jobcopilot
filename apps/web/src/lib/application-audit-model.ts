import { modelChat, parseAiJson, withMiniMaxThinking, type AiConfig } from './model-router'
import { isApplicationAuditTarget, targetForAuditFinding } from './application-audit'
import { sanitizeLosslessProposedValue } from './application-audit-repair-safety'
import type { ApplicationAudit, ApplicationAuditFinding } from './types'

type RawFinding = Partial<ApplicationAuditFinding>
type RawAudit = {
  verdict?: string
  summary?: string
  matchScore?: number
  findings?: RawFinding[]
}

const AREAS = new Set<ApplicationAuditFinding['area']>(['resume', 'cover_letter', 'job_match'])
const SEVERITIES = new Set<ApplicationAuditFinding['severity']>(['pass', 'warning', 'critical'])

function normalize(raw: RawAudit, source: ApplicationAudit['source'], includeCoverLetter: boolean): ApplicationAudit {
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : []
  const overflow = rawFindings.length > 12
  const findings: ApplicationAuditFinding[] = rawFindings.slice(0, 12).map(finding => {
    const base: ApplicationAuditFinding = {
      area: AREAS.has(finding.area as ApplicationAuditFinding['area']) ? finding.area as ApplicationAuditFinding['area'] : 'resume',
      severity: SEVERITIES.has(finding.severity as ApplicationAuditFinding['severity']) ? finding.severity as ApplicationAuditFinding['severity'] : 'warning',
      resolution: (finding.resolution === 'evidence_needed' ? 'evidence_needed' : 'contradiction') as ApplicationAuditFinding['resolution'],
      title: String(finding.title ?? 'Review application material').slice(0, 120),
      evidence: String(finding.evidence ?? 'The auditor could not establish enough evidence.').slice(0, 500),
      action: String(finding.action ?? 'Review and correct this item before confirming.').slice(0, 300),
    }
    const target = base.severity !== 'pass' && base.area !== 'job_match'
      ? (isApplicationAuditTarget(finding.target) ? finding.target : targetForAuditFinding(base))
      : undefined
    const proposedValue = target && finding.proposedValue !== undefined
      ? sanitizeLosslessProposedValue(target, finding.proposedValue)
      : null
    return {
      ...base,
      ...(target ? { target } : {}),
      ...(proposedValue !== null ? { proposedValue } : {}),
    }
  }).filter(finding => includeCoverLetter || finding.area !== 'cover_letter')
  const auditedAreas = new Set(findings.map(finding => finding.area))
  // The audit gate verifies factual integrity of the submitted documents.
  // Job-fit gaps are useful advice, but absence of a requested skill is never
  // evidence that the candidate fabricated a claim.
  const requiredAreas = includeCoverLetter ? (['resume', 'cover_letter'] as const) : (['resume'] as const)
  const incomplete = requiredAreas.filter(area => !auditedAreas.has(area))
  const notices: ApplicationAuditFinding[] = []
  if (incomplete.length) notices.push({
    area: incomplete[0], severity: 'warning', title: 'Incomplete independent audit',
    resolution: 'evidence_needed',
    evidence: `The Auditor did not return a result for: ${incomplete.join(', ')}.`,
    action: 'Run the audit again before confirming the application package.',
  })
  if (overflow) notices.push({
    area: 'resume', severity: 'warning', title: 'Audit results exceed the display limit',
    resolution: 'evidence_needed',
    evidence: 'The auditor returned more findings than can be displayed safely.',
    action: 'Run the independent audit again and review the complete result before confirming.',
  })
  // Include a critical finding even if it falls outside the display limit.
  // Ignore job-fit advice and findings for an optional, absent cover letter.
  const hasCritical = rawFindings.some(finding => finding && finding.severity === 'critical'
    && finding.area !== 'job_match' && (includeCoverLetter || finding.area !== 'cover_letter'))
  const hasFactualWarning = findings.some(finding => finding.area !== 'job_match' && finding.severity === 'warning')
  const displayedFindings = [...findings.slice(0, 12 - notices.length), ...notices]
  return {
    verdict: hasCritical ? 'blocked' : (hasFactualWarning || incomplete.length || overflow) ? 'needs_review' : 'pass',
    summary: overflow ? 'The audit returned too many findings to display completely. Run it again before confirming.'
      : String(raw.summary ?? 'Independent audit completed. Review all findings before final confirmation.').slice(0, 600),
    matchScore: Math.max(0, Math.min(100, Number(raw.matchScore) || 0)),
    findings: displayedFindings.length ? displayedFindings : [{ area: 'resume', severity: 'warning', title: 'Audit needs review', evidence: 'The auditor returned no structured findings.', action: 'Run the audit again before final confirmation.' }],
    source,
    auditedAt: new Date().toISOString(),
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function isMiniMaxReasoningExhausted(error: unknown, cfg: AiConfig) {
  return cfg.provider === 'minimax'
    && error instanceof Error
    && error.message.includes('minimax returned no final content (finish reason: length)')
}

async function runAuditModel(prompt: string, cfg: AiConfig) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Keep the audit output bounded for factual evidence review.
      return await modelChat([{ role: 'user', content: prompt }], cfg, 4_096)
    } catch (error) {
      lastError = error
      if (isMiniMaxReasoningExhausted(error, cfg)) {
        // Retained M3 configurations can retry without private reasoning.
        if (cfg.model === 'MiniMax-M3') {
          return modelChat([{ role: 'user', content: prompt }], withMiniMaxThinking(cfg, 'disabled'), 4_096)
        }
        // Retry through the platform's M3 direct-answer mode.
        return modelChat([{ role: 'user', content: prompt }], { ...cfg, model: 'MiniMax-M3', thinking: 'disabled' }, 3_600)
      }
      if (!isAbortError(error) || attempt === 1) throw error
      await new Promise(resolve => setTimeout(resolve, 750))
    }
  }
  throw lastError
}

function unavailableAudit(source: ApplicationAudit['source'], includeCoverLetter: boolean): ApplicationAudit {
  return {
    verdict: 'needs_review',
    summary: 'The auditor did not return a structured result. No application documents were changed; retry the independent audit.',
    matchScore: 0,
    findings: [{
      area: 'job_match', severity: 'warning', title: 'Audit response needs retry',
      evidence: 'The AI response was not valid structured audit data.',
      action: includeCoverLetter
        ? 'Retry the independent audit. The existing resume and cover letter will be reused unchanged.'
        : 'Retry the independent audit. The existing resume will be reused unchanged.',
    }],
    source,
    auditedAt: new Date().toISOString(),
  }
}

export async function runParsedAudit(prompt: string, cfg: AiConfig, source: ApplicationAudit['source'], includeCoverLetter: boolean) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryInstruction = attempt
      ? '\n\nYour previous response was invalid. Return only the JSON object — no prose, markdown, or reasoning.'
      : ''
    const result = await runAuditModel(prompt + retryInstruction, cfg)
    try {
      return { result, audit: normalize(parseAiJson<RawAudit>(result.text), source, includeCoverLetter) }
    } catch {
      if (attempt === 1) return { result, audit: unavailableAudit(source, includeCoverLetter) }
    }
  }
  throw new Error('Independent audit did not produce a result')
}
