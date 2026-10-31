export type ApplicationAuditIdentity = { jobId: string; resumeId: string; auditedAt: string }

export function sameApplicationAudit(a: ApplicationAuditIdentity | null, b: ApplicationAuditIdentity | null): boolean {
  return !!a && !!b && a.jobId === b.jobId && a.resumeId === b.resumeId && a.auditedAt === b.auditedAt
}
