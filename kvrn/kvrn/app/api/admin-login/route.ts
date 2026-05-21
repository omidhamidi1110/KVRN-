import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json()
    const secret = process.env.ADMIN_SECRET ?? 'change-this-before-launch'

    if (!password || password !== secret) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
    }

    const response = NextResponse.json({ success: true })

    // Set httpOnly cookie valid for 7 days
    response.cookies.set('kvrn_admin', secret, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   60 * 60 * 24 * 7, // 7 days in seconds
      path:     '/',
    })

    return response
  } catch {
    return NextResponse.json({ error: 'Server error.' }, { status: 500 })
  }
}

export async function DELETE() {
  // Sign out — clear the cookie
  const response = NextResponse.json({ success: true })
  response.cookies.delete('kvrn_admin')
  return response
}
