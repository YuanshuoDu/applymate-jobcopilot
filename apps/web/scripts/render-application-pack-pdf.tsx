/*
 * Local-only PDF renderer. It deliberately runs outside Next's Route Handler
 * bundle so React's Node renderer can turn the same Application Pack preview
 * components into HTML before Chrome prints them.
 */
import React from 'react'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import puppeteer from 'puppeteer'
import { ResumeRenderer } from '@/components/resume/ResumeRenderer'
import { CoverLetterPreview } from '@/components/coverletter/CoverLetterPanel'
import type { CoverLetter, Job, Resume } from '@/lib/types'

type Payload = { resume: Resume; coverLetter: CoverLetter; job: Pick<Job, 'company' | 'role'> }

function html(body: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    :root { --primary: #185FA5; } html, body { margin: 0; background: #fff; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    .application-document { width: 210mm; min-height: 297mm; margin: 0; overflow: visible; }
    @page { size: A4; margin: 0; }
  </style></head><body><main class="application-document">${body}</main></body></html>`
}

function chromePath() {
  const candidates = [
    process.env.APPLYMATE_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate))
}

async function renderPage(browser: Awaited<ReturnType<typeof puppeteer.launch>>, markup: string) {
  const page = await browser.newPage()
  try {
    await page.setContent(markup, { waitUntil: 'networkidle0' })
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }))
  } finally {
    await page.close()
  }
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const payload = JSON.parse(Buffer.concat(chunks).toString()) as Payload
  const chrome = chromePath()
  if (!chrome) throw new Error('Chrome was not found for local application-pack export.')
  const contact = payload.resume.content.contact
  const resumeMarkup = html(renderToStaticMarkup(React.createElement(ResumeRenderer, {
    content: payload.resume.content, templateId: payload.resume.templateId, templateOptions: payload.resume.templateOptions,
  })), 'Resume')
  const coverMarkup = html(renderToStaticMarkup(React.createElement(CoverLetterPreview, {
    content: payload.coverLetter.content, applicant: contact, fallbackName: payload.resume.name,
    company: payload.job.company, role: payload.job.role,
    templateId: payload.resume.templateId ?? payload.coverLetter.templateId ?? 'clean',
    templateOptions: payload.resume.templateOptions ?? payload.coverLetter.templateOptions ?? {},
  })), 'Cover letter')
  const browser = await puppeteer.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] })
  try {
    const [resumePdf, coverLetterPdf] = await Promise.all([renderPage(browser, resumeMarkup), renderPage(browser, coverMarkup)])
    process.stdout.write(JSON.stringify({ resumePdf: resumePdf.toString('base64'), coverLetterPdf: coverLetterPdf.toString('base64') }))
  } finally {
    await browser.close()
  }
}

main().catch(error => { process.stderr.write((error as Error).stack ?? String(error)); process.exitCode = 1 })
