import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const testDatabaseUrl = guardedDatabaseUrl()
const integrationDescribe = testDatabaseUrl ? describe : describe.skip
const migrationName = "20261027120000_restore_custom_agent_role"
const migrationSql = readFileSync(new URL(
  "../../prisma/migrations/20261027120000_restore_custom_agent_role/migration.sql",
  import.meta.url,
), "utf8")
const enableSql = readFileSync(new URL("../../prisma/rls/enable.sql", import.meta.url), "utf8")
const grantsSql = readFileSync(new URL("../../prisma/rls/role-grants.sql", import.meta.url), "utf8")

type PgQueryResult<Row> = { rows: Row[]; rowCount: number | null }

type PgClient = {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row>(sql: string, values?: unknown[]): Promise<PgQueryResult<Row>>
}

type PgModule = {
  Client: new (options: { connectionString: string }) => PgClient
}

type TestConnection = {
  $connect(): Promise<void>
  $disconnect(): Promise<void>
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>
  $transaction<T>(run: (transaction: TestConnection) => Promise<T>): Promise<T>
}

// pg is already a direct dependency of packages/shared; resolve it there without adding a Web dependency.
const sharedRequire = createRequire(fileURLToPath(new URL("../../../../packages/shared/package.json", import.meta.url)))
const postgres = sharedRequire("pg") as PgModule

const expectedColumnDefaults = [
  ["id", "text", true, null],
  ["userId", "text", true, null],
  ["name", "text", true, null],
  ["icon", "text", true, "'🧩'::text"],
  ["description", "text", false, null],
  ["systemPrompt", "text", false, null],
  ["provider", "text", true, "'anthropic'::text"],
  ["model", "text", true, "'claude-haiku-4-5-20251001'::text"],
  ["insertAfter", "text", true, "'auditor'::text"],
  ["enabled", "boolean", true, "true"],
  ["sortOrder", "integer", true, "0"],
  ["createdAt", "timestamp(3) without time zone", true, "current_timestamp"],
  ["updatedAt", "timestamp(3) without time zone", true, null],
] as const

type ColumnShape = {
  attnum: number
  column_name: string
  formatted_type: string
  is_not_null: boolean
  default_expression: string | null
  generated_kind: string
  identity_kind: string
}

type ConstraintShape = {
  name: string
  constraint_type: string
  definition: string
  is_validated: boolean
  is_deferrable: boolean
  is_deferred: boolean
  delete_action: string | null
  update_action: string | null
  source_attnum: number | null
  target_attnum: number | null
  referenced_table: string | null
}

type IndexShape = {
  name: string
  definition: string
  access_method: string
  is_valid: boolean
  is_ready: boolean
  is_live: boolean
  is_unique: boolean
  is_primary: boolean
  is_exclusion: boolean
  key_count: number
  attribute_count: number
  key_attnums: string
  options: string
  has_expressions: boolean
  has_predicate: boolean
}

type RoleRow = {
  id: string
  userId: string
  name: string
  icon: string
}

type DefaultRow = {
  icon: string
  provider: string
  model: string
  insertAfter: string
  enabled: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

type CatalogShape = {
  columns: ColumnShape[]
  constraints: ConstraintShape[]
  indexes: IndexShape[]
}

type CatalogQueryClient = TestConnection

function guardedDatabaseUrl(): string | undefined {
  const requestedUrl = process.env.CUSTOM_AGENT_ROLE_PG_TEST_URL
  const disposable = process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE
  const required = process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED
  const requested = requestedUrl !== undefined || disposable !== undefined || required !== undefined
  if (!requested) return undefined

  const expected = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_custom_agent_role_ci"
  if (
    process.env.CI !== "true"
    || required !== "true"
    || disposable !== "true"
    || requestedUrl !== expected
  ) {
    throw new Error(
      "CustomAgentRole PostgreSQL integration requires CI=true, CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED=true, "
      + "CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE=true, and the fixed localhost applymate_custom_agent_role_ci URL",
    )
  }

  const parsed = new URL(requestedUrl)
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
    throw new Error("CustomAgentRole PostgreSQL integration rejected a non-disposable database URL")
  }
  return requestedUrl
}

