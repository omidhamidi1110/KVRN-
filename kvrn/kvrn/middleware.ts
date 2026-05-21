import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTE PROTECTION
//
// MVP: Basic token-based protection via query param or cookie.
// Production options (choose one):
//
// Option A (RECOMMENDED): Cloudflare Zero Trust Access
//   - Free for personal projects
//   - Cloudflare Dashboard → Zero Trust → Access → Applications
//   - Protect https://kvrn.com/admin with email-based auth
//   - Zero code changes required — Cloudflare handles it at the edge
//
// Option B: Full auth system (Supabase Auth magic links)
//   - Replace this middleware with proper session validation
//   - See V4 Blueprint Section 8.2 for implementation spec
//
// Current: blocks access unless ADMIN_SECRET cookie is present.
// Set the cookie by visiting /api/admin-login?token=YOUR_SECRET
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'change-this-before-launch'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Only protect /admin routes
  if (pathname.startsWith('/admin')) {
    const adminCookie = request.cookies.get('kvrn_admin')?.value
    const authHeader  = request.headers.get('authorization')

    // Allow if valid cookie is present
    if (adminCookie === ADMIN_SECRET) {
      return NextResponse.next()
    }

    // Allow HTTP Basic auth (for curl / API testing)
    if (authHeader?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString()
        const [, password] = decoded.split(':')
        if (password === ADMIN_SECRET) {
          return NextResponse.next()
        }
      } catch {
        // Invalid base64 — fall through to redirect
      }
    }

    // In production with Cloudflare Access: this never runs (CF handles it)
    // In development: redirect to login with return URL
    const loginUrl = new URL('/admin/login', request.url)
    loginUrl.searchParams.set('return', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*'],
}
