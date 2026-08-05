import { NextResponse } from 'next/server'

// This endpoint has been retired. Use /api/checkout/session instead.
export function POST() {
  return NextResponse.json(
    { error: 'This checkout endpoint has been retired. Use /api/checkout/session.' },
    { status: 410 }
  )
}

export function GET() {
  return NextResponse.json(
    { error: 'This checkout endpoint has been retired.' },
    { status: 410 }
  )
}