function createTestConnection(connectionString: string): TestConnection {
  const driver = new postgres.Client({ connectionString })
  const connection: TestConnection = {
    async $connect() {
      await driver.connect()
    },
    async $disconnect() {
      await driver.end()
    },
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      const result = await driver.query<T>(sql, values.length > 0 ? values : undefined)
      return result.rows as T
    },
    async $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
      const result = await driver.query(sql, values.length > 0 ? values : undefined)
      return result.rowCount ?? 0
    },
    async $transaction<T>(run: (transaction: TestConnection) => Promise<T>): Promise<T> {
      await driver.query("BEGIN")
      try {
        const value = await run(connection)
        await driver.query("COMMIT")
        return value
      } catch (error) {
        await driver.query("ROLLBACK")
        throw error
      }
    },
  }
  return connection
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let index = 0
  let inSingleQuote = false
  let inEscapeString = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarQuote: string | undefined

  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length
        dollarQuote = undefined
      } else {
        index += 1
      }
      continue
    }
    if (inLineComment) {
      if (current === "\n") inLineComment = false
      index += 1
      continue
    }
    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1
        index += 2
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (inSingleQuote) {
      if (current === "'" && next === "'") {
        index += 2
      } else if (current === "'") {
        inSingleQuote = false
        inEscapeString = false
        index += 1
      } else if (inEscapeString && current === "\\") {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (inDoubleQuote) {
      if (current === "\"" && next === "\"") {
        index += 2
      } else if (current === "\"") {
        inDoubleQuote = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (current === "-" && next === "-") {
      inLineComment = true
      index += 2
      continue
    }
    if (current === "/" && next === "*") {
      blockCommentDepth = 1
      index += 2
      continue
    }
    if (current === "\"") {
      inDoubleQuote = true
      index += 1
      continue
    }
    if (current === "'") {
      inSingleQuote = true
      inEscapeString = index > 0
        && /[eE]/.test(sql[index - 1])
        && (index < 2 || !/[A-Za-z0-9_$]/.test(sql[index - 2]))
      index += 1
      continue
    }
    if (current === "$") {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
      if (tag) {
        dollarQuote = tag
        index += tag.length
        continue
      }
    }
    if (current === ";") {
      const statement = sql.slice(start, index).trim()
      if (statement) statements.push(statement)
      start = index + 1
    }
    index += 1
  }

  if (inSingleQuote || inDoubleQuote || blockCommentDepth > 0 || dollarQuote) {
    throw new Error("Unable to split an unterminated PostgreSQL statement")
  }
  const trailingStatement = sql.slice(start).trim()
  if (trailingStatement) statements.push(trailingStatement)
  return statements
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined
    return cause === undefined ? error.message : error.message + "\n" + errorText(cause)
  }
  return String(error)
}

async function withRollback<T>(
  client: TestConnection,
  run: (transaction: TestConnection) => Promise<T>,
): Promise<T> {
  const rollbackMarker = new Error("rollback disposable CustomAgentRole fixture")
  let result!: T
  try {
    await client.$transaction(async (transaction) => {
      result = await run(transaction)
      throw rollbackMarker
    })
  } catch (error) {
    if (error !== rollbackMarker) throw error
  }
  return result
}

async function readCatalogShape(client: CatalogQueryClient): Promise<CatalogShape> {
  const columnsSql = [
    "SELECT attribute.attnum, attribute.attname AS column_name,",
    "  format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,",
    "  attribute.attnotnull AS is_not_null,",
    "  pg_get_expr(column_default.adbin, column_default.adrelid) AS default_expression,",
    "  attribute.attgenerated AS generated_kind, attribute.attidentity AS identity_kind",
    "FROM pg_attribute AS attribute",
    "LEFT JOIN pg_attrdef AS column_default",
    "  ON column_default.adrelid = attribute.attrelid AND column_default.adnum = attribute.attnum",
    "WHERE attribute.attrelid = 'public.\"CustomAgentRole\"'::regclass",
    "  AND attribute.attnum > 0 AND NOT attribute.attisdropped",
    "ORDER BY attribute.attnum",
  ].join("\n")
  const columns = await client.$queryRawUnsafe<ColumnShape[]>(columnsSql)

  const constraintsSql = [
    "SELECT constraint_info.conname AS name, constraint_info.contype::text AS constraint_type,",
    "  replace(pg_catalog.pg_get_constraintdef(constraint_info.oid), 'REFERENCES public.', 'REFERENCES ') AS definition,",
    "  constraint_info.convalidated AS is_validated,",
    "  constraint_info.condeferrable AS is_deferrable, constraint_info.condeferred AS is_deferred,",
    "  constraint_info.confdeltype::text AS delete_action,",
    "  constraint_info.confupdtype::text AS update_action,",
    "  constraint_info.conkey[1]::integer AS source_attnum,",
    "  constraint_info.confkey[1]::integer AS target_attnum,",
    "  referenced_table.relname AS referenced_table",
    "FROM pg_constraint AS constraint_info",
    "LEFT JOIN pg_class AS referenced_table ON referenced_table.oid = constraint_info.confrelid",
    "WHERE constraint_info.conrelid = 'public.\"CustomAgentRole\"'::regclass",
    "ORDER BY constraint_info.conname",
  ].join("\n")
  const constraints = await client.$queryRawUnsafe<ConstraintShape[]>(constraintsSql)

  const indexesSql = [
    "SELECT index_relation.relname AS name, pg_get_indexdef(index_info.indexrelid) AS definition,",
    "  access_method.amname AS access_method,",
    "  index_info.indisvalid AS is_valid, index_info.indisready AS is_ready,",
    "  index_info.indislive AS is_live, index_info.indisunique AS is_unique,",
    "  index_info.indisprimary AS is_primary, index_info.indisexclusion AS is_exclusion,",
    "  index_info.indnkeyatts AS key_count, index_info.indnatts AS attribute_count,",
    "  index_info.indkey::text AS key_attnums, index_info.indoption::text AS options,",
    "  index_info.indexprs IS NOT NULL AS has_expressions,",
    "  index_info.indpred IS NOT NULL AS has_predicate",
    "FROM pg_index AS index_info",
    "JOIN pg_class AS index_relation ON index_relation.oid = index_info.indexrelid",
    "JOIN pg_am AS access_method ON access_method.oid = index_relation.relam",
    "WHERE index_info.indrelid = 'public.\"CustomAgentRole\"'::regclass",
    "ORDER BY index_relation.relname",
  ].join("\n")
  const indexes = await client.$queryRawUnsafe<IndexShape[]>(indexesSql)
  return { columns, constraints, indexes }
}

async function createCompatibleLegacyTable(transaction: TestConnection): Promise<void> {
  await transaction.$executeRawUnsafe("DROP TABLE public.\"CustomAgentRole\"")
  await transaction.$executeRawUnsafe([
    "CREATE TABLE public.\"CustomAgentRole\" (",
    "  \"id\" TEXT NOT NULL,",
    "  \"userId\" TEXT NOT NULL,",
    "  \"name\" TEXT NOT NULL,",
    "  \"icon\" TEXT NOT NULL DEFAULT '🧩',",
    "  \"description\" TEXT,",
    "  \"systemPrompt\" TEXT,",
    "  \"provider\" TEXT NOT NULL DEFAULT 'anthropic',",
    "  \"model\" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',",
    "  \"insertAfter\" TEXT NOT NULL DEFAULT 'auditor',",
    "  \"enabled\" BOOLEAN NOT NULL DEFAULT true,",
    "  \"sortOrder\" INTEGER NOT NULL DEFAULT 0,",
    "  \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,",
    "  \"updatedAt\" TIMESTAMP(3) NOT NULL,",
    "  CONSTRAINT \"CustomAgentRole_pkey\" PRIMARY KEY (\"id\"),",
    "  CONSTRAINT \"CustomAgentRole_userId_fkey\"",
    "    FOREIGN KEY (\"userId\") REFERENCES public.\"User\"(\"id\")",
    "    ON DELETE CASCADE ON UPDATE CASCADE",
    ")",
  ].join("\n"))
  await transaction.$executeRawUnsafe(
    "CREATE INDEX \"CustomAgentRole_userId_idx\" ON public.\"CustomAgentRole\" USING btree (\"userId\")",
  )
}

async function insertLegacySentinel(
  transaction: TestConnection,
  roleId: string,
  userId: string,
): Promise<RoleRow> {
  await transaction.$executeRawUnsafe(
    "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
    + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
    roleId,
    userId,
    "legacy row to preserve",
  )
  const rows = await transaction.$queryRawUnsafe<RoleRow[]>(
    "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\" WHERE \"id\" = $1",
    roleId,
  )
  return rows[0]
}

async function assertIncompatibleShapeFailsClosed(
  client: TestConnection,
  userId: string,
  description: string,
  mutate: (transaction: TestConnection) => Promise<void>,
): Promise<void> {
  await withRollback(client, async (transaction) => {
    await createCompatibleLegacyTable(transaction)
    const roleId = "custom-role-incompatible-" + randomUUID()
    const preservedRow = await insertLegacySentinel(transaction, roleId, userId)
    await mutate(transaction)
    const shapeBeforeMigration = await readCatalogShape(transaction)

    await transaction.$executeRawUnsafe("SAVEPOINT custom_agent_role_migration_attempt")
    let failure: unknown
    try {
      await transaction.$executeRawUnsafe(migrationSql)
    } catch (error) {
      failure = error
    }
    expect(failure, description + " migration rejection").toBeDefined()
    expect(errorText(failure), description + " rejection reason")
      .toContain("CustomAgentRole existing schema is incompatible")
    await transaction.$executeRawUnsafe("ROLLBACK TO SAVEPOINT custom_agent_role_migration_attempt")

    expect(await readCatalogShape(transaction), description + " original schema").toEqual(shapeBeforeMigration)
    const rowsAfterFailure = await transaction.$queryRawUnsafe<RoleRow[]>(
      "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\" WHERE \"id\" = $1",
      roleId,
    )
    expect(rowsAfterFailure, description + " original data").toEqual([preservedRow])
  })
}

async function setTenantContext(
  transaction: TestConnection,
  userId: string,
): Promise<void> {
  await transaction.$queryRawUnsafe<Array<{ value: string | null }>>(
    "SELECT set_config('app.user_id', $1, true) AS value",
    userId,
  )
}

async function createTemporaryCatalogShadows(transaction: TestConnection): Promise<void> {
  const catalogNames = ["pg_class", "pg_attribute", "pg_constraint", "pg_attrdef", "pg_index", "pg_am", "pg_opclass"]
  for (const name of catalogNames) {
    await transaction.$executeRawUnsafe("CREATE TEMP TABLE " + name + " (shadow_marker boolean) ON COMMIT DROP")
  }
}

integrationDescribe("CustomAgentRole PostgreSQL migration and candidate RLS", () => {
  let client: TestConnection
  let ownerUserId: string
  let foreignUserId: string
  let ownerRoleId: string
  let foreignRoleId: string

  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error("The disposable CustomAgentRole database guard was not initialized")
    client = createTestConnection(testDatabaseUrl)
    await client.$connect()
    const connectedDatabase = await client.$queryRawUnsafe<Array<{ database_name: string }>>(
      "SELECT current_database() AS database_name",
    )
    expect(connectedDatabase).toEqual([{ database_name: "applymate_custom_agent_role_ci" }])

    ownerUserId = "custom-agent-role-owner-" + randomUUID()
    foreignUserId = "custom-agent-role-foreign-" + randomUUID()
    await client.$queryRawUnsafe<Array<{ id: string }>>(
      "INSERT INTO public.\"User\" (\"id\", \"email\", \"onboardingGoals\", \"updatedAt\") "
      + "VALUES ($1, $2, ARRAY[]::text[], CURRENT_TIMESTAMP) RETURNING \"id\"",
      ownerUserId,
      "custom-agent-role-owner-" + randomUUID() + "@example.invalid",
    )
    await client.$queryRawUnsafe<Array<{ id: string }>>(
      "INSERT INTO public.\"User\" (\"id\", \"email\", \"onboardingGoals\", \"updatedAt\") "
      + "VALUES ($1, $2, ARRAY[]::text[], CURRENT_TIMESTAMP) RETURNING \"id\"",
      foreignUserId,
      "custom-agent-role-foreign-" + randomUUID() + "@example.invalid",
    )

    ownerRoleId = "custom-role-owner-" + randomUUID()
    foreignRoleId = "custom-role-foreign-" + randomUUID()
    await client.$executeRawUnsafe(
      "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
      + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
      ownerRoleId,
      ownerUserId,
      "owner role",
    )
    await client.$executeRawUnsafe(
      "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
      + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
      foreignRoleId,
      foreignUserId,
      "foreign role",
    )
  })

  afterAll(async () => {
    if (!client) return
    try {
      const userIds = [ownerUserId, foreignUserId].filter(Boolean)
      if (userIds.length > 0) {
        await client.$executeRawUnsafe(
          "DELETE FROM public.\"User\" WHERE \"id\" = ANY($1::text[])",
          userIds,
        )
      }
    } finally {
      await client.$disconnect()
    }
  })

  it("applies the migration to a fresh database with the exact 13-column Prisma contract", async () => {
    const migrationSqlQuery = [
      "SELECT migration_name, finished_at IS NOT NULL AS is_finished,",
      "  rolled_back_at IS NOT NULL AS is_rolled_back",
      "FROM public.\"_prisma_migrations\"",
      "WHERE migration_name = $1",
    ].join("\n")
    const completedMigration = await client.$queryRawUnsafe<Array<{
      migration_name: string
      is_finished: boolean
      is_rolled_back: boolean
    }>>(migrationSqlQuery, migrationName)
    expect(completedMigration).toEqual([{
      migration_name: migrationName,
      is_finished: true,
      is_rolled_back: false,
    }])

    const shape = await readCatalogShape(client)
    expect(shape.columns).toHaveLength(13)
    expect(shape.columns.map((column) => [
      column.column_name,
      column.formatted_type,
      column.is_not_null,
      column.default_expression?.trim().toLowerCase() ?? null,
    ])).toEqual(expectedColumnDefaults)

    const primaryKey = shape.constraints.find((constraint) => constraint.constraint_type === "p")
    expect(primaryKey).toMatchObject({
      name: "CustomAgentRole_pkey",
      definition: "PRIMARY KEY (id)",
      is_validated: true,
      is_deferrable: false,
      is_deferred: false,
    })
    const userColumn = shape.columns.find((column) => column.column_name === "userId")
    const userPrimaryKey = await client.$queryRawUnsafe<Array<{ attnum: number }>>([
      "SELECT attnum FROM pg_attribute",
      "WHERE attrelid = 'public.\"User\"'::regclass AND attname = 'id'",
      "  AND attnum > 0 AND NOT attisdropped",
    ].join("\n"))
    const foreignKey = shape.constraints.find((constraint) => constraint.constraint_type === "f")
    expect(foreignKey).toMatchObject({
      name: "CustomAgentRole_userId_fkey",
      is_validated: true,
      is_deferrable: false,
      is_deferred: false,
      delete_action: "c",
      update_action: "c",
      source_attnum: userColumn?.attnum,
      target_attnum: userPrimaryKey[0]?.attnum,
      referenced_table: "User",
    })
    expect(shape.constraints).toHaveLength(2)

    const userIndex = shape.indexes.find((index) => index.name === "CustomAgentRole_userId_idx")
    expect(userIndex).toMatchObject({
      access_method: "btree",
      is_valid: true,
      is_ready: true,
      is_live: true,
      is_unique: false,
      is_primary: false,
      is_exclusion: false,
      key_count: 1,
      attribute_count: 1,
      key_attnums: String(userColumn?.attnum),
      options: "0",
      has_expressions: false,
      has_predicate: false,
    })
    const indexSemantics = await client.$queryRawUnsafe<Array<{
      opclass_name: string
      is_default_opclass: boolean
      opclass_input_type: string
      index_collation_oids: string
      column_collation_oid: string
      default_collation_oid: string
    }>>([
      "SELECT opclass.opcname AS opclass_name, opclass.opcdefault AS is_default_opclass,",
      "  opclass.opcintype::regtype::text AS opclass_input_type,",
      "  role_index.indcollation::text AS index_collation_oids,",
      "  user_column.attcollation::text AS column_collation_oid,",
      "  pg_catalog.to_regcollation('pg_catalog.default')::oid::text AS default_collation_oid",
      "FROM pg_index AS role_index",
      "JOIN pg_class AS index_relation ON index_relation.oid = role_index.indexrelid",
      "JOIN pg_am AS access_method ON access_method.oid = index_relation.relam",
      "JOIN pg_opclass AS opclass ON role_index.indclass::text = opclass.oid::text",
      "JOIN pg_attribute AS user_column",
      "  ON user_column.attrelid = role_index.indrelid AND user_column.attname = 'userId'",
      "WHERE role_index.indrelid = 'public.\"CustomAgentRole\"'::regclass",
      "  AND index_relation.relname = 'CustomAgentRole_userId_idx'",
      "  AND access_method.amname = 'btree'",
    ].join("\n"))
    expect(indexSemantics).toHaveLength(1)
    expect(indexSemantics[0]).toMatchObject({
      opclass_name: "text_ops",
      is_default_opclass: true,
      opclass_input_type: "text",
    })
    expect(indexSemantics[0]?.column_collation_oid).toBe(indexSemantics[0]?.default_collation_oid)
    expect(indexSemantics[0]?.index_collation_oids).toBe(indexSemantics[0]?.column_collation_oid)

    const defaultsQuery = [
      "SELECT \"icon\", \"provider\", \"model\", \"insertAfter\", \"enabled\", \"sortOrder\", \"createdAt\", \"updatedAt\"",
      "FROM public.\"CustomAgentRole\" WHERE \"id\" = $1",
    ].join("\n")
    const defaults = await client.$queryRawUnsafe<DefaultRow[]>(defaultsQuery, ownerRoleId)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toMatchObject({
      icon: "🧩",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      insertAfter: "auditor",
      enabled: true,
      sortOrder: 0,
    })
    expect(defaults[0]?.createdAt).toBeInstanceOf(Date)
    expect(defaults[0]?.updatedAt).toBeInstanceOf(Date)
  })

  it("preserves a compatible table under a hostile search_path with temporary catalog shadows", async () => {
    await withRollback(client, async (transaction) => {
      await createCompatibleLegacyTable(transaction)
      const roleId = "custom-role-compatible-" + randomUUID()
      const preservedRow = await insertLegacySentinel(transaction, roleId, ownerUserId)
      const shapeBeforeMigration = await readCatalogShape(transaction)

      await createTemporaryCatalogShadows(transaction)
      await transaction.$executeRawUnsafe("SET LOCAL search_path TO pg_temp, pg_catalog, public")
      const shadows = await transaction.$queryRawUnsafe<Array<{ shadow_count: number }>>([
        "SELECT count(*)::integer AS shadow_count",
        "FROM pg_catalog.pg_class",
        "WHERE relnamespace = pg_catalog.pg_my_temp_schema()",
        "  AND relname IN ('pg_class', 'pg_attribute', 'pg_constraint', 'pg_attrdef', 'pg_index', 'pg_am', 'pg_opclass')",
      ].join("\n"))
      expect(shadows).toEqual([{ shadow_count: 7 }])

      const hostilePath = await transaction.$queryRawUnsafe<Array<{ search_path: string }>>("SHOW search_path")
      expect(hostilePath[0]?.search_path).toBe("pg_temp, pg_catalog, public")
      expect(splitSqlStatements(migrationSql)).toHaveLength(1)
      await transaction.$executeRawUnsafe(migrationSql)
      const hardenedPath = await transaction.$queryRawUnsafe<Array<{ search_path: string }>>("SHOW search_path")
      expect(hardenedPath[0]?.search_path).toBe("pg_catalog, pg_temp")
      expect(await readCatalogShape(transaction)).toEqual(shapeBeforeMigration)

      const rowsQuery = [
        "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\"",
        "WHERE \"id\" = $1",
      ].join("\n")
      const rows = await transaction.$queryRawUnsafe<RoleRow[]>(rowsQuery, roleId)
      expect(rows).toEqual([preservedRow])
    })
  })

  it("rejects incompatible columns, defaults, foreign keys, and indexes without changing their rows", async () => {
    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "column type", async (transaction) => {
      await transaction.$executeRawUnsafe(
        "ALTER TABLE public.\"CustomAgentRole\" ALTER COLUMN \"name\" TYPE VARCHAR(100)",
      )
    })
    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "column default", async (transaction) => {
      await transaction.$executeRawUnsafe(
        "ALTER TABLE public.\"CustomAgentRole\" ALTER COLUMN \"icon\" SET DEFAULT 'wrong-icon'",
      )
    })
    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "foreign-key action", async (transaction) => {
      await transaction.$executeRawUnsafe(
        "ALTER TABLE public.\"CustomAgentRole\" "
        + "DROP CONSTRAINT \"CustomAgentRole_userId_fkey\", "
        + "ADD CONSTRAINT \"CustomAgentRole_userId_fkey\" "
        + "FOREIGN KEY (\"userId\") REFERENCES public.\"User\"(\"id\") "
        + "ON DELETE RESTRICT ON UPDATE CASCADE",
      )
    })
    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "index column", async (transaction) => {
      await transaction.$executeRawUnsafe("DROP INDEX public.\"CustomAgentRole_userId_idx\"")
      await transaction.$executeRawUnsafe(
        "CREATE INDEX \"CustomAgentRole_userId_idx\" "
        + "ON public.\"CustomAgentRole\" USING btree (\"id\")",
      )
    })
    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "non-default text opclass", async (transaction) => {
      await transaction.$executeRawUnsafe("DROP INDEX public.\"CustomAgentRole_userId_idx\"")
      await transaction.$executeRawUnsafe(
        "CREATE INDEX \"CustomAgentRole_userId_idx\" "
        + "ON public.\"CustomAgentRole\" USING btree (\"userId\" pg_catalog.text_pattern_ops)",
      )
    })
  })

  it("rejects a same-name index with a different available collation", async (context) => {
    const alternateCollation = await client.$queryRawUnsafe<Array<{ is_available: boolean }>>(
      "SELECT pg_catalog.to_regcollation('pg_catalog.\"C\"') IS NOT NULL AS is_available",
    )
    if (!alternateCollation[0]?.is_available) {
      console.warn("Skipped alternate-collation rejection: pg_catalog.\"C\" is unavailable on this PostgreSQL service")
      context.skip()
      return
    }

    await assertIncompatibleShapeFailsClosed(client, ownerUserId, "non-default index collation", async (transaction) => {
      await transaction.$executeRawUnsafe("DROP INDEX public.\"CustomAgentRole_userId_idx\"")
      await transaction.$executeRawUnsafe(
        "CREATE INDEX \"CustomAgentRole_userId_idx\" "
        + "ON public.\"CustomAgentRole\" USING btree (\"userId\" COLLATE pg_catalog.\"C\")",
      )
    })
  })

  it("executes the full gated RLS and grants scripts and enforces candidate tenant CRUD", async () => {
    await withRollback(client, async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL app.applymate_enable_rls = 'on'")
      const enableStatements = splitSqlStatements(enableSql)
      const grantsStatements = splitSqlStatements(grantsSql)
      expect(enableStatements.length).toBeGreaterThan(1)
      expect(grantsStatements.length).toBeGreaterThan(1)
      for (const statement of enableStatements) {
        await transaction.$executeRawUnsafe(statement)
      }
      for (const statement of grantsStatements) {
        await transaction.$executeRawUnsafe(statement)
      }

      const tableSecurity = await transaction.$queryRawUnsafe<Array<{ rls_enabled: boolean }>>([
        "SELECT relrowsecurity AS rls_enabled FROM pg_class",
        "WHERE oid = 'public.\"CustomAgentRole\"'::regclass",
      ].join("\n"))
      expect(tableSecurity).toEqual([{ rls_enabled: true }])
      const policy = await transaction.$queryRawUnsafe<Array<{
        using_expression: string | null
        check_expression: string | null
      }>>([
        "SELECT qual AS using_expression, with_check AS check_expression FROM pg_policies",
        "WHERE schemaname = 'public' AND tablename = 'CustomAgentRole'",
        "  AND policyname = 'candidate_custom_agent_role_isolation'",
      ].join("\n"))
      expect(policy).toHaveLength(1)
      expect(policy[0]?.using_expression).toContain("\"userId\" = app_current_user_id()")
      expect(policy[0]?.check_expression).toContain("\"userId\" = app_current_user_id()")

      const candidateRole = await transaction.$queryRawUnsafe<Array<{
        can_login: boolean
        is_superuser: boolean
        can_create_database: boolean
        can_create_roles: boolean
        inherits_roles: boolean
        bypasses_rls: boolean
      }>>([
        "SELECT rolcanlogin AS can_login, rolsuper AS is_superuser,",
        "  rolcreatedb AS can_create_database, rolcreaterole AS can_create_roles,",
        "  rolinherit AS inherits_roles, rolbypassrls AS bypasses_rls",
        "FROM pg_roles WHERE rolname = 'applymate_candidate'",
      ].join("\n"))
      expect(candidateRole).toEqual([{
        can_login: false,
        is_superuser: false,
        can_create_database: false,
        can_create_roles: false,
        inherits_roles: false,
        bypasses_rls: false,
      }])
      const privileges = await transaction.$queryRawUnsafe<Array<{
        connection_user: string
        active_role: string
        search_path: string
        can_select: boolean
        can_insert: boolean
        can_update: boolean
        can_delete: boolean
        has_select_acl: boolean
        has_insert_acl: boolean
        has_update_acl: boolean
        has_delete_acl: boolean
      }>([
        "SELECT",
        "  current_user::text AS connection_user, current_role::text AS active_role,",
        "  current_setting('search_path') AS search_path,",
        "  pg_catalog.has_table_privilege(candidate.oid, custom_role.oid, 'SELECT') AS can_select,",
        "  pg_catalog.has_table_privilege(candidate.oid, custom_role.oid, 'INSERT') AS can_insert,",
        "  pg_catalog.has_table_privilege(candidate.oid, custom_role.oid, 'UPDATE') AS can_update,",
        "  pg_catalog.has_table_privilege(candidate.oid, custom_role.oid, 'DELETE') AS can_delete,",
        "  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(custom_role.relacl,",
        "    pg_catalog.acldefault('r', custom_role.relowner))) AS acl",
        "    WHERE acl.grantee = candidate.oid AND acl.privilege_type = 'SELECT') AS has_select_acl,",
        "  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(custom_role.relacl,",
        "    pg_catalog.acldefault('r', custom_role.relowner))) AS acl",
        "    WHERE acl.grantee = candidate.oid AND acl.privilege_type = 'INSERT') AS has_insert_acl,",
        "  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(custom_role.relacl,",
        "    pg_catalog.acldefault('r', custom_role.relowner))) AS acl",
        "    WHERE acl.grantee = candidate.oid AND acl.privilege_type = 'UPDATE') AS has_update_acl,",
        "  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(custom_role.relacl,",
        "    pg_catalog.acldefault('r', custom_role.relowner))) AS acl",
        "    WHERE acl.grantee = candidate.oid AND acl.privilege_type = 'DELETE') AS has_delete_acl",
        "FROM pg_catalog.pg_roles AS candidate",
        "JOIN pg_catalog.pg_class AS custom_role",
        "  ON custom_role.oid = 'public.\"CustomAgentRole\"'::pg_catalog.regclass",
        "WHERE candidate.rolname = 'applymate_candidate'",
      ].join("\n"))
      expect(privileges).toEqual([{
        connection_user: "postgres",
        active_role: "postgres",
        search_path: '"$user", public',
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
        has_select_acl: true,
        has_insert_acl: true,
        has_update_acl: true,
        has_delete_acl: true,
      }])

      await transaction.$executeRawUnsafe("SET LOCAL ROLE applymate_candidate")
      await setTenantContext(transaction, ownerUserId)
      const candidateRoleId = "custom-role-candidate-crud-" + randomUUID()
      const tenantRowsQuery = [
        "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\"",
        "WHERE \"id\" IN ($1, $2) ORDER BY \"id\"",
      ].join("\n")
      const visibleToOwner = await transaction.$queryRawUnsafe<RoleRow[]>(
        tenantRowsQuery,
        ownerRoleId,
        foreignRoleId,
      )
      expect(visibleToOwner.map((row) => row.id)).toEqual([ownerRoleId])
      expect(visibleToOwner[0]?.userId).toBe(ownerUserId)

      await transaction.$executeRawUnsafe("SAVEPOINT custom_agent_role_cross_tenant_insert")
      let crossTenantInsertFailure: unknown
      try {
        await transaction.$executeRawUnsafe(
          "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
          + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
          "custom-role-cross-tenant-" + randomUUID(),
          foreignUserId,
          "must not be inserted",
        )
      } catch (error) {
        crossTenantInsertFailure = error
      }
      expect(crossTenantInsertFailure, "candidate cannot create a role for another tenant").toBeDefined()
      expect(errorText(crossTenantInsertFailure)).toMatch(/row-level security/i)
      await transaction.$executeRawUnsafe("ROLLBACK TO SAVEPOINT custom_agent_role_cross_tenant_insert")

      const created = await transaction.$executeRawUnsafe(
        "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
        + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
        candidateRoleId,
        ownerUserId,
        "candidate-created",
      )
      expect(created).toBe(1)
      const ownCreatedRow = await transaction.$queryRawUnsafe<RoleRow[]>(
        "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\" WHERE \"id\" = $1",
        candidateRoleId,
      )
      expect(ownCreatedRow).toMatchObject([{
        id: candidateRoleId,
        userId: ownerUserId,
        name: "candidate-created",
        icon: "🧩",
      }])

      const updated = await transaction.$executeRawUnsafe(
        "UPDATE public.\"CustomAgentRole\" SET \"name\" = $1 WHERE \"id\" = $2",
        "candidate-updated",
        candidateRoleId,
      )
      expect(updated).toBe(1)
      const hiddenForeignUpdate = await transaction.$executeRawUnsafe(
        "UPDATE public.\"CustomAgentRole\" SET \"name\" = $1 WHERE \"id\" = $2",
        "must remain foreign",
        foreignRoleId,
      )
      expect(hiddenForeignUpdate).toBe(0)

      await setTenantContext(transaction, foreignUserId)
      const visibleToForeign = await transaction.$queryRawUnsafe<RoleRow[]>(
        tenantRowsQuery,
        ownerRoleId,
        foreignRoleId,
      )
      expect(visibleToForeign.map((row) => row.id)).toEqual([foreignRoleId])
      expect(visibleToForeign[0]?.userId).toBe(foreignUserId)

      await setTenantContext(transaction, "")
      const emptyTenantRows = await transaction.$queryRawUnsafe<RoleRow[]>(
        [
          "SELECT \"id\", \"userId\", \"name\", \"icon\" FROM public.\"CustomAgentRole\"",
          "WHERE \"id\" IN ($1, $2, $3) ORDER BY \"id\"",
        ].join("\n"),
        ownerRoleId,
        foreignRoleId,
        candidateRoleId,
      )
      expect(emptyTenantRows).toEqual([])

      await transaction.$executeRawUnsafe("SAVEPOINT custom_agent_role_empty_tenant_insert")
      let emptyTenantInsertFailure: unknown
      try {
        await transaction.$executeRawUnsafe(
          "INSERT INTO public.\"CustomAgentRole\" (\"id\", \"userId\", \"name\", \"updatedAt\") "
          + "VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
          "custom-role-empty-tenant-" + randomUUID(),
          ownerUserId,
          "must not be inserted without a tenant",
        )
      } catch (error) {
        emptyTenantInsertFailure = error
      }
      expect(emptyTenantInsertFailure, "candidate without a tenant cannot create a role").toBeDefined()
      expect(errorText(emptyTenantInsertFailure)).toMatch(/row-level security/i)
      await transaction.$executeRawUnsafe("ROLLBACK TO SAVEPOINT custom_agent_role_empty_tenant_insert")

      await setTenantContext(transaction, ownerUserId)
      const deleted = await transaction.$executeRawUnsafe(
        "DELETE FROM public.\"CustomAgentRole\" WHERE \"id\" = $1",
        candidateRoleId,
      )
      expect(deleted).toBe(1)
    })
  })
})
