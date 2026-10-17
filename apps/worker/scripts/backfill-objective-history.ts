import { pathToFileURL } from "node:url"
import { Pool } from "pg"
import {
  backfillObjectiveHistoryProjection,
  type ObjectiveHistoryBackfillOptions,
} from "../src/runtime/context/objective-history-backfill.js"

export type BackfillScriptArguments = Readonly<{ execute: boolean; options: ObjectiveHistoryBackfillOptions }>

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

export function parseBackfillScriptArguments(argv: string[]): BackfillScriptArguments {
  const options: { batchSize?: number; maxBatches?: number } = {}
  let execute = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--execute") execute = true
    else if (argument === "--batch-size") options.batchSize = positiveInteger(argv[++index] ?? "", argument)
    else if (argument === "--max-batches") options.maxBatches = positiveInteger(argv[++index] ?? "", argument)
    else throw new Error(`Unknown backfill argument: ${argument}`)
  }
  return { execute, options }
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseBackfillScriptArguments(argv)
  if (!parsed.execute) {
    process.stdout.write("Objective-history backfill is inert. Pass --execute to invoke it.\n")
    return
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required with --execute")
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const report = await backfillObjectiveHistoryProjection(pool, parsed.options)
    process.stdout.write(JSON.stringify(report) + "\n")
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : "Backfill failed") + "\n")
    process.exitCode = 1
  })
}
