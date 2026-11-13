/** Canonicalizes one source-reported job location for exact matching. */
export function normalizeAgentLocation(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
  return normalized || null
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

/** Validates and canonicalizes the bounded, user-entered location allowlist. */
export function normalizeAgentLocationAllowlist(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 8) return null
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))) return null
    const locations = new Set<string>()
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      const normalized = normalizeAgentLocation(descriptor.value)
      if (!normalized || utf8ByteLength(normalized) > 128) return null
      locations.add(normalized)
    }
    return Object.freeze([...locations].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
  } catch {
    return null
  }
}
