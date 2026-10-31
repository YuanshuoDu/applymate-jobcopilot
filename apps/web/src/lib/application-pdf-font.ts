import React from 'react'
import { Font } from '@react-pdf/renderer'
import { APPLICATION_PDF_CMAP } from './application-pdf-coverage'
import { ApplicationPdfUnsupportedCharactersError } from './application-pdf-errors'

const families = ['ApplyMateNotoSans', 'ApplyMateNotoSC']
let registered = false
const ranges = APPLICATION_PDF_CMAP.split(',').map(part => {
  const [start, end = start] = part.split('-')
  return [parseInt(start, 16), parseInt(end, 16)] as const
})

/** Font coverage is generated from the actual bundled TTF cmap, not a script range. */
export function isApplicationPdfCharacterSupported(character: string): boolean {
  if (character === '\n') return true
  const code = character.codePointAt(0)
  if (code === undefined || Array.from(character).length !== 1 || code < 0x20 ||
      code >= 0x7f && code <= 0x9f || code === 0xa0 || code === 0xad || code === 0xfffc || code === 0xfffd || /[\p{M}\p{Cf}]/u.test(character)) return false
  let low = 0, high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const [start, end] = ranges[mid]
    if (code < start) high = mid - 1
    else if (code > end) low = mid + 1
    else return true
  }
  return false
}

export function assertApplicationPdfTextSupported(values: readonly (string | undefined | null)[]): void {
  for (const value of values) {
    if (value && Array.from(value).some(character => !isApplicationPdfCharacterSupported(character))) {
      throw new ApplicationPdfUnsupportedCharactersError()
    }
  }
}

/** Normalize the text that will actually be rendered; never mutate stored materials. */
export function normalizeApplicationPdfText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\u00a0/g, ' ').normalize('NFC')
}

export function normalizeApplicationPdfTree(node: React.ReactNode): React.ReactNode {
  if (typeof node === 'string') return normalizeApplicationPdfText(node)
  if (Array.isArray(node)) return React.Children.map(node, normalizeApplicationPdfTree)
  if (React.isValidElement<{ children?: React.ReactNode }>(node) && node.props.children !== undefined) {
    return React.cloneElement(node, { children: normalizeApplicationPdfTree(node.props.children) })
  }
  return node
}

/** Check only text present in the actual React PDF tree, including headings. */
export function assertApplicationPdfTreeSupported(node: React.ReactNode): void {
  if (typeof node === 'string' || typeof node === 'number') {
    assertApplicationPdfTextSupported([String(node)])
  } else if (Array.isArray(node)) {
    node.forEach(assertApplicationPdfTreeSupported)
  } else if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    assertApplicationPdfTreeSupported(node.props.children)
  }
}

export function registerApplicationPdfFonts(): void {
  if (registered) return
  // PDFs run in the browser. The local path is also used by Node rendering tests.
  const cwd = typeof window === 'undefined' ? process.cwd().replace(/\\/g, '/') : ''
  const root = cwd && !cwd.endsWith('/apps/web') ? `${cwd}/apps/web` : cwd
  Font.register({ family: families[0], src: `${root}/fonts/NotoSans-Regular.ttf`.replace('/apps/web/fonts/', '/apps/web/public/fonts/') })
  Font.register({ family: families[1], src: `${root}/fonts/NotoSansSC-GB2312-Regular.ttf`.replace('/apps/web/fonts/', '/apps/web/public/fonts/') })
  registered = true
}

/** Keep the existing Latin template face, with offline glyph fallbacks. */
export function applicationPdfFontFamily(base: string): string[] {
  return [base, ...families]
}
