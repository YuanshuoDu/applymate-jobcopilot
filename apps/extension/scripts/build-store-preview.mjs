import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const previewRoot = path.join(extensionRoot, 'store-preview')
const destination = path.resolve(extensionRoot, '../web/public/extension-review/preview.html')
const result = await build({
  configFile: false, root: extensionRoot, plugins: [react()], logLevel: 'warn',
  resolve: { alias: [
    { find: /^@\/lib\/api$/, replacement: path.join(previewRoot, 'api.ts') },
    { find: '@', replacement: path.join(extensionRoot, 'src') },
  ] },
  build: {
    write: false, minify: true, sourcemap: false, cssCodeSplit: false,
    rollupOptions: {
      input: path.join(previewRoot, 'main.tsx'),
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
})
if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected preview build output')
const scripts = result.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n')
const styles = result.output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n')
if (!scripts || !styles) throw new Error('Preview script or styles are missing')
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>ApplyMate — sample component preview</title><style>${styles}</style></head><body><div id="root"></div><script>${scripts.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, html)
console.log(`Built isolated component preview: ${destination} (${Buffer.byteLength(html)} bytes)`)
