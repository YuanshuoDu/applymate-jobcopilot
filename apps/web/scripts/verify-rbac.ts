import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const routes = ['queue', 'agents', 'sse', 'usage']
async function main(): Promise<void> {
  for (const route of routes) {
    const path = resolve(process.cwd(), 'src', 'app', 'admin', 'observability', route, 'page.tsx')
    const source = await readFile(path, 'utf8')
    if (!source.includes("requireAdmin('observability.read')")) throw new Error(`${route} is missing the admin authorization guard`)
    if (!source.includes('isAdminResponse')) throw new Error(`${route} does not handle denied admin authorization`)
  }
  console.log(JSON.stringify({ status: 'passed', routes }))
}

void main()
