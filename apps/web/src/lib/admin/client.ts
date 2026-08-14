export function adminMutationHeaders(options: { json?: boolean } = {}): HeadersInit {
  const headers: Record<string, string> = {
    Origin: window.location.origin,
    'Idempotency-Key': crypto.randomUUID(),
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  return headers
}
