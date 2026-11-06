import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditActivityText, AUDIT_ACTIVITY_PREFIX, parseStoredApplicationAudit } from './application-audit'
import { signedAuditActivityText } from './application-audit-receipt'
import { auditJobBasisHash, auditMaterialBasisHash, auditOperationActivityId, auditReceiptIdentity, completeAuditOperation, failAuditOperation, readAuditOperation, registerAuditOperation, staleAuditOperation } from './application-audit-operation'
import type { ApplicationAudit } from './types'

const secrets = vi.hoisted(() => ({ current: 'audit-control-test-key' }))
vi.mock('./auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode(secrets.current) }))

const scope = { userId: 'user-1', jobId: 'job-1' }
const audit: ApplicationAudit = { verdict: 'pass', summary: 'Supported', matchScore: 80, source: 'parent_resume', auditedAt: '2026-11-01T00:00:00.000Z', findings: [{ area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Source', action: 'None' }] }
const result = { resumeId: 'resume-1', coverLetterId: null, audit, jobBasis: { role: 'Engineer', company: 'Example', description: 'Build tools' }, materialBasis: { resume: { id: 'resume-1', name: 'Final', content: { summary: 'Supported' }, templateId: null, templateOptions: null }, coverLetter: null }, versions: { resumeUpdatedAt: '2026-11-01T00:00:00.000Z' } }

function fixture() {
  const rows = new Map<string, { userId: string; jobId: string | null; text: string }>()
  let legacy: { text: string } | null = null
  const activity = {
    create: vi.fn(async ({ data }: { data: { text: string } }) => { legacy = { text: data.text } }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    findFirst: vi.fn(async () => legacy),
    upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: { userId: string; jobId: string; text: string }; update: { text: string } }) => {
      const row = rows.get(where.id)
      rows.set(where.id, row ? { ...row, text: update.text } : { userId: create.userId, jobId: create.jobId, text: create.text })
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { text: string } }) => {
      const row = rows.get(where.id)
      if (!row) throw new Error('missing row')
      rows.set(where.id, { ...row, text: data.text })
    }),
  }
  return { tx: { activity } as unknown as Parameters<typeof readAuditOperation>[0], rows, activity, setLegacy: (text: string | null) => { legacy = text === null ? null : { text } } }
}

describe('application audit operation control', () => {
  beforeEach(() => { secrets.current = 'audit-control-test-key' })
  it('separates account and job IDs without delimiter collisions', () => {
    expect(auditOperationActivityId({ userId: 'a:b', jobId: 'c' })).not.toBe(auditOperationActivityId({ userId: 'a', jobId: 'b:c' }))
    expect(auditOperationActivityId(scope)).toBe(auditOperationActivityId({ ...scope }))
  })

  it('distinguishes no legacy record, valid legacy receipt, and invalid legacy', async () => {
    const f = fixture()
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'none' })
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    const read = await readAuditOperation(f.tx, scope)
    expect(read.kind).toBe('legacy')
    if (read.kind !== 'legacy') throw new Error('expected legacy')
    expect(auditReceiptIdentity(scope, read.audit)).toBe(read.audit.receipt?.signature)
    expect(auditReceiptIdentity({ ...scope, jobId: 'other' }, read.audit)).toBeNull()
    f.setLegacy(auditActivityText(result.resumeId, null, audit))
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'legacy' })
    // An explicit new audit can replace an untrusted legacy state.
    await registerAuditOperation(f.tx, scope)
    expect((await readAuditOperation(f.tx, scope)).kind).toBe('pending')
  })

  it('supersedes old operations and never permits their late completion or failure', async () => {
    const f = fixture()
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    const first = await registerAuditOperation(f.tx, scope)
    const second = await registerAuditOperation(f.tx, scope)
    expect(second).not.toBe(first)
    expect(await completeAuditOperation(f.tx, scope, first, result)).toBe(false)
    expect(await failAuditOperation(f.tx, scope, first)).toBe(false)
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'pending', operationId: second })
    expect(await completeAuditOperation(f.tx, scope, second, result)).toBe(true)
    const complete = await readAuditOperation(f.tx, scope)
    expect(complete.kind).toBe('completed')
    if (complete.kind !== 'completed') throw new Error('expected completion')
    expect(complete.audit).toMatchObject({ resumeId: 'resume-1', coverLetterId: null, audit })
    expect(complete.jobBasisHash).toBe(auditJobBasisHash(result.jobBasis))
    expect(complete.materialBasisHash).toBe(auditMaterialBasisHash(result.materialBasis.resume, null))
    expect(auditReceiptIdentity(scope, complete.audit)).not.toBeNull()
    expect(await completeAuditOperation(f.tx, scope, second, result)).toBe(false)
    expect(await failAuditOperation(f.tx, scope, second)).toBe(false)
  })

  it('leaves a failed operation visible instead of falling back to an old pass', async () => {
    const f = fixture()
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    const id = await registerAuditOperation(f.tx, scope)
    expect(await failAuditOperation(f.tx, scope, id)).toBe(true)
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'failed', operationId: id })
    expect(f.activity.findFirst).not.toHaveBeenCalled()
  })

  it('marks an invalidated review stale without falling back to an old pass', async () => {
    const f = fixture()
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    const id = await registerAuditOperation(f.tx, scope)
    expect(await staleAuditOperation(f.tx, scope, id)).toBe(true)
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'stale', operationId: id })
    expect(await staleAuditOperation(f.tx, scope, id)).toBe(false)
    expect(f.activity.findFirst).not.toHaveBeenCalled()
  })

  it('archives each completed receipt once when the next operation starts', async () => {
    const f = fixture()
    const legacyText = signedAuditActivityText(scope, result.resumeId, null, audit, result.versions)
    f.setLegacy(legacyText)
    const first = await registerAuditOperation(f.tx, scope)
    // Legacy already exists, and superseding pending operations makes no history.
    const second = await registerAuditOperation(f.tx, scope)
    expect(f.activity.create).not.toHaveBeenCalled()
    expect(await completeAuditOperation(f.tx, scope, first, result)).toBe(false)
    expect(await completeAuditOperation(f.tx, scope, second, result)).toBe(true)
    const third = await registerAuditOperation(f.tx, scope)
    expect(f.activity.create).toHaveBeenCalledTimes(1)
    const archived = parseStoredApplicationAudit(f.activity.create.mock.calls[0][0].data.text)
    expect(auditReceiptIdentity(scope, archived)).not.toBeNull()
    expect(archived).toMatchObject({ resumeId: result.resumeId, coverLetterId: null, audit })
    const fourth = await registerAuditOperation(f.tx, scope)
    expect(f.activity.create).toHaveBeenCalledTimes(1)
    expect(await failAuditOperation(f.tx, scope, third)).toBe(false)
    expect(await failAuditOperation(f.tx, scope, fourth)).toBe(true)
    await registerAuditOperation(f.tx, scope)
    expect(f.activity.create).toHaveBeenCalledTimes(1)
  })

  it('rejects modified, forged or misbound control records without legacy fallback', async () => {
    const f = fixture()
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    const op = await registerAuditOperation(f.tx, scope)
    expect(await completeAuditOperation(f.tx, scope, op, result)).toBe(true)
    const id = auditOperationActivityId(scope)
    const row = f.rows.get(id)!
    expect(row.text.startsWith(AUDIT_ACTIVITY_PREFIX)).toBe(true)
    expect(parseStoredApplicationAudit(row.text)).toBeNull()
    f.rows.set(id, { ...row, text: row.text.replace('Supported', 'Fabricated') })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
    const replacement = await registerAuditOperation(f.tx, scope)
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'pending', operationId: replacement })
    expect(await completeAuditOperation(f.tx, scope, op, result)).toBe(false)
    expect(f.activity.create).not.toHaveBeenCalled()
    expect(f.activity.findFirst).not.toHaveBeenCalled()
    f.rows.set(id, { ...row, userId: 'other' })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
  })

  it('allows a deliberate new audit after signing-key rotation without restoring old results', async () => {
    const f = fixture()
    const prior = await registerAuditOperation(f.tx, scope)
    expect(await completeAuditOperation(f.tx, scope, prior, result)).toBe(true)
    f.setLegacy(signedAuditActivityText(scope, result.resumeId, null, audit, result.versions))
    secrets.current = 'rotated-audit-key'
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
    const replacement = await registerAuditOperation(f.tx, scope)
    expect(replacement).not.toBe(prior)
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'pending', operationId: replacement })
    expect(await completeAuditOperation(f.tx, scope, prior, result)).toBe(false)
    expect(f.activity.create).not.toHaveBeenCalled()
    expect(f.activity.findFirst).not.toHaveBeenCalled()
    expect(await completeAuditOperation(f.tx, scope, replacement, result)).toBe(true)
    expect((await readAuditOperation(f.tx, scope)).kind).toBe('completed')
  })

  it('never overwrites a fixed-ID row bound to another account or job', async () => {
    const f = fixture(), id = auditOperationActivityId(scope)
    for (const row of [
      { userId: 'other', jobId: scope.jobId, text: 'invalid' },
      { userId: scope.userId, jobId: 'other', text: 'invalid' },
    ]) {
      f.rows.set(id, row)
      expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
      await expect(registerAuditOperation(f.tx, scope)).rejects.toThrow('Invalid audit operation control scope')
      expect(f.rows.get(id)).toEqual(row)
    }
    expect(f.activity.upsert).not.toHaveBeenCalled()
  })

  it('rejects a modified pending operation and cross-job replay of signed control', async () => {
    const f = fixture()
    const op = await registerAuditOperation(f.tx, scope)
    const id = auditOperationActivityId(scope)
    const pending = f.rows.get(id)!
    f.rows.set(id, { ...pending, text: pending.text.replace(op, '00000000-0000-4000-8000-000000000000') })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
    const other = { ...scope, jobId: 'job-2' }
    f.rows.set(auditOperationActivityId(other), { ...pending, jobId: other.jobId })
    expect(await readAuditOperation(f.tx, other)).toEqual({ kind: 'invalid', source: 'control' })
    expect(f.activity.findFirst).not.toHaveBeenCalled()
  })

  it('authenticates exact role, company and description and rejects a removed basis', async () => {
    const original = result.jobBasis
    for (const changed of [{ ...original, role: 'Manager' }, { ...original, company: 'Other' }, { ...original, description: null }, { ...original, description: 'Build tools ' }]) {
      expect(auditJobBasisHash(changed)).not.toBe(auditJobBasisHash(original))
    }
    const f = fixture()
    const op = await registerAuditOperation(f.tx, scope)
    expect(await completeAuditOperation(f.tx, scope, op, result)).toBe(true)
    const id = auditOperationActivityId(scope), row = f.rows.get(id)!
    const marker = `${AUDIT_ACTIVITY_PREFIX}operation-v1 `
    const control = JSON.parse(row.text.slice(marker.length)) as Record<string, unknown>
    control.jobBasisHash = auditJobBasisHash({ ...original, role: 'Manager' })
    f.rows.set(id, { ...row, text: marker + JSON.stringify(control) })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
    delete control.jobBasisHash
    f.rows.set(id, { ...row, text: marker + JSON.stringify(control) })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
  })

  it('hashes material content independently of object key order and updatedAt', () => {
    const base = { id: 'resume-1', name: 'Final', content: { b: [1, { y: 2, x: 3 }], a: 'one' }, templateId: null, templateOptions: { z: true, a: 1 }, updatedAt: 'same' }
    const ordered = { ...base, content: { a: 'one', b: [1, { x: 3, y: 2 }] }, templateOptions: { a: 1, z: true } }
    const digest = auditMaterialBasisHash(base, null)
    expect(auditMaterialBasisHash(ordered, null)).toBe(digest)
    expect(auditMaterialBasisHash({ ...base, content: { ...base.content, a: 'changed' } }, null)).not.toBe(digest)
    expect(auditMaterialBasisHash({ ...base, content: { ...base.content, b: [{ y: 2, x: 3 }, 1] } }, null)).not.toBe(digest)
    expect(auditMaterialBasisHash({ ...base, name: 'Other' }, null)).not.toBe(digest)
    expect(auditMaterialBasisHash({ ...base, templateOptions: null }, null)).not.toBe(digest)
    expect(auditMaterialBasisHash(base, { id: 'letter-1', content: 'Hello', tone: 'formal', templateId: null, templateOptions: null })).not.toBe(digest)
    expect(() => auditMaterialBasisHash({ ...base, templateOptions: undefined } as never, null)).toThrow('Incomplete audit material basis')
    expect(() => auditMaterialBasisHash(base, { id: 'letter-1', content: 'Hello', tone: 'formal', templateId: null } as never)).toThrow('Incomplete audit material basis')
  })

  it('rejects tampered material basis and receipt/material identity mismatch', async () => {
    const f = fixture(), op = await registerAuditOperation(f.tx, scope)
    await expect(completeAuditOperation(f.tx, scope, op, { ...result, resumeId: 'other' })).rejects.toThrow('Audit receipt and material basis differ')
    expect(await completeAuditOperation(f.tx, scope, op, result)).toBe(true)
    const id = auditOperationActivityId(scope), row = f.rows.get(id)!
    const marker = `${AUDIT_ACTIVITY_PREFIX}operation-v1 `
    const control = JSON.parse(row.text.slice(marker.length)) as Record<string, unknown>
    control.materialBasisHash = auditMaterialBasisHash({ ...result.materialBasis.resume, content: { summary: 'changed' } }, null)
    f.rows.set(id, { ...row, text: marker + JSON.stringify(control) })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
    delete control.materialBasisHash
    f.rows.set(id, { ...row, text: marker + JSON.stringify(control) })
    expect(await readAuditOperation(f.tx, scope)).toEqual({ kind: 'invalid', source: 'control' })
  })
})
