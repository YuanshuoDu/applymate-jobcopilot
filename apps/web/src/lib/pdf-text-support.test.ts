import { describe, expect, it } from 'vitest'
import { assertPdfTextSupported, assertPdfTreeTextSupported, UnsupportedPdfTextError } from './pdf-text-support'

describe('PDF font coverage', () => {
  it('accepts the WinAnsi letters and punctuation used by the bundled standard fonts', () => {
    expect(() => assertPdfTextSupported('Renée Müller — €70,000 • résumé\n“Hello”\tÆ Ø œ Š Ž')).not.toThrow()
  })
  it.each(['张伟', 'Олена', 'Ελένη', 'مرحبا', '🙂', 'e\u0301'])('explicitly rejects unsupported script %s', text => {
    expect(() => assertPdfTextSupported(text)).toThrow(UnsupportedPdfTextError)
    expect(() => assertPdfTextSupported(text)).toThrow('Print view / Save as PDF')
  })
  it('checks rendered descendants without considering other object fields', () => {
    expect(() => assertPdfTreeTextSupported({ props: { hidden: '中文', children: [{ props: { children: 'Visible' } }] } })).not.toThrow()
    expect(() => assertPdfTreeTextSupported({ props: { children: ['Visible', { props: { children: '中文' } }] } })).toThrow(UnsupportedPdfTextError)
  })
})
