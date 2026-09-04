import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { stableJson } from "./seed.js"
import type { HarnessEvent, HarnessState, JsonValue, ScriptedModelStep } from "./types.js"
import type { LedgerEntry } from "./ledger.js"

export type HarnessTraceStep = {
  readonly index: number
  readonly at: ScriptedModelStep["at"]
  readonly input: JsonValue
  readonly output: JsonValue
}

export type HarnessTrace = {
  readonly schemaVersion: "agent-harness.v2.scripted-trace"
  readonly scenario: string
  readonly seed: number
  readonly wallClock: { readonly start: string; readonly end: string }
  readonly steps: readonly HarnessTraceStep[]
  readonly events: readonly HarnessEvent[]
  readonly ledger: readonly LedgerEntry[]
  readonly finalState: HarnessState
}

export async function writeHarnessTrace(trace: HarnessTrace, outputDirectory = defaultArtifactDirectory()): Promise<string> {
  await mkdir(outputDirectory, { recursive: true })
  const path = resolve(outputDirectory, `harness-contract-${trace.seed}.json`)
  await writeFile(path, `${stableJson(trace)}\n`, "utf8")
  return path
}

function defaultArtifactDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "__artifacts__")
}
