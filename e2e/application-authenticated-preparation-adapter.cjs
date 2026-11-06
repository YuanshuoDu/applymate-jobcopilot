// Test-image-only transport. The production source is not modified.
const expectedDb = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
const fakeKey = 'fixture-only-synthetic-model-key'

function requireFixture() {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_PREPARATION_FIXTURE !== 'true'
    || process.env.DATABASE_URL !== expectedDb || process.env.DIRECT_URL !== expectedDb
    || process.env.RLS_RUNTIME_MODE !== 'off' || process.env.MINIMAX_API_KEY !== fakeKey
    || process.env.AUTH_SECRET !== 'fixture-only-secret-at-least-32-bytes') {
    throw new Error('Synthetic model refused outside the isolated fixture')
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)/i.test(key)
      && !(key === 'MINIMAX_API_KEY' && value === fakeKey)) {
      throw new Error('Synthetic model refused an unexpected credential')
    }
  }
}

exports.pinnedFetch = async function pinnedFetch(url, init = {}) {
  requireFixture()
  if (String(url) !== 'https://api.minimax.io/v1/chat/completions' || init.method !== 'POST'
    || init.headers?.Authorization !== `Bearer ${fakeKey}` || typeof init.body !== 'string') {
    throw new Error('Synthetic model refused an unexpected request')
  }
  const body = JSON.parse(init.body)
  const prompt = body.messages?.length === 1 && body.messages[0]?.role === 'user' && body.messages[0]?.content
  if (body.model !== 'MiniMax-M3' || body.stream !== false || typeof prompt !== 'string'
    || !prompt.includes('Fixture application engineer') || !prompt.includes('Fixture Company')
    || !prompt.includes('Synthetic vacancy for isolated preparation and review.')) throw new Error('Synthetic model refused an unexpected prompt')

  let answer
  if (prompt.startsWith('You are an expert ATS resume editor.')) {
    const match = prompt.match(/SECTION: (summary|skills|experience|education|projects|certifications)\nCURRENT SECTION JSON:\n([\s\S]*?)\nTARGET JOB:/)
    if (!match) throw new Error('Synthetic model refused an unexpected tailoring section')
    const value = match[1] === 'summary' ? match[2] : JSON.parse(match[2])
    const expected = { summary: 'Synthetic original summary.', skills: ['TypeScript'], experience: [], education: [], projects: [], certifications: [] }
    if (JSON.stringify(value) !== JSON.stringify(expected[match[1]])) throw new Error('Synthetic model refused unexpected source data')
    answer = { after: value, reason: 'Synthetic fixture: preserve source content.' }
  } else if (prompt.includes('SOURCE RESUME (truth baseline):') && prompt.includes('FINAL RESUME TO AUDIT:')
    && prompt.includes('NO FINAL COVER LETTER SUPPLIED (optional)') && prompt.includes('Synthetic original summary.')) {
    answer = { verdict: 'pass', summary: 'Synthetic model audit; no real provider was called.', matchScore: 80,
      findings: [{ area: 'resume', severity: 'pass', title: 'Synthetic evidence', evidence: 'Fixture source matches.', action: 'None.' }] }
  } else throw new Error('Synthetic model refused an unexpected operation')

  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } })
}
