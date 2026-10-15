import { Prisma } from "@prisma/client"

import { AgentCommandError } from "./errors"
import type { CommandIdentity } from "./types"
import type { CommandTransaction } from "./transaction"

type PersistedApplicationMaterial = {
  jobId: string
  resumeId: string | null
  coverLetterId: string | null
}

/** Resolve all fill materials from the locked, server-owned ApplicationTask. */
export async function assertApplicationFillPreflight(
  tx: CommandTransaction,
  applicationTaskId: string,
  identity: Pick<CommandIdentity, "userId" | "sessionId">,
): Promise<void> {
  const rows = await tx.$queryRaw<PersistedApplicationMaterial[]>(Prisma.sql`
    SELECT app."jobId", app."resumeId", app."coverLetterId"
    FROM "application_tasks" AS app
    INNER JOIN "Job" AS job ON job."id" = app."jobId" AND job."userId" = app."userId"
    INNER JOIN "Resume" AS resume ON resume."id" = app."resumeId" AND resume."userId" = app."userId"
      AND (resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")
    WHERE app."id" = ${applicationTaskId} AND app."userId" = ${identity.userId}
      AND app."sessionId" = ${identity.sessionId} AND app."resumeId" IS NOT NULL
    FOR SHARE OF app, job, resume
  `)
  const material = rows[0]
  if (!material?.resumeId) throw unavailable()

  if (material.coverLetterId) {
    const coverLetters = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT cover."id" FROM "CoverLetter" AS cover
      WHERE cover."id" = ${material.coverLetterId} AND cover."userId" = ${identity.userId}
        AND cover."jobId" = ${material.jobId}
      FOR SHARE OF cover
    `)
    if (!coverLetters[0]) throw unavailable()
  }
}

function unavailable(): AgentCommandError {
  return new AgentCommandError("retry_target_invalid", "Application fill materials are unavailable for this task", 409)
}
