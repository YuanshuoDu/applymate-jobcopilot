import type pg from "pg"
import type { BusinessReferenceResource, BusinessReference, ContextOwnerFence, ContextOwnershipError } from "./step-context-builder.js"

type FailureFactory = (code: ContextOwnershipError["code"], message: string) => Error
type ContextOwnerPool = Pick<pg.Pool, "connect">

const referenceTables: Record<BusinessReferenceResource, { table: string; ownerColumn: string }> = {
  job: { table: '"Job"', ownerColumn: '"userId"' },
  gmail_message: { table: '"gmail_messages"', ownerColumn: '"user_id"' },
  resume: { table: '"Resume"', ownerColumn: '"userId"' },
  resume_version: { table: '"ResumeVersion"', ownerColumn: '"userId"' },
  persona_fact: { table: '"persona_facts"', ownerColumn: '"userId"' },
  persona_evidence_chunk: { table: '"persona_evidence_chunks"', ownerColumn: '"userId"' },
}

export function createPgContextOwnerFence(pool: ContextOwnerPool, failure: FailureFactory): ContextOwnerFence {
  async function owned(id: string, userId: string, resource: BusinessReferenceResource): Promise<void> {
    const client = await pool.connect()
    try {
      const table = referenceTables[resource]
      const result = await client.query(`SELECT "id" FROM ${table.table} WHERE "id" = $1 AND ${table.ownerColumn} = $2`, [id, userId])
      if (!result.rows[0]) throw failure("reference_owner_mismatch", `Reference ${id} is outside the tenant scope`)
    } finally { client.release() }
  }
  return {
    assertReferenceOwned: async (reference: BusinessReference, scope) => {
      const resource = reference.resource ?? (reference.kind === "job" || reference.kind === "jd" ? "job" : reference.kind === "email" ? "gmail_message" : undefined)
      if (!resource) throw failure("reference_owner_unknown", `Reference ${reference.id} has no verifiable resource type`)
      await owned(reference.id, scope.userId, resource)
    },
    assertAttachmentOwned: async (reference, scope) => {
      const client = await pool.connect()
      try {
        const result = await client.query<{ id: string; name: string }>('SELECT "id", "name" FROM "Resume" WHERE "id" = $1 AND "userId" = $2', [reference.attachmentId, scope.userId])
        const row = result.rows[0]
        if (!row) throw failure("reference_owner_mismatch", `Attachment ${reference.attachmentId} is outside the tenant scope`)
        return { attachmentId: row.id, filename: row.name }
      } finally { client.release() }
    },
  }
}
