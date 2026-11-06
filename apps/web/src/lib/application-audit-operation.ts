// Server-only. Every caller must first lock the scoped Job row in this same
// interactive transaction. This module does not acquire or verify that lock.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { getAuthJwtSecret } from './auth-secret'
import { AUDIT_ACTIVITY_PREFIX, parseStoredApplicationAudit, type StoredApplicationAudit } from './application-audit'
import { signedAuditActivityText, verifyApplicationAuditReceipt } from './application-audit-receipt'
import type { ApplicationAudit } from './types'

type Tx = Pick<Prisma.TransactionClient, 'activity'>
export type AuditOperationScope = { userId: string; jobId: string }
export type AuditJobBasis = { role: string; company: string; description: string | null }
export type AuditMaterialResume = { id: string; name: string; content: Prisma.JsonValue; templateId: string | null; templateOptions: Prisma.JsonValue | null }
export type AuditMaterialLetter = { id: string; content: string; tone: string; templateId: string | null; templateOptions: Prisma.JsonValue | null }
type State = 'pending' | 'completed' | 'failed'
type Control = { version: 1; state: State; operationId: string; auditText: string | null; jobBasisHash: string | null; materialBasisHash: string | null; signature: string }
export type AuditOperationRead =
  | { kind: 'none' }
  | { kind: 'invalid'; source: 'control' | 'legacy' }
  | { kind: 'legacy'; audit: StoredApplicationAudit }
  | { kind: 'pending' | 'failed'; operationId: string }
  | { kind: 'completed'; operationId: string; audit: StoredApplicationAudit; jobBasisHash: string; materialBasisHash: string }
export type AuditOperationResult = {
  resumeId: string
  coverLetterId: string | null
  audit: ApplicationAudit
  jobBasis: AuditJobBasis
  materialBasis: { resume: AuditMaterialResume; coverLetter: AuditMaterialLetter | null }
  versions?: Pick<StoredApplicationAudit, 'resumeUpdatedAt' | 'coverLetterUpdatedAt'>
}

const marker = 'operation-v1 '
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Deterministic, namespace-separated identity; no delimiter ambiguity. */
export function auditOperationActivityId(scope: AuditOperationScope): string {
  return `auditop_${createHash('sha256').update(JSON.stringify(['applymate.audit-operation', 1, scope.userId, scope.jobId])).digest('hex')}`
}

/** Bind the audit to exact text; role, company and description are not interchangeable. */
export function auditJobBasisHash(job: AuditJobBasis): string {
  return createHash('sha256').update(JSON.stringify(['applymate.audit-job-basis', 1, job.role, job.company, job.description])).digest('hex')
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Array.from(value, canonicalJson)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalJson(item)]))
  }
  throw new Error('Invalid audit material JSON')
}

/** Hash the exact document fields rendered for this application. Missing is not null. */
export function auditMaterialBasisHash(resume: AuditMaterialResume, coverLetter: AuditMaterialLetter | null): string {
  if (!resume || typeof resume.id !== 'string' || typeof resume.name !== 'string'
    || !(resume.templateId === null || typeof resume.templateId === 'string') || resume.content === undefined || resume.templateOptions === undefined
    || (coverLetter !== null && (!coverLetter || typeof coverLetter.id !== 'string' || typeof coverLetter.content !== 'string'
      || typeof coverLetter.tone !== 'string' || !(coverLetter.templateId === null || typeof coverLetter.templateId === 'string') || coverLetter.templateOptions === undefined))) {
    throw new Error('Incomplete audit material basis')
  }
  const payload = ['applymate.audit-material-basis', 1,
    [resume.id, resume.name, resume.content, resume.templateId, resume.templateOptions],
    coverLetter === null ? null : [coverLetter.id, coverLetter.content, coverLetter.tone, coverLetter.templateId, coverLetter.templateOptions]]
  return createHash('sha256').update(JSON.stringify(canonicalJson(payload))).digest('hex')
}

/** Stable identity of the entire scope-bound receipt, for a caller's recheck. */
export function auditReceiptIdentity(scope: AuditOperationScope, audit: StoredApplicationAudit | null): string | null {
  return verifyApplicationAuditReceipt(scope, audit) ? audit.receipt!.signature : null
}

function mac(scope: AuditOperationScope, state: State, operationId: string, auditText: string | null, jobBasisHash: string | null, materialBasisHash: string | null): string {
  return createHmac('sha256', getAuthJwtSecret()).update(JSON.stringify([
    'applymate.audit-operation', 1, scope.userId, scope.jobId, state, operationId, auditText, jobBasisHash, materialBasisHash,
  ])).digest('hex')
}

function controlText(scope: AuditOperationScope, state: State, operationId: string, auditText: string | null, jobBasisHash: string | null, materialBasisHash: string | null): string {
  const control: Control = { version: 1, state, operationId, auditText, jobBasisHash, materialBasisHash, signature: mac(scope, state, operationId, auditText, jobBasisHash, materialBasisHash) }
  return `${AUDIT_ACTIVITY_PREFIX}${marker}${JSON.stringify(control)}`
}

