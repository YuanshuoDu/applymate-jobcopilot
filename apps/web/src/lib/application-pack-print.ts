import type { CoverLetter, Job, Resume, ResumeContent } from './types'

const DEFAULT_ORDER = ['summary', 'experience', 'projects', 'skills', 'certifications', 'education', 'languages']
function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
function paragraph(value: unknown, className = ''): string {
  return value ? `<p${className ? ` class="${className}"` : ''}>${escape(value)}</p>` : ''
}
function item(title: string, period?: string, subtitle?: string, bullets?: string[], url?: string): string {
  return `<div class="item"><h3>${escape(title)}</h3>${paragraph(period, 'muted')}${paragraph(subtitle)}${paragraph(url)}${bullets?.length ? `<ul>${bullets.map(text => `<li>${escape(text)}</li>`).join('')}</ul>` : ''}</div>`
}
function section(title: string, body: string): string {
  return body ? `<section><h2>${escape(title)}</h2>${body}</section>` : ''
}
function resumeHtml(content: ResumeContent): string {
  const contact = content.contact
  const header = `<header><h1>${escape(contact?.name || 'Resume')}</h1>${paragraph([
    contact?.email, contact?.phone, contact?.location, contact?.linkedin, contact?.github, contact?.website,
  ].filter(Boolean).join(' · '))}</header>`
  const sections = new Map<string, string>([
    ['summary', section('Summary', paragraph(content.summary))],
    ['experience', section('Experience', (content.experience ?? []).map(row => item([row.role, row.company].filter(Boolean).join(' — '), row.period, undefined, row.bullets)).join(''))],
    ['projects', section('Projects', (content.projects ?? []).map(row => item([row.name, row.role].filter(Boolean).join(' — '), row.period, undefined, row.bullets, row.url)).join(''))],
    ['certifications', section('Certifications', (content.certifications ?? []).map(row => item(row.name, row.date, row.issuer, undefined, row.url)).join(''))],
    ['education', section('Education', (content.education ?? []).map(row => item(row.degree, row.year, row.institution)).join(''))],
    ['skills', section('Skills', paragraph((content.skills ?? []).join(' · ')))],
    ['languages', section('Languages', (content.languages ?? []).map(row => paragraph(`${row.lang}: ${row.level}`)).join(''))],
  ])
  for (const custom of content.custom ?? []) {
    sections.set(custom.id, section(custom.title, custom.items.map(row => item(row.title ?? '', row.period, row.subtitle, row.bullets)).join('')))
  }
  const order = content.sectionOrder ?? DEFAULT_ORDER
  const customIds = (content.custom ?? []).map(row => row.id).filter(id => !order.includes(id))
  return header + [...new Set([...order, ...customIds])].map(id => sections.get(id) ?? '').join('')
}

/** A private, script-free print alternative for scripts not covered by PDF fonts. */
export function renderApplicationPackPrintHtml(
  job: Pick<Job, 'company' | 'role'>,
  resume: Resume,
  coverLetter: CoverLetter | null,
): string {
  const contact = resume.content.contact
  const letter = coverLetter ? `<article class="letter"><header><h1>${escape(contact?.name || resume.name)}</h1>${paragraph([
    contact?.email, contact?.phone, contact?.location, contact?.linkedin,
  ].filter(Boolean).join(' · '))}</header>${paragraph(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}
    <h2>${escape(job.company)}</h2>${paragraph(job.role)}<div class="letter-body">${escape(coverLetter.content)}</div></article>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>ApplyMate — Application pack print view</title><style>
    @page{size:A4;margin:18mm}*{box-sizing:border-box}body{font:11pt/1.5 Arial,"Segoe UI",sans-serif;color:#17202a;background:#eef2f6;margin:0;padding:24px}article{max-width:780px;margin:20px auto;background:white;padding:40px;overflow-wrap:anywhere}header{border-bottom:2px solid #185fa5;padding-bottom:10px}h1{font-size:22pt;margin:0}h2{font-size:13pt;color:#185fa5;margin:20px 0 6px;break-after:avoid}h3{font-size:11pt;margin:10px 0 0;break-after:avoid}p{margin:4px 0;white-space:pre-wrap}.muted{color:#555}ul{margin:4px 0;padding-left:20px}li{white-space:pre-wrap}header p{font-size:9pt}.letter-body{white-space:pre-wrap;margin-top:24px}.instructions{max-width:780px;margin:auto;padding:16px;background:#dbeafe;border-radius:8px}.letter{break-before:page}@media print{body{background:white;padding:0}.instructions{display:none}article{max-width:none;margin:0;padding:0}}
    </style></head><body><aside class="instructions"><strong>Print / Save as PDF</strong><p>These are the current audited documents. Review every page and check that all characters display correctly. Use your browser’s Print command (Ctrl+P or Command+P), choose Save as PDF, and turn off browser headers and footers. The view uses fonts available on your device.</p><p>打印 / 另存为 PDF：请先检查所有文字，再按 Ctrl+P 或 Command+P，选择“另存为 PDF”，关闭浏览器页眉和页脚。</p></aside>
    <article>${resumeHtml(resume.content)}</article>${letter}</body></html>`
}
