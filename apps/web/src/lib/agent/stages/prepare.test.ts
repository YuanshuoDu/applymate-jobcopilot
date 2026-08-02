import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/model-router", () => ({ modelChat: vi.fn(), stripFences: (value: string) => value }))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/persona", () => ({ buildPersona: vi.fn() }))
vi.mock("@/lib/persona-evidence", () => ({ personaEvidenceContext: vi.fn() }))
vi.mock("../role-config", () => ({ roleAiConfig: vi.fn() }))

import { preparationFloor } from "./prepare"

describe("preparationFloor", () => {
  it("uses the configured candidate threshold instead of a hard-coded score", () => {
    expect(preparationFloor(85)).toBe(80)
    expect(preparationFloor(60)).toBe(55)
    expect(preparationFloor(3)).toBe(0)
  })
})
