/**
 * Post-build script — copies static assets, generates HTML, creates final manifest.
 */
const fs   = require('fs')
const path = require('path')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')

// Guard: Vite calls closeBundle once per entry point.
// We only want to inline on the FIRST call. Detect by checking if background.js
// still starts with ES import statements (not yet inlined → first call).
// After inlining, background.js starts with "const DEFAULTS" → subsequent calls skip.
const bgCheckPath = path.join(DIST, 'background.js')
if (!fs.existsSync(bgCheckPath)) process.exit(0)
const bgFirstLine = fs.readFileSync(bgCheckPath, 'utf-8').split('\n')[0]
if (!bgFirstLine.startsWith('import ')) {
  // Already inlined — skip
  process.exit(0)
}

// Read source manifest
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'))

// Remove old src dir from Vite
const srcDir = path.join(DIST, 'src')
if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true })

// ── Inline background.js (self-contained, no chunk imports) ──
// Read all dependency chunks
const chunkDir = path.join(DIST, 'chunks')
let bgJs = fs.readFileSync(path.join(DIST, 'background.js'), 'utf-8')

// Strip all relative chunk import lines
bgJs = bgJs.replace(/^import [^\n]+ from "\.\/chunks\/[^"]+\.js";\n/gm, '')

// Collect and inline all chunks referenced by background (storage, api, etc.)
const chunksToInline = ['storage', 'api', 'job-identity', 'auth-recovery']
let inlinedChunks = ''
for (const name of chunksToInline) {
  const chunkPath = path.join(chunkDir, `${name}.js`)
  if (fs.existsSync(chunkPath)) {
    let chunk = fs.readFileSync(chunkPath, 'utf-8')
    // Strip inter-chunk import lines
    chunk = chunk.replace(/^import [^\n]+ from "\.\/[^"]+\.js";\n/gm, '')
    // Strip export { ... } blocks (not needed in self-contained SW)
    chunk = chunk.replace(/^export \{[\s\S]*?\};\s*/gm, '')
    inlinedChunks += chunk + '\n'
  }
}

// Prepend chunks, then background code
const finalBg = inlinedChunks + bgJs
fs.writeFileSync(path.join(DIST, 'background.js'), finalBg)

// Vite emits the content entry as a flat script. Chrome executes this file
// declaratively and also manually when the user opens a supported tab. Guard
// same-version reinjection so old observers/listeners cannot accumulate.
const contentPath = path.join(DIST, 'content.js')
if (fs.existsSync(contentPath)) {
  let contentJs = fs.readFileSync(contentPath, 'utf-8')
  // Content scripts are classic scripts, not ES modules. When a utility is
  // shared with background Vite emits it as a chunk, leaving an `import` here
  // that Chrome rejects before any ApplyMate UI can run. Inline it explicitly.
  const jobIdentityPath = path.join(chunkDir, 'job-identity.js')
  if (fs.existsSync(jobIdentityPath)) {
    let jobIdentity = fs.readFileSync(jobIdentityPath, 'utf-8')
    jobIdentity = jobIdentity.replace(/^export \{[\s\S]*?\};\s*/gm, '')
    contentJs = contentJs.replace(/^import [^\n]+ from "\.\/chunks\/job-identity\.js";\n/gm, '')
    contentJs = `${jobIdentity}\n${contentJs}`
  }
  if (/^\s*import\s/m.test(contentJs)) {
    throw new Error('content.js still contains an ES module import after post-build inlining')
  }
  // A reload of an unpacked extension can keep the page's isolated-world
  // globals while replacing chrome.runtime. Give each build a fresh marker so
  // the new script can replace that invalidated context even if the manifest
  // version has not changed.
  const buildMarker = JSON.stringify(`${manifest.version_name || manifest.version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const wrappedContent = `;(() => {\n` +
    `  const existing = globalThis.__applyMateContentRuntime;\n` +
    `  if (existing?.marker === ${buildMarker}) {\n` +
    `    try { if (existing.isAlive?.()) return; } catch {}\n` +
    `  }\n` +
    `  try { existing?.dispose?.(); } catch (error) {\n` +
    `    console.warn('[ApplyMate] Previous content cleanup failed:', error);\n` +
    `  }\n` +
    `  globalThis.__applyMateContentBuild = ${buildMarker};\n` +
    `  try {\n` +
    contentJs.split('\n').map(line => `    ${line}`).join('\n') +
    `  } catch (error) {\n` +
    `    console.error('[ApplyMate] Content script crash:', error);\n` +
    `  }\n` +
    `})();\n`
  fs.writeFileSync(contentPath, wrappedContent)
}

// popup.js and sidepanel.js keep their ESM imports — loaded as type="module"

// ── Update manifest ─────────────────────────────────────────
manifest.background.service_worker = 'background.js'
manifest.content_scripts[0].js      = ['content.js']
manifest.content_scripts[0].css     = ['assets/content/inject.css']
manifest.side_panel                 = { default_path: 'sidepanel.html' }
manifest.action.default_popup       = 'popup.html'

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2))

// ── Copy icons ──────────────────────────────────────────────
const iconDir = path.join(DIST, 'icons')
fs.mkdirSync(iconDir, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const src = path.join(ROOT, 'icons', `icon${size}.png`)
  const dst = path.join(iconDir, `icon${size}.png`)
  if (fs.existsSync(src)) fs.copyFileSync(src, dst)
}

// ── Copy inject.css ─────────────────────────────────────────
const cssDir = path.join(DIST, 'assets', 'content')
fs.mkdirSync(cssDir, { recursive: true })
const cssSrc = path.join(ROOT, 'src', 'content', 'inject.css')
if (fs.existsSync(cssSrc)) fs.copyFileSync(cssSrc, path.join(cssDir, 'inject.css'))

// ── Create popup.html ───────────────────────────────────────
fs.writeFileSync(path.join(DIST, 'popup.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApplyMate AI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { width: 360px; min-width: 360px; margin: 0; padding: 0; overflow: hidden; }
  body { min-height: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f8ff; color: #101a3a; font-size: 13px; }
  body::-webkit-scrollbar { width: 0; height: 0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./popup.js"></script>
</body>
</html>`)

// ── Create sidepanel.html ───────────────────────────────────
fs.writeFileSync(path.join(DIST, 'sidepanel.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApplyMate AI</title>
  <link rel="stylesheet" href="./assets/sidepanel.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: 100%; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fb; color: #1a1a2e; font-size: 13px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./sidepanel.js"></script>
</body>
</html>`)

console.log('✓ Post-build complete (inlined modules)')
