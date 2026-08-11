import { PrismaClient } from '@prisma/client'
import { configureTenantTransaction, currentTenantUserId, runTenantTransaction, tenantRlsEnabled } from './db/tenant-store'

// Singleton pattern — prevent multiple PrismaClient instances in dev hot-reload
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

const baseDb =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = baseDb

const tenantModels = new Set([
  'User', 'Account', 'Session', 'UserPlanChange', 'UserPlanSubscription', 'UserFeatureOverride',
  'Job', 'ApplicationTask', 'ApplicationTaskEvent', 'Resume', 'ResumeVersion', 'PersonaFact',
  'PersonaEvidenceChunk', 'Activity', 'UserApiKeys', 'AgentConfig', 'AgentRole', 'ApplyResult',
  'AiBudget', 'Notification', 'GmailSyncState', 'GmailMessage', 'GmailRecommendation',
  'AgentRunQuestion', 'AgentRun', 'AgentExecution', 'AgentSession', 'SubAgentTask',
  'AgentTranscriptEvent', 'AgentApproval', 'AgentAutomation', 'CustomAgentRole', 'Direction',
  'CoverLetter', 'SupportCase', 'SupportCaseMessage', 'AdminDataDeletionRequest', 'AiUsageEvent',
  'FormPattern',
])

function modelDelegate(tx: unknown, model: string, operation: string) {
  const key = `${model.slice(0, 1).toLowerCase()}${model.slice(1)}`
  const delegate = (tx as Record<string, unknown>)[key]
  if (!delegate || typeof delegate !== 'object') throw new Error(`Unsupported tenant model: ${model}`)
  const method = (delegate as Record<string, unknown>)[operation]
  if (typeof method !== 'function') throw new Error(`Unsupported tenant operation: ${model}.${operation}`)
  return method.bind(delegate)
}

const extendedDb = baseDb.$extends({
  name: 'applymate-tenant-rls',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const userId = currentTenantUserId()
        if (!tenantRlsEnabled() || !userId || !tenantModels.has(model)) return query(args)
        return baseDb.$transaction(async (tx) => {
          await configureTenantTransaction(tx, userId)
          return runTenantTransaction(userId, () => modelDelegate(tx, model, operation)(args))
        })
      },
    },
  },
})

const runtimeDb = new Proxy(extendedDb, {
  get(target, property, receiver) {
    if (property !== '$transaction') return Reflect.get(target, property, receiver)
    return (input: unknown, options?: unknown) => {
      const userId = currentTenantUserId()
      if (tenantRlsEnabled() && userId && Array.isArray(input)) {
        throw new Error('Tenant array transactions must use an interactive callback')
      }
      if (!tenantRlsEnabled() || !userId || typeof input !== 'function') {
        return baseDb.$transaction(input as never, options as never)
      }
      return baseDb.$transaction(async (tx) => {
        await configureTenantTransaction(tx, userId)
        return runTenantTransaction(userId, () => input(tx))
      }, options as never)
    }
  },
})

// Prisma's generated transaction type does not preserve extension metadata.
// The runtime proxy still exposes the generated client contract to callers.
export const db = runtimeDb as unknown as PrismaClient
