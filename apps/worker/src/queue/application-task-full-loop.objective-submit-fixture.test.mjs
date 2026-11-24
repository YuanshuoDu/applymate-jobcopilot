import assert from "node:assert/strict"
import test from "node:test"
import {
  inspectObjectiveApplicationMultipart,
  objectiveApplicationPage,
  objectiveApplicationPath,
  objectiveApplicationSlot,
  readObjectiveApplicationPost,
} from "./application-task-full-loop.objective-submit-fixture.mjs"

const boundary = "fixture-boundary-123"
const letter = "Synthetic corrected cover letter for confirmed engineering role tailor-2."
const pdf = Buffer.from("%PDF-1.7\nsynthetic resume bytes\n%%EOF", "ascii")

function multipart(parts) {
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}\r\n`, "ascii"))
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, "ascii"))
    chunks.push(Buffer.from("\r\n", "ascii"), Buffer.from(part.value), Buffer.from("\r\n", "ascii"))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"))
  return Buffer.concat(chunks)
}

function validParts() {
  return [
    { name: "first_name", value: "Synthetic" },
    { name: "resume", filename: "resume.pdf", contentType: "application/pdf", value: pdf },
    { name: "cover_letter", value: letter },
  ]
}

test("synthetic Objective receiver serves eight distinct multipart pages", () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => objectiveApplicationPath(index + 1)),
    Array.from({ length: 8 }, (_, index) => `/example-objective/jobs/${index + 1}`))
  assert.equal(objectiveApplicationSlot("/example-objective/jobs/8"), 8)
  assert.equal(objectiveApplicationSlot("/example-objective/jobs/9"), null)
  assert.equal(objectiveApplicationSlot("/example-reviewed/jobs/1"), null)
  assert.ok(objectiveApplicationPage(2).includes('<form method="post" enctype="multipart/form-data" action="/example-objective/jobs/2">'))
  assert.ok(objectiveApplicationPage(2).includes('<input id="resume" name="resume" type="file" required>'))
  assert.equal(objectiveApplicationPage(0), null)
})

test("well-formed multipart receipts expose only bounded metadata", () => {
  const receipt = inspectObjectiveApplicationMultipart(`multipart/form-data; boundary=${boundary}`, multipart(validParts()), 2)
  assert.equal(receipt.slot, 2)
  assert.equal(receipt.valid, true)
  assert.equal(receipt.code, "ok")
  assert.equal(receipt.objectiveLetterMatch, true)
  assert.equal(receipt.resume.attached, true)
  assert.equal(receipt.resume.pdf, true)
  assert.equal(receipt.resume.fileType, true)
  assert.equal(receipt.resume.bytes, pdf.length)
  assert.match(receipt.resume.sha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.coverLetter.present, true)
  assert.equal(receipt.coverLetter.chars, letter.length)
  assert.match(receipt.coverLetter.sha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(receipt).includes(letter), false)
  assert.equal(JSON.stringify(receipt).includes("resume.pdf"), false)
  assert.equal(Object.hasOwn(receipt.resume, "content"), false)
  assert.equal(Object.hasOwn(receipt.coverLetter, "value"), false)
})

test("malformed, duplicate, unsupported, and non-PDF uploads fail closed", () => {
  const parts = validParts()
  const inspect = value => inspectObjectiveApplicationMultipart(`multipart/form-data; boundary=${boundary}`, value, 1)
  assert.equal(inspectObjectiveApplicationMultipart("text/plain", multipart(parts), 1).code, "boundary_invalid")
  assert.equal(inspect(multipart(parts.filter(part => part.name !== "resume"))).code, "fields_or_upload_invalid")
  assert.equal(inspect(multipart([...parts, { name: "resume", filename: "second.pdf", contentType: "application/pdf", value: pdf }])).code,
    "fields_or_upload_invalid")
  assert.equal(inspect(multipart(parts.map(part => part.name === "resume" ? { ...part, value: "not a pdf" } : part))).code,
    "fields_or_upload_invalid")
  assert.equal(inspect(multipart([...parts, { name: "private_answer", value: "not accepted" }])).code, "field_unsupported")
})

test("streamed bodies are bounded and parsed without retaining raw payloads", async () => {
  const body = multipart(validParts())
  const request = {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    async *[Symbol.asyncIterator]() { yield body.subarray(0, 20); yield body.subarray(20) },
  }
  assert.equal((await readObjectiveApplicationPost(request, 3)).valid, true)
  assert.deepEqual(inspectObjectiveApplicationMultipart(`multipart/form-data; boundary=${boundary}`,
    Buffer.alloc(4 * 1024 * 1024 + 1), 3), {
    slot: 3, valid: false, code: "request_too_large", resume: null, coverLetter: null, objectiveLetterMatch: false,
  })
})