function parseControl(scope: AuditOperationScope, text: string): AuditOperationRead {
  try {
    if (!text.startsWith(`${AUDIT_ACTIVITY_PREFIX}${marker}`)) return { kind: 'invalid', source: 'control' }
    const value: unknown = JSON.parse(text.slice((AUDIT_ACTIVITY_PREFIX + marker).length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', source: 'control' }
    const v = value as Record<string, unknown>
    if (Object.keys(v).sort().join(',') !== 'auditText,jobBasisHash,materialBasisHash,operationId,signature,state,version'
      || v.version !== 1 || !['pending', 'completed', 'failed'].includes(String(v.state))
      || typeof v.operationId !== 'string' || !uuid.test(v.operationId)
      || typeof v.signature !== 'string' || !/^[a-f0-9]{64}$/.test(v.signature)
      || (v.state === 'completed' ? typeof v.auditText !== 'string' || typeof v.jobBasisHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.jobBasisHash)
        || typeof v.materialBasisHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.materialBasisHash) : v.auditText !== null || v.jobBasisHash !== null || v.materialBasisHash !== null)) return { kind: 'invalid', source: 'control' }
    const state = v.state as State
    const auditText = v.auditText as string | null
    const jobBasisHash = v.jobBasisHash as string | null
    const materialBasisHash = v.materialBasisHash as string | null
    const expected = mac(scope, state, v.operationId, auditText, jobBasisHash, materialBasisHash)
    if (!timingSafeEqual(Buffer.from(v.signature, 'hex'), Buffer.from(expected, 'hex'))) return { kind: 'invalid', source: 'control' }
    if (state !== 'completed') return { kind: state, operationId: v.operationId }
    const audit = parseStoredApplicationAudit(auditText!)
    if (!verifyApplicationAuditReceipt(scope, audit)) return { kind: 'invalid', source: 'control' }
    return { kind: 'completed', operationId: v.operationId, audit, jobBasisHash: jobBasisHash!, materialBasisHash: materialBasisHash! }
  } catch {
    return { kind: 'invalid', source: 'control' }
  }
}

async function readControl(tx: Tx, scope: AuditOperationScope): Promise<AuditOperationRead | null> {
  const row = await tx.activity.findUnique({ where: { id: auditOperationActivityId(scope) }, select: { userId: true, jobId: true, text: true } })
  if (!row) return null
  if (row.userId !== scope.userId || row.jobId !== scope.jobId) return { kind: 'invalid', source: 'control' }
  return parseControl(scope, row.text)
}

/** Invalid control rows never fall back to older signed records. */
export async function readAuditOperation(tx: Tx, scope: AuditOperationScope): Promise<AuditOperationRead> {
  const control = await readControl(tx, scope)
  if (control) return control
  const row = await tx.activity.findFirst({
    where: { userId: scope.userId, jobId: scope.jobId, text: { startsWith: AUDIT_ACTIVITY_PREFIX } },
    orderBy: { createdAt: 'desc' }, select: { text: true },
  })
  if (!row) return { kind: 'none' }
  const audit = parseStoredApplicationAudit(row.text)
  return verifyApplicationAuditReceipt(scope, audit) ? { kind: 'legacy', audit } : { kind: 'invalid', source: 'legacy' }
}

/** A deliberate new audit supersedes a valid prior operation. */
export async function registerAuditOperation(tx: Tx, scope: AuditOperationScope): Promise<string> {
  const previous = await readControl(tx, scope)
  if (previous?.kind === 'invalid') {
    // A deliberate new review may recover a corrupted or old-key control,
    // but never overwrite a fixed-ID row bound to a different account/job.
    const row = await tx.activity.findUnique({ where: { id: auditOperationActivityId(scope) }, select: { userId: true, jobId: true } })
    if (!row || row.userId !== scope.userId || row.jobId !== scope.jobId) throw new Error('Invalid audit operation control scope')
  }
  if (previous?.kind === 'completed') {
    const { resumeId, coverLetterId, audit, resumeUpdatedAt, coverLetterUpdatedAt } = previous.audit
    // Archive once before replacing a completed control row. Registration and
    // this insert must commit or roll back together under the caller's Job lock.
    await tx.activity.create({ data: {
      ...scope, type: 'agent_action',
      text: signedAuditActivityText(scope, resumeId, coverLetterId, audit, { resumeUpdatedAt, coverLetterUpdatedAt }),
    } })
  }
  const operationId = randomUUID()
  const text = controlText(scope, 'pending', operationId, null, null, null)
  await tx.activity.upsert({
    where: { id: auditOperationActivityId(scope) },
    create: { id: auditOperationActivityId(scope), ...scope, type: 'agent_action', text },
    update: { text },
  })
  return operationId
}

/** Only the current pending operation may publish a complete signed receipt. */
export async function completeAuditOperation(tx: Tx, scope: AuditOperationScope, operationId: string, result: AuditOperationResult): Promise<boolean> {
  const current = await readControl(tx, scope)
  if (current?.kind !== 'pending' || current.operationId !== operationId) return false
  if (result.resumeId !== result.materialBasis.resume.id || result.coverLetterId !== (result.materialBasis.coverLetter?.id ?? null)) {
    throw new Error('Audit receipt and material basis differ')
  }
  const auditText = signedAuditActivityText(scope, result.resumeId, result.coverLetterId, result.audit, result.versions)
  const materialBasisHash = auditMaterialBasisHash(result.materialBasis.resume, result.materialBasis.coverLetter)
  await tx.activity.update({ where: { id: auditOperationActivityId(scope) }, data: { text: controlText(scope, 'completed', operationId, auditText, auditJobBasisHash(result.jobBasis), materialBasisHash) } })
  return true
}

/** Failure also replaces the passing state; it never restores an older audit. */
export async function failAuditOperation(tx: Tx, scope: AuditOperationScope, operationId: string): Promise<boolean> {
  const current = await readControl(tx, scope)
  if (current?.kind !== 'pending' || current.operationId !== operationId) return false
  await tx.activity.update({ where: { id: auditOperationActivityId(scope) }, data: { text: controlText(scope, 'failed', operationId, null, null, null) } })
  return true
}
