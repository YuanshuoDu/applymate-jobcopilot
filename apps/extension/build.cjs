/**
 * Post-build script — copies static assets, generates HTML, creates final manifest.
 */
const fs   = require('fs')
const path = require('path')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')

// Read source manifest
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'))

// Remove old src dir from Vite
const srcDir = path.join(DIST, 'src')
if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true })

// ── Inline background.js ─────────────────────────────────────
// Service workers in MV3 work best with all code in one file
const apiJs   = fs.readFileSync(path.join(DIST, 'chunks/api.js'), 'utf-8')
const bgJs    = fs.readFileSync(path.join(DIST, 'background.js'), 'utf-8')
// Remove the import line and prepend the API code
const inlined = bgJs.replace(/^import .+ from "\.\/chunks\/api\.js";\n/, '') + '\n' + apiJs
fs.writeFileSync(path.join(DIST, 'background.js'), inlined)

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
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApplyMate AI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: 320px; min-height: 420px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fb; color: #1a1a2e; font-size: 13px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./popup.js"></script>
</body>
</html>`)

// ── Create sidepanel.html ───────────────────────────────────
fs.writeFileSync(path.join(DIST, 'sidepanel.html'), `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ApplyMate AI</title>
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
