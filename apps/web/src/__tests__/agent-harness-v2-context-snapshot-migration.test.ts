import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const migrationPath = fileURLToPath(new URL("../../prisma/migrations/20260902100000_add_agent_context_snapshots/migration.sql", import.meta.url))
const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url))
const migration = readFileSync(migrationPath, "utf8")
const schema = readFileSync(schemaPath, "utf8")
const rls = readFileSync(fileURLToPath(new URL("../../prisma/rls/enable.sql", import.meta.url)), "utf8")

describe("AH2-034 context snapshot migration contract", () => {
  it("adds the versioned snapshot table and scoped uniqueness", () => {
    expect(migration).toContain('CREATE TABLE "agent_context_snapshots"')
    for (const column of ["sessionId", "throughSequence", "version", "schemaVersion", "content", "checksum", "tokenAccounting"]) expect(migration).toContain('"' + column + '"')
    expect(migration).toContain("agent_context_snapshots_sessionId_version_key")
    expect(migration).toContain("agent_context_snapshots_sessionId_throughSequence_key")
    expect(migration).toContain("agent_context_snapshots_sessionId_fkey")
    expect(migration).toContain("agent_context_snapshots_immutable_update")
    expect(migration).toContain("agent context snapshots are immutable")
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i)
  })

  it("keeps the migration additive and the schema linked to AgentSession", () => {
    expect(migration).toContain('CHECK ("throughSequence" >= 0)')
    expect(migration).toContain('CHECK ("version" > 0)')
    expect(schema).toContain("model AgentContextSnapshot")
    expect(schema).toContain("contextSnapshots AgentContextSnapshot[]")
    expect(schema).toContain('@@map("agent_context_snapshots")')
    expect(rls).toContain('ALTER TABLE "agent_context_snapshots" ENABLE ROW LEVEL SECURITY')
    expect(rls).toContain("candidate_agent_context_snapshot_isolation")
  })
})
