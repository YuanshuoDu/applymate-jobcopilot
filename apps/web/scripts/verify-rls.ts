import { db } from '../src/lib/db'

type OwnerCount = { userId: string; count: number }
type V2Check = { name: string; enabled: boolean; readable: boolean }
type Counts = { expected: number[]; first: number; second: number; empty: number; v2: V2Check[] }

const V2_TABLES = ['agent_turns', 'agent_steps', 'agent_inputs', 'agent_items', 'agent_events', 'agent_outbox'] as const

const rollbackPrefix = '__ROLLBACK__'

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

async function main() {
  const owners = await db.$queryRaw<OwnerCount[]>`
    SELECT "userId" AS "userId", count(*)::int AS count
    FROM "Job"
    GROUP BY "userId"
    ORDER BY count DESC
    LIMIT 2
  `
  if (owners.length < 2) throw new Error('Need at least two Job owners for the RLS smoke test')

  const role = `applymate_rls_smoke_${Date.now()}`
  const quotedRole = quoteIdentifier(role)
  let created = false
  try {
    await db.$executeRawUnsafe(`CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    created = true
    await db.$executeRawUnsafe(`GRANT ${quotedRole} TO CURRENT_USER`)
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`)
    await db.$executeRawUnsafe(`GRANT SELECT ON "Job" TO ${quotedRole}`)
    for (const table of V2_TABLES) {
      await db.$executeRawUnsafe(`GRANT SELECT ON "${table}" TO ${quotedRole}`)
    }

    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION app_current_user_id()
          RETURNS text LANGUAGE sql STABLE
          AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$
        `)
        await tx.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION app_current_user_id() TO ${quotedRole}`)
        await tx.$executeRawUnsafe(`SET LOCAL app.applymate_enable_rls = 'on'`)
        await tx.$executeRawUnsafe(`ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY`)
        await tx.$executeRawUnsafe(`ALTER TABLE "Job" FORCE ROW LEVEL SECURITY`)
        await tx.$executeRawUnsafe(`DROP POLICY IF EXISTS candidate_job_isolation ON "Job"`)
        await tx.$executeRawUnsafe(`
          CREATE POLICY candidate_job_isolation ON "Job"
          USING ("userId" = app_current_user_id())
          WITH CHECK ("userId" = app_current_user_id())
        `)
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quotedRole}`)
        const v2 = await tx.$queryRaw<Array<{ name: string; enabled: boolean; readable: boolean }>>`
          WITH expected(name) AS (VALUES
            ('agent_turns'), ('agent_steps'), ('agent_inputs'),
            ('agent_items'), ('agent_events'), ('agent_outbox')
          )
          SELECT expected.name,
                 COALESCE(c.relrowsecurity, false) AS enabled,
                 has_table_privilege(current_user, expected.name, 'SELECT') AS readable
          FROM expected
          LEFT JOIN pg_class c ON c.relname = expected.name
            AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `
        await tx.$executeRaw`SELECT set_config('app.user_id', ${owners[0].userId}, true)`
        const first = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "Job"`
        await tx.$executeRaw`SELECT set_config('app.user_id', ${owners[1].userId}, true)`
        const second = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "Job"`
        await tx.$executeRaw`SELECT set_config('app.user_id', '', true)`
        const empty = await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "Job"`
        const result: Counts = {
          expected: owners.map((owner) => owner.count),
          first: first[0]?.count ?? 0,
          second: second[0]?.count ?? 0,
          empty: empty[0]?.count ?? 0,
          v2,
        }
        throw new Error(`${rollbackPrefix}${JSON.stringify(result)}`)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.startsWith(rollbackPrefix)) throw error
      const result = JSON.parse(message.slice(rollbackPrefix.length)) as Counts
      const v2Ready = result.v2.length === V2_TABLES.length && result.v2.every(table => table.enabled && table.readable)
      if (result.first !== result.expected[0] || result.second !== result.expected[1] || result.empty !== 0 || !v2Ready) {
        throw new Error(`RLS isolation mismatch: ${JSON.stringify(result)}`)
      }
      console.log(JSON.stringify({ status: 'passed', result }))
    }
  } finally {
    if (created) {
      await db.$executeRawUnsafe(`REVOKE ${quotedRole} FROM CURRENT_USER`)
      await db.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON "Job" FROM ${quotedRole}`)
      for (const table of V2_TABLES) {
        await db.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON "${table}" FROM ${quotedRole}`)
      }
      await db.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${quotedRole}`)
      await db.$executeRawUnsafe(`DROP ROLE ${quotedRole}`)
    }
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
