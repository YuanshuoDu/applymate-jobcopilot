import { db } from '../src/lib/db'
import { getDeploymentReadiness } from '../src/lib/admin/deployment-readiness'
import type { PlatformIntegrationStatus } from '../src/lib/admin/integration-status'
import { readinessFailures } from '../src/lib/admin/production-readiness-report'

function configured(name: string) {
  return Boolean(process.env[name]?.trim())
}

function integrations(): PlatformIntegrationStatus {
  const workerUrl = configured('WORKER_CONTROL_URL')
  const workerSecret = configured('WORKER_CONTROL_SECRET')
  return {
    ai: { providers: {} as PlatformIntegrationStatus['ai']['providers'] },
    discovery: { adzuna: false, rapidapi: false },
    oauth: { google: false, github: false },
    messaging: { resend: false },
    infrastructure: {
      database: configured('DATABASE_URL'),
      redis: configured('REDIS_URL'),
      workerControl: workerUrl && workerSecret,
      workerControlUrl: workerUrl,
      workerControlSecret: workerSecret,
    },
    privacy: { usageAnalytics: false, aiTraining: false, coverLetterRetention: true },
  }
}

async function main() {
  const readiness = await getDeploymentReadiness({ permissions: ['users.update_preferences'] }, integrations())
  const failures = readinessFailures(readiness)
  console.log(JSON.stringify({ status: failures.length === 0 ? 'ready' : 'blocked', failures, readiness }, null, 2))
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : 'readiness check failed' }))
  process.exitCode = 1
}).finally(() => db.$disconnect())
