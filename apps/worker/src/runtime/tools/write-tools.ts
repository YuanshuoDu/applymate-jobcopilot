import type pg from "pg"

import {
  createPgApplicationSubmitTool,
  type ApplicationSubmitProvider,
} from "./application-submit-tool.js"
import type { RuntimeToolDefinition } from "./types.js"

export type WriteToolOptions = {
  readonly pool: pg.Pool
  readonly submit: ApplicationSubmitProvider
}

/** Write-capable tools are registered separately so read-only tool lists stay unchanged. */
export function createWriteTools(options: WriteToolOptions): RuntimeToolDefinition[] {
  return [createPgApplicationSubmitTool(options)]
}
