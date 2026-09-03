'use client'

import React from 'react'
import { HarnessMarkdown } from './v2/HarnessMarkdown'

export function SmartMessage({ text, color }: { text: string; color?: string }) {
  return <HarnessMarkdown markdown={text} style={{ fontSize: 11, color: color ?? 'var(--text)', fontFamily: 'inherit' }} />
}
