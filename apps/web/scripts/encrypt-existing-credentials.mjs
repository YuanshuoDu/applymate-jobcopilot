import { PrismaClient } from '@prisma/client'
import {
  credentialContext,
  encryptSecret,
  isEncryptedSecret,
} from '@jobcopilot/shared'

const dryRun = process.argv.includes('--dry-run')
const db = new PrismaClient()

function context(scope) {
  return credentialContext(scope)
}

async function encryptAccount(account) {
  const data = {}
  for (const [plain, encrypted, scope] of [
    ['access_token', 'accessTokenEnc', 'access'],
    ['refresh_token', 'refreshTokenEnc', 'refresh'],
    ['id_token', 'idTokenEnc', 'id'],
  ]) {
    if (account[encrypted]) {
      if (account[plain]) data[plain] = null
      continue
    }
    if (!account[plain]) continue
    data[plain] = null
    data[encrypted] = await encryptSecret(
      account[plain],
      context(`account:${account.provider}:${account.providerAccountId}:${scope}`),
    )
  }
  if (!dryRun && Object.keys(data).length > 0) {
    await db.account.update({ where: { id: account.id }, data })
  }
  return Object.keys(data).length > 0
}

async function encryptDiscoveryKeys(row) {
  const data = {}
  for (const [plain, encrypted, scope] of [
    ['adzunaAppId', 'adzunaAppIdEnc', 'adzunaAppId'],
    ['adzunaAppKey', 'adzunaAppKeyEnc', 'adzunaAppKey'],
    ['rapidapiKey', 'rapidapiKeyEnc', 'rapidapiKey'],
  ]) {
    if (row[encrypted]) {
      if (row[plain]) data[plain] = null
      continue
    }
    if (!row[plain]) continue
    data[plain] = null
    data[encrypted] = await encryptSecret(row[plain], context(`discovery:${scope}`))
  }
  if (!dryRun && Object.keys(data).length > 0) {
    await db.userApiKeys.update({ where: { id: row.id }, data })
  }
  return Object.keys(data).length > 0
}

async function encryptAiSettings(userId, preferences) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return null
  const root = { ...preferences }
  const ai = root.aiSettings
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return null
  const next = { ...ai }
  let changed = false

  if (next.keys && typeof next.keys === 'object' && !Array.isArray(next.keys)) {
    next.keys = { ...next.keys }
    for (const [provider, value] of Object.entries(next.keys)) {
      if (typeof value !== 'string' || !value || isEncryptedSecret(value)) continue
      next.keys[provider] = await encryptSecret(value, context(`ai:${userId}:provider:${provider}`))
      changed = true
    }
  }

  if (next.features && typeof next.features === 'object' && !Array.isArray(next.features)) {
    next.features = { ...next.features }
    for (const [feature, raw] of Object.entries(next.features)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const config = { ...raw }
      if (typeof config.apiKey !== 'string' || !config.apiKey || isEncryptedSecret(config.apiKey)) continue
      config.apiKey = await encryptSecret(config.apiKey, context(`ai:${userId}:feature:${feature}`))
      next.features[feature] = config
      changed = true
    }
  }

  if (!changed) return null
  root.aiSettings = next
  return root
}

async function main() {
  const accounts = await db.account.findMany({
    where: { OR: [{ access_token: { not: null } }, { refresh_token: { not: null } }, { id_token: { not: null } }] },
    select: {
      id: true, provider: true, providerAccountId: true,
      access_token: true, accessTokenEnc: true,
      refresh_token: true, refreshTokenEnc: true,
      id_token: true, idTokenEnc: true,
    },
  })
  const apiKeys = await db.userApiKeys.findMany({
    where: { OR: [{ adzunaAppId: { not: null } }, { adzunaAppKey: { not: null } }, { rapidapiKey: { not: null } }] },
    select: {
      id: true, adzunaAppId: true, adzunaAppIdEnc: true,
      adzunaAppKey: true, adzunaAppKeyEnc: true,
      rapidapiKey: true, rapidapiKeyEnc: true,
    },
  })
  const users = await db.user.findMany({ where: { preferences: { not: null } }, select: { id: true, preferences: true } })

  let accountCount = 0
  let apiKeyCount = 0
  let aiCount = 0
  for (const account of accounts) accountCount += Number(await encryptAccount(account))
  for (const row of apiKeys) apiKeyCount += Number(await encryptDiscoveryKeys(row))
  for (const user of users) {
    const preferences = await encryptAiSettings(user.id, user.preferences)
    if (!preferences) continue
    aiCount += 1
    if (!dryRun) await db.user.update({ where: { id: user.id }, data: { preferences } })
  }

  console.log(JSON.stringify({ dryRun, accounts: accountCount, apiKeyRows: apiKeyCount, aiSettings: aiCount }))
}

try {
  await main()
} finally {
  await db.$disconnect()
}
