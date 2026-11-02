// The built-in Helvetica/Times/Courier fonts use WinAnsi, not a Unicode font.
// Reject unsupported glyphs instead of silently exporting corrupted documents.
const EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')

export class UnsupportedPdfTextError extends Error {
  constructor() {
    super('The PDF fonts cannot represent every character in these documents. Use Print view / Save as PDF and check the preview before saving.')
    this.name = 'UnsupportedPdfTextError'
  }
}

export function assertPdfTextSupported(text: string): void {
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (character === '\n' || character === '\r' || character === '\t'
      || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || EXTRA.has(character)) continue
    throw new UnsupportedPdfTextError()
  }
}

/** Check only text in the rendered tree; intentionally hidden sections stay hidden. */
export function assertPdfTreeTextSupported(node: unknown): void {
  if (typeof node === 'string') assertPdfTextSupported(node)
  else if (Array.isArray(node)) node.forEach(assertPdfTreeTextSupported)
  else if (node && typeof node === 'object' && 'props' in node) {
    const props = node.props as { children?: unknown }
    assertPdfTreeTextSupported(props.children)
  }
}
