import type { Prisma } from '@prisma/client'
import type { ApplicationAuditFinding } from '@/lib/types'
import { auditJobBasisHash, auditMaterialBasisHash, readAuditOperation } from '@/lib/application-audit-operation'
import { lockApplicationAuditMaterials } from '@/lib/application-audit-transaction'

export const RESUME_TAILOR_SECTIONS = ['summary', 'skills', 'experience', 'education', 'projects', 'certifications'] as const

// Caller holds the scoped Job lock. Material rows are locked after it, in the
// same order as audit generation and individual correction.
export async function guardedRepairBasis(tx: Prisma.TransactionClient, scope: { userId: string; jobId: string }, resumeId: string, signature: string, operationId: string) {
  const operation = await readAuditOperation(tx, scope)
  if (operation.kind !== 'completed' || operation.operationId !== operationId || operation.audit.receipt?.signature !== signature || operation.audit.resumeId !== resumeId) return null
  if (!await lockApplicationAuditMaterials(tx, scope, resumeId, operation.audit.coverLetterId)) return null
  const [job, resume, letter] = await Promise.all([
    tx.job.findFirst({ where: { id: scope.jobId, userId: scope.userId } }),
    tx.resume.findFirst({ where: { id: resumeId, userId: scope.userId } }),
    operation.audit.coverLetterId ? tx.coverLetter.findFirst({ where: { id: operation.audit.coverLetterId, jobId: scope.jobId, userId: scope.userId } }) : null,
  ])
  const iso = (value: Date | undefined) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (!job || !resume || (operation.audit.coverLetterId && !letter)
    || (job.finalResumeId && job.finalResumeId !== resumeId)
    || (job.finalCoverLetterId ?? null) !== operation.audit.coverLetterId
    || !operation.audit.resumeUpdatedAt || iso(resume.updatedAt) !== operation.audit.resumeUpdatedAt
    || (letter ? !operation.audit.coverLetterUpdatedAt || iso(letter.updatedAt) !== operation.audit.coverLetterUpdatedAt : Boolean(operation.audit.coverLetterUpdatedAt))
    || operation.jobBasisHash !== auditJobBasisHash(job)
    || operation.materialBasisHash !== auditMaterialBasisHash(resume, letter)) return null
  return { operation, job, resume, letter }
}

export function sectionsForAuditRepair(findings: ApplicationAuditFinding[]) {
  const matches: Array<typeof RESUME_TAILOR_SECTIONS[number]> = []
  for (const finding of findings.filter(item => item && item.area === 'resume' && item.severity !== 'pass')) {
    if (finding.target) {
      if (!RESUME_TAILOR_SECTIONS.includes(finding.target as typeof RESUME_TAILOR_SECTIONS[number])) return null
      matches.push(finding.target as typeof RESUME_TAILOR_SECTIONS[number])
      continue
    }
    const text = `${finding.title} ${finding.evidence} ${finding.action}`.toLowerCase()
    const inferred: Array<typeof RESUME_TAILOR_SECTIONS[number]> = []
    const add = (section: typeof RESUME_TAILOR_SECTIONS[number], terms: string[]) => {
      if (terms.some(term => text.includes(term))) inferred.push(section)
    }
    add('experience', ['experience', 'employer', 'employment', 'company', 'role', 'title', 'date', 'duration'])
    add('summary', ['summary', 'profile', 'headline'])
    add('skills', ['skill', 'technology', 'tooling'])
    add('education', ['education', 'degree', 'university'])
    add('projects', ['project', 'portfolio'])
    add('certifications', ['certification', 'certificate', 'credential'])
    if (inferred.length !== 1) return null
    matches.push(inferred[0])
  }
  return matches.length ? [...new Set(matches)] : null
}
