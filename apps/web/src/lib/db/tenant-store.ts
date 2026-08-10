import type { Prisma } from '@prisma/client'

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

type TenantStore = {
  userId: string
  inTransaction: boolean
}

type TenantStorage = {
  getStore(): TenantStore | undefined
  enterWith(store: TenantStore): void
  run<T>(store: TenantStore, callback: () => T): T
}

function createTenantStorage(): TenantStorage | null {
  if (typeof window !== 'undefined') return null
  try {
    // Keep the Node-only module out of the browser dependency graph. This file
    // is also imported by shared model configuration used in client pages.
    const nodeRequire = eval('require') as (moduleName: string) => { AsyncLocalStorage: unknown }
    const AsyncLocalStorageConstructor = nodeRequire('node:async_hooks').AsyncLocalStorage as new <T>() => TenantStorage
    return new AsyncLocalStorageConstructor<TenantStore>()
  } catch {
    return null
  }
}

const storage = createTenantStorage()
let browserFallbackUserId: string | null = null

export function validateTenantUserId(userId: string) {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid tenant user id')
}

export function currentTenantUserId() {
  return storage?.getStore()?.userId ?? browserFallbackUserId
}

export function activateTenantContext(userId: string) {
  validateTenantUserId(userId)
  if (storage) storage.enterWith({ userId, inTransaction: false })
  else browserFallbackUserId = userId
}

export function runTenantTransaction<T>(userId: string, callback: () => Promise<T>) {
  validateTenantUserId(userId)
  if (storage) return storage.run({ userId, inTransaction: true }, callback)
  return callback()
}

export function tenantRlsEnabled() {
  return process.env.RLS_RUNTIME_MODE === 'on' && Boolean(process.env.RLS_CANDIDATE_ROLE?.trim())
}

function quotedCandidateRole() {
  const role = process.env.RLS_CANDIDATE_ROLE?.trim() ?? ''
  if (!ROLE_PATTERN.test(role)) throw new Error('Invalid RLS_CANDIDATE_ROLE')
  return `"${role}"`
}

export async function configureTenantTransaction(tx: Prisma.TransactionClient, userId: string) {
  validateTenantUserId(userId)
  await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`
  if (tenantRlsEnabled()) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quotedCandidateRole()}`)
}
