import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

type QueryResult<Row> = { rows: Row[] }
type PgClient = {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgModule = { Client: new (options: { connectionString: string }) => PgClient }

const expectedUrl = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_custom_agent_role_ci"
const databaseUrl = guardedDatabaseUrl()
const integrationDescribe = databaseUrl ? describe : describe.skip
const postgres = createRequire(fileURLToPath(new URL("../../../../packages/shared/package.json", import.meta.url)))("pg") as PgModule
const migrationName = "20261124000000_add_job_resume_material_revisions"

function guardedDatabaseUrl(): string | undefined {
  const requested = [
    process.env.CUSTOM_AGENT_ROLE_PG_TEST_URL,
    process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE,
    process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED,
  ]
  if (requested.every((value) => value === undefined)) return undefined
  if (
    process.env.CI !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_URL !== expectedUrl
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED !== "true"
  ) {
    throw new Error("Resume revision integration requires the guarded disposable PostgreSQL target")
  }
  const parsed = new URL(expectedUrl)
  if (
    parsed.protocol !== "postgresql:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "5432"
    || parsed.username !== "postgres"
    || parsed.password !== "postgres"
    || parsed.pathname !== "/applymate_custom_agent_role_ci"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("Resume revision integration rejected a non-disposable database target")
  }
  return expectedUrl
}

async function resumeRevision(client: PgClient, resumeId: string): Promise<number> {
  const result = await client.query<{ materialRevision: number }>(
    'SELECT "materialRevision" FROM public."Resume" WHERE "id" = $1',
    [resumeId],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]!.materialRevision
}

async function expectResumeRevision(client: PgClient, resumeId: string, expected: number): Promise<void> {
  expect(await resumeRevision(client, resumeId)).toBe(expected)
}

async function expectJob(
  client: PgClient,
  jobId: string,
  finalResumeId: string | null,
  expectedRevision: number,
): Promise<void> {
  const result = await client.query<{ finalResumeId: string | null; finalResumeAssignmentRevision: number }>(
    'SELECT "finalResumeId", "finalResumeAssignmentRevision" FROM public."Job" WHERE "id" = $1',
    [jobId],
  )
  expect(result.rows).toEqual([{ finalResumeId, finalResumeAssignmentRevision: expectedRevision }])
}

integrationDescribe("Job and Resume material revision migration", () => {
  let client: PgClient

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Disposable PostgreSQL URL was not configured")
    client = new postgres.Client({ connectionString: databaseUrl })
    await client.connect()

    const database = await client.query<{ name: string }>("SELECT current_database() AS name")
    expect(database.rows).toEqual([{ name: "applymate_custom_agent_role_ci" }])
    const migration = await client.query<{ installed: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM public."_prisma_migrations" '
      + "WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS installed",
      [migrationName],
    )
    expect(migration.rows[0]?.installed).toBe(true)
    const columns = await client.query<{
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>(
      "SELECT table_name, column_name, data_type, is_nullable, column_default "
      + "FROM information_schema.columns WHERE table_schema = 'public' AND "
      + "((table_name = 'Job' AND column_name = 'finalResumeAssignmentRevision') OR "
      + "(table_name = 'Resume' AND column_name = 'materialRevision')) ORDER BY table_name",
    )
    expect(columns.rows).toEqual([
      {
        table_name: "Job",
        column_name: "finalResumeAssignmentRevision",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      },
      {
        table_name: "Resume",
        column_name: "materialRevision",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      },
    ])
  })

  afterAll(async () => {
    if (client) await client.end()
  })

  it("derives revisions from semantic old-row changes and keeps same-owner pairs independent", async () => {
    if (!client) throw new Error("Disposable PostgreSQL client was not initialized")
    const ownerId = `resume-revision-user-${randomUUID()}`
    const jobA = `resume-revision-job-a-${randomUUID()}`
    const jobB = `resume-revision-job-b-${randomUUID()}`
    const resumeA = `resume-revision-a-${randomUUID()}`
    const resumeB = `resume-revision-b-${randomUUID()}`
    const resumeC = `resume-revision-c-${randomUUID()}`
    const parentResume = `resume-revision-parent-${randomUUID()}`

    await client.query("BEGIN")
    try {
      await client.query(
        'INSERT INTO public."User" ("id", "email", "onboardingGoals", "updatedAt") '
        + "VALUES ($1, $2, ARRAY[]::text[], CURRENT_TIMESTAMP)",
        [ownerId, `${ownerId}@example.test`],
      )
      await client.query(
        'INSERT INTO public."Job" ("id", "userId", "company", "role", "finalResumeAssignmentRevision", "updatedAt") '
        + "VALUES ($1, $3, 'Company A', 'Engineer', 781, CURRENT_TIMESTAMP), "
        + "($2, $3, 'Company B', 'Designer', -12, CURRENT_TIMESTAMP)",
        [jobA, jobB, ownerId],
      )
      await client.query(
        'INSERT INTO public."Resume" ("id", "userId", "name", "content", "materialRevision", "updatedAt") '
        + "VALUES ($1, $2, 'Parent', $3::jsonb, 345, CURRENT_TIMESTAMP)",
        [parentResume, ownerId, JSON.stringify({ summary: "parent" })],
      )
      await client.query(
        'INSERT INTO public."Resume" '
        + '("id", "userId", "name", "content", "materialRevision", "targetJobId", "parentResumeId", "updatedAt") '
        + "VALUES ($1, $4, 'Resume A', $5::jsonb, 901, $6, $7, CURRENT_TIMESTAMP), "
        + "($2, $4, 'Resume B', $8::jsonb, -4, $6, NULL, CURRENT_TIMESTAMP), "
        + "($3, $4, 'Resume C', $9::jsonb, 23, $10, NULL, CURRENT_TIMESTAMP)",
        [
          resumeA, resumeB, resumeC, ownerId, JSON.stringify({ summary: "original" }),
          jobA, parentResume, JSON.stringify({ summary: "alternate" }),
          JSON.stringify({ summary: "independent" }), jobB,
        ],
      )
      for (const resumeId of [parentResume, resumeA, resumeB, resumeC]) {
        await expectResumeRevision(client, resumeId, 0)
      }

      await client.query(
        'UPDATE public."Resume" SET "isDefault" = TRUE, "updatedAt" = $2::timestamp, "materialRevision" = 444 '
        + 'WHERE "id" = $1',
        [resumeA, "2001-02-03 04:05:06"],
      )
      await expectResumeRevision(client, resumeA, 0)

      const revise = async (sql: string, values: unknown[], expected: number) => {
        await client.query(sql, values)
        await expectResumeRevision(client, resumeA, expected)
      }
      await revise(
        'UPDATE public."Resume" SET "name" = $2, "materialRevision" = 999 WHERE "id" = $1',
        [resumeA, "Resume A revised"], 1,
      )

      const fixedTimestamp = "2024-03-04 05:06:07.000"
      await revise(
        'UPDATE public."Resume" SET "content" = $2::jsonb, "updatedAt" = $3::timestamp, '
        + '"materialRevision" = 999 WHERE "id" = $1',
        [resumeA, JSON.stringify({ summary: "edited" }), fixedTimestamp], 2,
      )
      await revise(
        'UPDATE public."Resume" SET "content" = $2::jsonb, "updatedAt" = $3::timestamp, '
        + '"materialRevision" = 999 WHERE "id" = $1',
        [resumeA, JSON.stringify({ summary: "original" }), fixedTimestamp], 3,
      )
      const timestamp = await client.query<{ value: string }>(
        'SELECT to_char("updatedAt", \'YYYY-MM-DD HH24:MI:SS.MS\') AS value '
        + 'FROM public."Resume" WHERE "id" = $1',
        [resumeA],
      )
      expect(timestamp.rows[0]?.value).toBe(fixedTimestamp)

      await revise(
        'UPDATE public."Resume" SET "templateId" = $2 WHERE "id" = $1',
        [resumeA, "template-v2"], 4,
      )
      await revise(
        'UPDATE public."Resume" SET "templateOptions" = $2::jsonb WHERE "id" = $1',
        [resumeA, JSON.stringify({ accentColor: "#334455" })], 5,
      )
      await revise(
        'UPDATE public."Resume" SET "kind" = $2 WHERE "id" = $1',
        [resumeA, "tailored"], 6,
      )
      await revise(
        'UPDATE public."Resume" SET "targetJobId" = $2 WHERE "id" = $1',
        [resumeA, jobB], 7,
      )
      await revise(
        'UPDATE public."Resume" SET "parentResumeId" = NULL WHERE "id" = $1',
        [resumeA], 8,
      )
      await revise(
        'UPDATE public."Resume" SET "basicsDetached" = TRUE WHERE "id" = $1',
        [resumeA], 9,
      )

      await client.query(
        'UPDATE public."Job" SET "finalResumeId" = $2, "finalResumeAssignmentRevision" = 555 WHERE "id" = $1',
        [jobA, resumeA],
      )
      await client.query(
        'UPDATE public."Job" SET "finalResumeId" = $2 WHERE "id" = $1',
        [jobB, resumeC],
      )
      await expectJob(client, jobA, resumeA, 1)
      await expectJob(client, jobB, resumeC, 1)
      await client.query(
        'UPDATE public."Job" SET "finalResumeId" = $2, "finalResumeAssignmentRevision" = 800 WHERE "id" = $1',
        [jobA, resumeB],
      )
      await expectJob(client, jobA, resumeB, 2)
      await client.query(
        'UPDATE public."Job" SET "finalResumeId" = $2, "finalResumeAssignmentRevision" = 0 WHERE "id" = $1',
        [jobA, resumeA],
      )
      await expectJob(client, jobA, resumeA, 3)
      await client.query(
        'UPDATE public."Job" SET "finalResumeAssignmentRevision" = 999 WHERE "id" = $1',
        [jobA],
      )
      await expectJob(client, jobA, resumeA, 3)

      await client.query('DELETE FROM public."Resume" WHERE "id" = $1', [resumeA])
      await expectJob(client, jobA, null, 4)
      await expectJob(client, jobB, resumeC, 1)
      await expectResumeRevision(client, resumeB, 0)
      await expectResumeRevision(client, resumeC, 0)
      await expectResumeRevision(client, parentResume, 0)
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
