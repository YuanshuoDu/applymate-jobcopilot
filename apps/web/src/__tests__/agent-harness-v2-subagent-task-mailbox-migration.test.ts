import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const migrationPath = fileURLToPath(new URL(
  "../../prisma/migrations/20260902090000_add_subagent_task_tree_mailbox/migration.sql",
  import.meta.url,
))
const migrationSql = readFileSync(migrationPath, "utf8")

describe("AH2-028 migration fixture", () => {
  it("is additive and supplies task-tree, lease, interrupt, and output fields", () => {
    expect(migrationSql).toContain('ALTER TABLE "sub_agent_tasks"')
    for (const column of ["turnId", "rootTaskId", "parentTaskId", "path", "depth", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "outputArtifactIds"]) {
      expect(migrationSql).toContain(`ADD COLUMN "${column}"`)
    }
    expect(migrationSql).not.toMatch(/\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i)
  })

  it("uses composite task foreign keys to reject cross-session parents", () => {
    expect(migrationSql).toContain('FOREIGN KEY ("parentTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")')
    expect(migrationSql).toContain('FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")')
  })

  it("enforces mailbox idempotency and indexes unconsumed inbox work", () => {
    expect(migrationSql).toContain('CREATE TABLE "agent_mailbox_messages"')
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "agent_mailbox_messages_sessionId_idempotencyKey_key"')
    expect(migrationSql).toContain('"toTaskId", "consumedAt", "createdAt"')
    expect(migrationSql).toContain('"consumedAt" TIMESTAMP(3)')
  })
})
