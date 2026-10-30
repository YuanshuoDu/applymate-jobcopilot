export class ApplicationPdfUnsupportedCharactersError extends Error {
  readonly code = 'PDF_UNSUPPORTED_CHARACTERS'
  constructor() {
    super('Some characters cannot be rendered in this PDF. Please review the text and use supported characters.')
    this.name = 'ApplicationPdfUnsupportedCharactersError'
  }
}

export function isApplicationPdfUnsupportedCharactersError(value: unknown): value is ApplicationPdfUnsupportedCharactersError {
  return value instanceof Error && 'code' in value && value.code === 'PDF_UNSUPPORTED_CHARACTERS'
}
