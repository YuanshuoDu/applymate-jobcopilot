import { createHash } from "node:crypto"

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_PARTS = 12
const SLOT_COUNT = 8
const OBJECTIVE_LETTER = "Synthetic corrected cover letter for confirmed engineering role tailor-2."
const OBJECTIVE_LETTER_HASH = createHash("sha256").update(OBJECTIVE_LETTER).digest("hex")

export function objectiveApplicationSlot(pathname) {
  const match = /^\/example-objective\/jobs\/([1-8])$/.exec(pathname)
  return match ? Number(match[1]) : null
}

export function objectiveApplicationPath(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= SLOT_COUNT
    ? `/example-objective/jobs/${slot}` : null
}

export function objectiveApplicationPage(slot) {
  const action = objectiveApplicationPath(slot)
  if (!action) return null
  return `<!doctype html><title>Fixture Application</title><form method="post" enctype="multipart/form-data" action="${action}">
    <label for="first_name">First name</label><input id="first_name" name="first_name">
    <label for="resume">Resume</label><input id="resume" name="resume" type="file" required>
    <label for="cover_letter">Cover letter</label><textarea id="cover_letter" name="cover_letter" required></textarea>
    <button id="submit-app" type="submit">Submit application</button></form>
    <script>
      const traces = new Map();
      window.addEventListener('pagehide', () => { if (traces.size) fetch('/__trace?batch=' + encodeURIComponent(JSON.stringify([...traces.values()])), { method: 'POST', keepalive: true }).catch(() => {}); });
      document.addEventListener('DOMContentLoaded', () => fetch('/__trace?event=dom_ready&elapsedMs=' + Math.round(performance.now()), { method: 'POST', keepalive: true }).catch(() => {}));
      document.querySelectorAll('input,textarea').forEach(field => field.addEventListener('input', async () => {
        const trace = { event: 'input', field: field.name, elapsedMs: Math.round(performance.now()), length: field.value.length };
        if (field.name === 'cover_letter') {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(field.value));
          trace.valueHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
          fetch('/__trace?' + new URLSearchParams(trace), { method: 'POST', keepalive: true }).catch(() => {});
          return;
        }
        traces.set(field.name, trace);
      }));
    </script>`
}

export async function readObjectiveApplicationPost(request, slot) {
  const chunks = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of request) {
      const part = Buffer.from(chunk)
      size += part.length
      if (size > MAX_BODY_BYTES) tooLarge = true
      else if (!tooLarge) chunks.push(part)
    }
  } catch {
    return malformed(slot, "request_read_failed")
  }
  if (tooLarge) return malformed(slot, "request_too_large")
  return inspectObjectiveApplicationMultipart(request.headers?.["content-type"], Buffer.concat(chunks), slot)
}

export function inspectObjectiveApplicationMultipart(contentType, body, slot) {
  if (!objectiveApplicationPath(slot) || !Buffer.isBuffer(body)) return malformed(slot, "scope_invalid")
  if (body.length > MAX_BODY_BYTES) return malformed(slot, "request_too_large")
  const boundary = multipartBoundary(contentType)
  if (!boundary) return malformed(slot, "boundary_invalid")
  const raw = body.toString("latin1")
  const sections = raw.split(`--${boundary}`)
  if (sections.length < 3 || sections[0] !== "" || !/^--\r?\n?$/.test(sections.at(-1) ?? "")) {
    return malformed(slot, "multipart_invalid")
  }
  const parts = sections.slice(1, -1)
  if (parts.length > MAX_PARTS) return malformed(slot, "part_limit")
  const seen = new Map()
  let resume
  let coverLetter
  for (const section of parts) {
    const part = section.replace(/^\r\n/, "").replace(/\r\n$/, "")
    const splitAt = part.indexOf("\r\n\r\n")
    if (splitAt < 1 || splitAt > 8192) return malformed(slot, "part_header_invalid")
    const headers = part.slice(0, splitAt)
    const content = Buffer.from(part.slice(splitAt + 4), "latin1")
    const disposition = /^content-disposition:\s*form-data;\s*name="([a-z_]{1,64})"(?:;\s*filename="[^"]{0,256}")?\s*$/im.exec(headers)
    if (!disposition) return malformed(slot, "disposition_invalid")
    const name = disposition[1]
    seen.set(name, (seen.get(name) ?? 0) + 1)
    if (!["first_name", "resume", "cover_letter"].includes(name)) return malformed(slot, "field_unsupported")
    if (name === "resume") {
      const fileType = /^content-type:\s*application\/pdf\s*$/im.test(headers)
      const pdf = content.length > 5 && content.subarray(0, 5).toString("ascii") === "%PDF-"
      resume = { attached: Boolean(disposition[0].includes("filename=")), pdf, bytes: content.length,
        sha256: content.length ? hash(content) : null, fileType }
    }
    if (name === "cover_letter") {
      const text = content.toString("utf8").trim()
      coverLetter = { present: text.length > 0, chars: text.length, sha256: text ? hash(Buffer.from(text)) : null }
    }
  }
  const exactFields = seen.size === 3 && [...seen.values()].every(count => count === 1)
    && seen.has("first_name") && seen.has("resume") && seen.has("cover_letter")
  const valid = exactFields && resume?.attached && resume.pdf && resume.fileType && coverLetter?.present
  return { slot, valid, code: valid ? "ok" : "fields_or_upload_invalid", resume, coverLetter,
    objectiveLetterMatch: slot === 2 && coverLetter?.sha256 === OBJECTIVE_LETTER_HASH }
}

function multipartBoundary(value) {
  if (typeof value !== "string" || value.length > 160) return null
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,\-./:=?]{1,70})"|([A-Za-z0-9'()+_,\-./:=?]{1,70}))\s*$/i.exec(value)
  return match?.[1] ?? match?.[2] ?? null
}

function malformed(slot, code) {
  return { slot: objectiveApplicationPath(slot) ? slot : null, valid: false, code, resume: null,
    coverLetter: null, objectiveLetterMatch: false }
}

function hash(value) { return createHash("sha256").update(value).digest("hex") }
