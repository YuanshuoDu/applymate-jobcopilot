import { test as nodeTest } from "node:test"

export type ScriptedTestBody = () => void | Promise<void>

export async function registerScriptedTest(name: string, body: ScriptedTestBody): Promise<void> {
  if (process.env.VITEST === "true") {
    const { it } = await import("vitest")
    it(name, body)
    return
  }
  nodeTest(name, body)
}
