import { NextRequest } from 'next/server'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { ApplicationAudit, CoverLetter, Resume } from '@/lib/types'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }
type StoredAudit = { resumeId: string; coverLetterId: string; audit: ApplicationAudit }
const AUDIT_PREFIX = '[Auditor] application-audit '
const openFile = promisify(execFile)

function safeName(value: string) {
  return (value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().replace(/\s+/g, ' ').slice(0, 100)) || 'Untitled'
}

function parseAudit(text: string): StoredAudit | null {
  if (!text.startsWith(AUDIT_PREFIX)) return null
  try {
    const result = JSON.parse(text.slice(AUDIT_PREFIX.length)) as StoredAudit
    return result.resumeId && result.coverLetterId && result.audit?.verdict ? result : null
  } catch { return null }
}

function versionedPdfName(name: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return name.replace('.pdf', ` - ${stamp}.pdf`)
}

async function writePdf(folderPath: string, fileName: string, pdf: Buffer) {
  try {
    await writeFile(join(folderPath, fileName), pdf)
    return fileName
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
    const fallbackName = versionedPdfName(fileName)
    await writeFile(join(folderPath, fallbackName), pdf)
    return fallbackName
  }
}

async function findTsxLoader() {
  const appRoot = await findWebAppRoot()
  const packageRoot = join(appRoot, '..', '..', 'node_modules', '.pnpm')
  const entry = (await readdir(packageRoot)).find(name => name.startsWith('tsx@'))
  if (!entry) throw new Error('The local TypeScript renderer runtime is unavailable.')
  const loader = join(packageRoot, entry, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  await access(loader)
  return { appRoot, loader }
}

async function findWebAppRoot() {
  const starts = [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '..', '..')]
  for (const start of starts) {
    const candidates = [start, join(start, 'apps', 'web')]
    for (const candidate of candidates) {
      try {
        await access(join(candidate, 'scripts', 'render-application-pack-pdf.tsx'))
        return candidate
      } catch { /* try the next candidate */ }
    }
  }
  throw new Error('Could not locate apps/web/scripts/render-application-pack-pdf.tsx.')
}

async function renderExactApplicationPack(resume: Resume, coverLetter: CoverLetter, job: { company: string; role: string }) {
  const payload = JSON.stringify({ resume, coverLetter, job })
  return new Promise<{ resumePdf: Buffer; coverLetterPdf: Buffer }>((resolve, reject) => {
    void findTsxLoader().then(({ appRoot, loader }) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, join('scripts', 'render-application-pack-pdf.tsx')], { cwd: appRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      const output: Buffer[] = []
      const errors: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
      child.once('error', reject)
      child.once('close', code => {
        if (code !== 0) return reject(new Error(Buffer.concat(errors).toString() || `Application-pack renderer exited with ${code}`))
        try {
          const result = JSON.parse(Buffer.concat(output).toString()) as { resumePdf: string; coverLetterPdf: string }
          resolve({ resumePdf: Buffer.from(result.resumePdf, 'base64'), coverLetterPdf: Buffer.from(result.coverLetterPdf, 'base64') })
        } catch (error) { reject(error) }
      })
      child.stdin.end(payload)
    }).catch(reject)
  })
}


export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const { id: jobId } = await params
  const body = await req.json().catch(() => ({})) as { openFolder?: boolean; openOnly?: boolean }

  const job = await db.job.findFirst({ where: { id: jobId, userId: auth.userId } })
  if (!job?.finalResumeId || !job.finalCoverLetterId) return err('A final resume and matching cover letter are required before export.', 409)
  const auditActivity = await db.activity.findFirst({
    where: { userId: auth.userId, jobId, text: { startsWith: AUDIT_PREFIX } },
    orderBy: { createdAt: 'desc' }, select: { text: true },
  })
  const audit = parseAudit(auditActivity?.text ?? '')
  if (!audit || audit.audit.verdict !== 'pass' || audit.resumeId !== job.finalResumeId || audit.coverLetterId !== job.finalCoverLetterId) {
    return err('The final documents must pass a factual audit before export.', 409)
  }
  const root = process.env.APPLYMATE_LOCAL_EXPORT_ROOT || 'D:\\My Jobs resume'
  const folderPath = join(root, safeName(`${job.company} - ${job.role}`))
  if (body.openOnly) {
    try { await access(folderPath) } catch { return err('The exported job folder no longer exists. Save the PDFs again first.', 404) }
    if (process.platform === 'win32') await openFile('explorer.exe', [folderPath])
    return ok({ folderPath, opened: process.platform === 'win32' })
  }

  const [resume, coverLetter] = await Promise.all([
    db.resume.findFirst({ where: { id: job.finalResumeId, userId: auth.userId } }),
    db.coverLetter.findFirst({ where: { id: job.finalCoverLetterId, jobId, userId: auth.userId } }),
  ])
  if (!resume || !coverLetter) return err('Final application documents could not be found.', 404)

  try {
    const finalResume = resume as unknown as Resume
    const finalCoverLetter = coverLetter as unknown as CoverLetter
    const { resumePdf, coverLetterPdf: coverPdf } = await renderExactApplicationPack(finalResume, finalCoverLetter, { company: job.company, role: job.role })
    await mkdir(folderPath, { recursive: true })
    const [resumeFile, coverLetterFile] = await Promise.all([
      writePdf(folderPath, 'Resume.pdf', resumePdf),
      writePdf(folderPath, 'Cover Letter.pdf', coverPdf),
    ])
    let opened = false
    if (body.openFolder && process.platform === 'win32') {
      await openFile('explorer.exe', [folderPath])
      opened = true
    }
    return ok({ folderPath, opened, resumeFile, coverLetterFile })
  } catch (error) {
    console.error('[/api/jobs/export-local]', error)
    return err(`Could not export PDFs locally: ${(error as Error).message}`, 500)
  }
}
