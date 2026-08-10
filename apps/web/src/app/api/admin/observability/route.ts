import { NextResponse } from 'next/server'

// Intentionally retired: operational metrics are now served only by /api/admin/v1.
export function GET() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
