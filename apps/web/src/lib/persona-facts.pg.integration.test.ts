import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"

import type { PersonaField } from "@/lib/persona"
import { confirmPersonaFacts, revokePersonaFact, setDiscoveryPersonaFactConsent } from "./persona-facts"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("PersonaFact PostgreSQL tests need the disposable CI service URL")
    return null
  }
  const url = new URL(value)
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("PersonaFact PostgreSQL tests require the dedicated loopback disposable URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
let prisma: PrismaClient | undefined
const ownerIds = new Set<string>()

async function createOwner(client: PrismaClient): Promise<string> {
  const id = `persona-fact-owner-${randomUUID()}`
  ownerIds.add(id)
  await client.user.create({ data: { id, email: `${id}@example.invalid` } })
  return id
}

function fact(key: string, value: string): PersonaField {
  return { key, category: "preferences", label: key, value,
    confidence: 1, source: "manual", updatedAt: new Date().toISOString() }
}

function consentInput(row: { id: string; key: string; value: string; normalizedValue: string; updatedAt: Date }, enabled: boolean) {
  return {
    factId: row.id, key: row.key, expectedValue: row.value, expectedNormalizedValue: row.normalizedValue,
    expectedUpdatedAt: row.updatedAt.toISOString(), enabled,
  }
}

describePg("PersonaFact PostgreSQL consent serialization", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await prisma.$connect()
  })

  afterEach(async () => {
    if (!prisma) return
    for (const id of ownerIds) await prisma.user.delete({ where: { id } }).catch(() => undefined)
    ownerIds.clear()
    vi.useRealTimers()
  })

  afterAll(async () => { await prisma?.$disconnect() })

  it("advances same-millisecond consent versions and rejects a stale grant after purpose-only revoke", async () => {
    const client = prisma!
    const userId = await createOwner(client)
    const fixed = new Date("2026-10-24T12:00:00.000Z")
    const row = await client.personaFact.create({ data: {
      id: `fact-${randomUUID()}`, userId, key: "target_location", category: "preferences", value: "Dublin",
      normalizedValue: "dublin", source: "manual", evidence: { label: "Location" }, status: "confirmed",
      allowedUses: ["form_fill"], consentAt: fixed, updatedAt: fixed,
    } })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(fixed)
    try {
      const granted = await setDiscoveryPersonaFactConsent(userId, consentInput(row, true), client)
      expect(granted.kind).toBe("updated")
      if (granted.kind !== "updated") throw new Error("Expected consent grant")
      expect(granted.fact.allowedUses).toContain("discovery")
      expect(new Date(granted.fact.updatedAt).getTime()).toBe(fixed.getTime() + 1)

      const revoked = await setDiscoveryPersonaFactConsent(userId, {
        ...consentInput({ ...row, updatedAt: new Date(granted.fact.updatedAt) }, false),
      }, client)
      expect(revoked.kind).toBe("updated")
      if (revoked.kind !== "updated") throw new Error("Expected purpose-only revoke")
      expect(revoked.fact.allowedUses).not.toContain("discovery")
      expect(new Date(revoked.fact.updatedAt).getTime()).toBe(fixed.getTime() + 2)

      const staleGrant = await setDiscoveryPersonaFactConsent(userId, consentInput({
        ...row, updatedAt: new Date(granted.fact.updatedAt),
      }, true), client)
      expect(staleGrant).toEqual({ kind: "stale" })
      const stored = await client.personaFact.findUniqueOrThrow({ where: { id: row.id } })
      expect(stored.allowedUses).not.toContain("discovery")
      expect(stored.updatedAt.toISOString()).toBe(revoked.fact.updatedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps generic batch confirmation default-off and does not carry a grant to a replacement value", async () => {
    const client = prisma!
    const userId = await createOwner(client)
    const location = fact("target_location", "Dublin")
    const salary = fact("salary_expectation", "75000 EUR")
    const created = await confirmPersonaFacts(userId, [location, salary], client)
    expect(created).toHaveLength(2)
    const initialRows = await client.personaFact.findMany({ where: { userId } })
    expect(initialRows.every(row => !row.allowedUses.includes("discovery"))).toBe(true)
    const first = await client.personaFact.findFirstOrThrow({ where: { userId, key: location.key } })
    expect(first.allowedUses).not.toContain("discovery")

    const grant = await setDiscoveryPersonaFactConsent(userId, consentInput(first, true), client)
    expect(grant.kind).toBe("updated")
    await confirmPersonaFacts(userId, [{ ...location, updatedAt: new Date().toISOString() }], client)
    const preserved = await client.personaFact.findUniqueOrThrow({ where: { id: first.id } })
    expect(preserved.allowedUses).toContain("discovery")

    const replacement = { ...location, value: "Cork", updatedAt: new Date().toISOString() }
    await confirmPersonaFacts(userId, [replacement], client)
    const rows = await client.personaFact.findMany({ where: { userId, key: location.key } })
    expect(rows.find(row => row.status === "superseded")).toBeDefined()
    const replacementRow = rows.find(row => row.status === "confirmed")
    expect(replacementRow?.allowedUses).not.toContain("discovery")

    await revokePersonaFact(userId, replacement.key, client)
    await confirmPersonaFacts(userId, [replacement], client)
    const reactivated = await client.personaFact.findFirstOrThrow({ where: { userId, key: replacement.key, normalizedValue: "cork", status: "confirmed" } })
    expect(reactivated.allowedUses).not.toContain("discovery")
  })
})
