const assert = require('node:assert/strict')
const { pinnedFetch } = require('./application-authenticated-preparation-adapter.cjs')
const db = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
Object.assign(process.env, { CI: 'true', APPLICATION_AUTH_DISPOSABLE: 'true', APPLICATION_AUTH_PREPARATION_FIXTURE: 'true',
  DATABASE_URL: db, DIRECT_URL: db, RLS_RUNTIME_MODE: 'off', MINIMAX_API_KEY: 'fixture-only-synthetic-model-key',
  AUTH_SECRET: 'fixture-only-secret-at-least-32-bytes' })
const url = 'https://api.minimax.io/v1/chat/completions'
const init = prompt => ({ method: 'POST', headers: { Authorization: 'Bearer fixture-only-synthetic-model-key' },
  body: JSON.stringify({ model: 'MiniMax-M3', stream: false, messages: [{ role: 'user', content: prompt }] }) })
const base = 'TARGET JOB: Fixture application engineer at Fixture Company\nSynthetic vacancy for isolated preparation and review.\nSynthetic original summary.'
const source = { contact: { name: 'Fixture Candidate', email: 'candidate-a@example.invalid', location: 'Dublin' },
  summary: 'Synthetic original summary.', experience: [], education: [], skills: ['TypeScript'], languages: [], projects: [], certifications: [] }
function auditPrompt(sourceResume, finalResume) {
  return `You are an independent application auditor.\n\nSOURCE RESUME (truth baseline):\n${JSON.stringify(sourceResume, null, 2)}\n\nCONFIRMED PERSONA (user-confirmed facts, also valid evidence):\nSynthetic fixture persona\n\nFINAL RESUME TO AUDIT:\n${JSON.stringify(finalResume, null, 2)}\n\n${base}\n\nNO FINAL COVER LETTER SUPPLIED (optional)`
}
// Mirrors the actual non-repair route's prompt assembly, including its
// filter(Boolean): empty entries do not create blank separator lines.
function tailorPrompt(section, value) {
  const before = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [
    'You are an expert ATS resume editor.',
    'Tailor the provided resume section to the target job while preserving truthful candidate facts.',
    'The confirmed Persona is a hard factual boundary. Do not add facts that are unsupported by BOTH the source resume and Persona. If there is any conflict, preserve the source resume.',
    'Use job-description keywords only where they are supported by the resume content or Persona.',
    '', `SECTION: ${section}`, `CURRENT SECTION JSON:\n${before}`, '',
    'TARGET JOB: Fixture application engineer at Fixture Company', '',
    'JOB DESCRIPTION:\nSynthetic vacancy for isolated preparation and review.',
    'CONFIRMED PERSONA:\nSynthetic fixture persona', '', '', '',
    'Return ONLY JSON in this shape:',
    '{"after": <the tailored section value, same JSON type as the current section>, "reason": "brief explanation of the keyword/positioning changes"}',
  ].filter(Boolean).join('\n')
}
async function main() {
  const sections = { summary: 'Synthetic original summary.', skills: ['TypeScript'], experience: [], education: [], projects: [], certifications: [] }
  for (const [section, value] of Object.entries(sections)) {
    const response = await pinnedFetch(url, init(tailorPrompt(section, value)))
    assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content).after, value)
  }
  const audit = await pinnedFetch(url, init(auditPrompt(source, source)))
  assert.equal(JSON.parse((await audit.json()).choices[0].message.content).verdict, 'pass')
  const revised = await pinnedFetch(url, init(auditPrompt(source, { ...source, summary: 'Synthetic original summary',
    sectionOrder: ['summary', 'experience', 'skills', 'education', 'languages'] })))
  assert.equal(JSON.parse((await revised.json()).choices[0].message.content).verdict, 'pass')
  await assert.rejects(pinnedFetch('https://different.invalid/chat/completions', init(base)))
  await assert.rejects(pinnedFetch(url, init('other candidate')))
  await assert.rejects(pinnedFetch(url, init(tailorPrompt('skills', ['invented']))))
  await assert.rejects(pinnedFetch(url, init(auditPrompt(source, { ...source, summary: 'Invented facts' }))))
  await assert.rejects(pinnedFetch(url, init(auditPrompt({ ...source, skills: ['invented'] }, source))))
  process.env.UNEXPECTED_API_KEY = 'must-not-be-accepted'
  await assert.rejects(pinnedFetch(url, init(base)))
  delete process.env.UNEXPECTED_API_KEY
  process.env.APPLICATION_AUTH_DISPOSABLE = 'false'
  await assert.rejects(pinnedFetch(url, init(base)))
  console.log('Synthetic preparation adapter: positive and refusal checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
