import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const release = join(root, 'release')
const manifestPath = join(dist, 'manifest.json')

if (!existsSync(manifestPath)) {
  throw new Error('dist/manifest.json is missing. Run pnpm build first.')
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const output = join(release, `ApplyMate-AI-${manifest.version}.zip`)
mkdirSync(release, { recursive: true })
rmSync(output, { force: true })

if (process.platform === 'win32') {
  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const safeOutput = output.replaceAll("'", "''")
  execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path * -DestinationPath '${safeOutput}' -Force`,
  ], { cwd: dist, stdio: 'inherit' })
} else {
  execFileSync('zip', ['-q', '-r', output, '.'], { cwd: dist, stdio: 'inherit' })
}

console.log(`Created ${output}`)
