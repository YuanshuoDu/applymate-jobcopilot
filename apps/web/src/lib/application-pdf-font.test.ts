import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { Font, renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { CoverLetterDoc } from '@/components/resume/templates/cover-letter/CoverLetterFrame'
import { renderCoverLetterDoc } from './cover-letter-pdf'
import { renderResumeDoc } from './resume-pdf'
import { APPLICATION_PDF_CMAP } from './application-pdf-coverage'
import { assertApplicationPdfTextSupported, isApplicationPdfCharacterSupported, registerApplicationPdfFonts } from './application-pdf-font'
import { isApplicationPdfUnsupportedCharactersError } from './application-pdf-errors'
import type { Resume } from './types'

// Legacy PDF.js misreads Node Buffers under Node 20. Feed it a plain, exact
// Uint8Array in an isolated process; parsing errors still fail without retry.
async function pdfText(doc: React.ReactElement): Promise<string> {
  const bytes = await renderToBuffer(doc as never)
  const parser = createRequire(resolve('package.json')).resolve('pdf-parse')
  const script = `const fs=require('node:fs');const parse=require(process.argv[1]);const raw=fs.readFileSync(0);const exact=Uint8Array.from(raw);parse(exact,{version:'v2.0.550'}).then(result=>process.stdout.write(result.text)).catch(error=>{console.error(error);process.exitCode=1})`
  return execFileSync(process.execPath, ['-e', script, parser], { input: bytes, encoding: 'utf8' })
}

const multilingual = '测试姓名 多语言经历 — Résumé Łódź Česko Ελληνικά Україна'
const resume = {
  name: 'Fixture', templateId: 'clean', templateOptions: { fontFamily: 'serif' },
  content: { contact: { name: multilingual }, summary: multilingual },
} as Resume

describe('offline multilingual PDF fonts', () => {
  it('accepts covered characters and rejects missing glyphs and controls', () => {
    expect(() => assertApplicationPdfTextSupported([multilingual])).not.toThrow()
    for (const unsupported of ['😀', '𠀀', '\u00ad', '\u0080', '\r', '\t', '\u0301', '\u200d', '\ufffc', '\ufffd']) {
      expect(isApplicationPdfCharacterSupported(unsupported)).toBe(false)
      try { assertApplicationPdfTextSupported([`fixture ${unsupported}`]); throw new Error('expected rejection') }
      catch (error) { expect(isApplicationPdfUnsupportedCharactersError(error)).toBe(true) }
    }
  })

  it('binds the generated coverage data to the shipped font files and their actual cmaps', async () => {
    const hashes = [
      ['NotoSans-Regular.ttf', 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'],
      ['NotoSansSC-GB2312-Regular.ttf', '059a7bac57f3eaf9ff02147a47ace9499b6950cd8c05d83a9d6bee53d924c04e'],
    ]
    for (const [filename, hash] of hashes) {
      expect(createHash('sha256').update(readFileSync(resolve('public/fonts', filename))).digest('hex')).toBe(hash)
    }
    registerApplicationPdfFonts()
    const actual = new Set<number>()
    for (const fontFamily of ['ApplyMateNotoSans', 'ApplyMateNotoSC']) {
      await Font.load({ fontFamily })
      const font = Font.getFont({ fontFamily }).data
      expect(font).not.toBeNull()
      for (const code of font!.characterSet) actual.add(code)
    }
    // fontkit includes the U+FFFF noncharacter sentinel in characterSet.
    actual.delete(0xffff)
    const generated = new Set<number>()
    for (const part of APPLICATION_PDF_CMAP.split(',')) {
      const [start, end = start] = part.split('-').map(hex => parseInt(hex, 16))
      for (let code = start; code <= end; code++) generated.add(code)
    }
    expect([...generated].sort((a, b) => a - b)).toEqual([...actual].sort((a, b) => a - b))
  })

  it('renders resume and cover-letter PDF text in multiple scripts', async () => {
    const docs = [await renderResumeDoc(resume), await renderCoverLetterDoc(multilingual, 'clean', {}, { name: multilingual }, { company: 'Łódź', role: '工程师' })]
    for (const doc of docs) {
      const text = await pdfText(doc)
      for (const word of ['测试姓名', '多语言经历', 'Résumé', 'Łódź', 'Česko', 'Ελληνικά', 'Україна']) expect(text).toContain(word)
    }
  }, 30000)

  it('normalizes common pasted text in the rendered PDFs', async () => {
    const input = 'Cafe\u0301\r\nfirst\tsecond\u00a0third\rfourth'
    const docs = [await renderResumeDoc({ ...resume, content: { ...resume.content, summary: input } }), await renderCoverLetterDoc(input, 'clean', {}, { name: 'Jane 测试' })]
    for (const doc of docs) {
      const text = await pdfText(doc)
      expect(text).toContain('Café')
      for (const word of ['first', 'second', 'third', 'fourth']) expect(text).toContain(word)
      expect(text).not.toMatch(/[\r\t\u00a0\u0301]/u)
    }
  }, 30000)

  it('preserves the saved cover-letter closing without adding a second one', async () => {
    const doc = await renderCoverLetterDoc('Dear hiring team,\nThank you.\nSincerely,\nJane Doe', 'clean', {}, { name: 'Jane Doe' })
    const text = await pdfText(doc)
    expect(text.match(/Sincerely,/g)).toHaveLength(1)
    expect(text.match(/Jane Doe/g)).toHaveLength(2) // header plus saved body
  }, 30000)

  it('rejects unsupported text before either document renders, including hidden resume sections only when visible', async () => {
    await expect(renderResumeDoc({ ...resume, content: { ...resume.content, summary: '😀' } })).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_CHARACTERS' })
    await expect(renderResumeDoc({ ...resume, content: { ...resume.content, summary: '😀', sectionOrder: [] } })).resolves.toBeDefined()
    await expect(renderCoverLetterDoc('plain', 'clean', {}, { name: 'Jane' }, { company: '𠀀', role: 'Developer' })).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_CHARACTERS' })
    expect(() => CoverLetterDoc({ content: 'safe', applicant: { name: 'Jane' }, recipient: { company: '😀', role: 'role' }, templateVariant: 'modern' })).toThrowError(/cannot be rendered/)
    expect(React.isValidElement(CoverLetterDoc({ content: 'safe', applicant: { name: 'Jane' }, templateVariant: 'modern' }))).toBe(true)
  })
})
