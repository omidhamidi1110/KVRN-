// Stock-alert storage and email delivery have not been built. Never tell a
// shopper that an alert was saved when there is no persistent record.
// Do not log customer emails or create a false marketing-consent record.
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST() {
  return NextResponse.json({
    success: false,
    error: 'Restock notifications are not available yet. Please check back later.',
  }, { status: 503, headers: NO_STORE })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405, headers: NO_STORE })
}
