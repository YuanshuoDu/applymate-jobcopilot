import type pg from "pg"

type QueryClient = Pick<pg.PoolClient, "query">

/** Runs a budget read under its owner-bound, repeatable read-only tenant snapshot. */
export async function withRootBudgetTenantSnapshot<T>(
  client: QueryClient,
  userId: string,
  read: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  let committed = false
  try {
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const value = await read()
    await client.query("COMMIT")
    committed = true
    return value
  } catch (error) {
    if (!committed) {
      try { await client.query("ROLLBACK") } catch { /* preserve the original failure */ }
    }
    throw error
  }
}