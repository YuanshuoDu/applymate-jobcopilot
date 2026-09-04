import { pathToFileURL } from "node:url"
import { Pool } from "pg"

import { createPgApplicationSubmitTool, type ApplicationSubmitProvider } from "../src/runtime/tools/application-submit-tool.js"

export const mockAtsSubmit: ApplicationSubmitProvider = async ({ beforeSubmit }) => {
  if (!(await beforeSubmit())) throw { provider: "mock_ats", statusCode: 499 }
  return { confirmationId: "mock-confirmation-0001", postSubmitUrl: "https://mock-ats.invalid/confirmation" }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const applicationTargetId = arg("--target") ?? process.argv[2]
  const receiptId = arg("--receipt")
  const constraintHash = arg("--constraint-hash")
  const userId = arg("--user-id") ?? process.env.APPLYMATE_TEST_USER_ID
  if (!applicationTargetId || !receiptId || !constraintHash || !userId) {
    throw new Error("Usage: tsx scripts/dry-run-submit.ts --target <job-id> --receipt <receipt-id> --constraint-hash <sha256> --user-id <user-id>")
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the staging dry-run")

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const tool = createPgApplicationSubmitTool({ pool, submit: mockAtsSubmit })
    const output = await tool.execute({
      scope: { userId }, sessionId: "dry-run-session", turnId: "dry-run-turn", stepId: "dry-run-step",
      signal: new AbortController().signal, capabilities: ["submission"], reportProgress: async () => undefined,
    }, { applicationTargetId, receiptId, constraintHash })
    console.log(JSON.stringify({ mode: "mock-ats", output }))
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Dry-run failed")
    process.exitCode = 1
  })
}
