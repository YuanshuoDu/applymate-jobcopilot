import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { captureEvidenceArray, captureEvidenceJson, captureEvidenceRecord, stableAnswerEvidenceJson } from "./final-answer-evidence-json.js"

describe("final answer evidence JSON capture", () => {
  it("uses one descriptor snapshot for structure and normalized UTF-8 byte checks", () => {
    let descriptorReads = 0
    const proxy = new Proxy({ label: "safe excerpt" }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key !== "label" || !descriptor) return descriptor
        descriptorReads += 1
        return { ...descriptor, value: descriptorReads === 1 ? "safe excerpt" : "x".repeat(100) }
      },
    })
    const captured = captureEvidenceJson(proxy)
    expect(captured).toEqual({ label: "safe excerpt" })
    expect(descriptorReads).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(captured), "utf8")).toBe(Buffer.byteLength('{"label":"safe excerpt"}', "utf8"))
  })

  it("rejects accessors, non-enumerable fields, proxy traps, and custom record prototypes", () => {
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "unsafe" })
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: "hidden" })
    const throwing = new Proxy({}, { ownKeys() { throw new Error("trap") } })
    expect(captureEvidenceRecord(accessor)).toBeNull()
    expect(captureEvidenceRecord(hidden)).toBeNull()
    expect(captureEvidenceJson(throwing)).toBeNull()
    expect(captureEvidenceRecord(Object.create({ inherited: true }))).toBeNull()
  })

  it("accepts only dense native arrays without extra keys or overridden array methods", () => {
    const dense = ["one", "two"]
    const sparse = ["one", , "three"]
    const overridden = ["one"]
    Object.defineProperty(overridden, "every", { value: () => true })
    class CustomArray extends Array<string> {}
    expect(captureEvidenceArray(dense)).toEqual(dense)
    expect(captureEvidenceArray(sparse)).toBeNull()
    expect(captureEvidenceArray(overridden)).toBeNull()
    expect(captureEvidenceArray(new CustomArray("one"))).toBeNull()
  })

  it("measures the captured UTF-8 JSON and produces stable model-request serialization", () => {
    const value = { z: "🙂", a: [1, "é"] }
    const encoded = JSON.stringify({ z: "🙂", a: [1, "é"] })
    expect(captureEvidenceJson(value, Buffer.byteLength(encoded, "utf8") - 1)).toBeNull()
    expect(captureEvidenceJson(value, Buffer.byteLength(encoded, "utf8"))).toEqual(value)
    expect(stableAnswerEvidenceJson(value)).toBe('{"a":[1,"é"],"z":"🙂"}')
  })
})
