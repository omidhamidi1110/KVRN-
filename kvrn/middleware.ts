import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Admin route protection — production uses Cloudflare Access at the edge.
// Cloudflare Access performs sign-in before requests reach this application.
// The application's server-side requireAdmin() then verifies the CF-Access-Jwt-Assertion header.
//
// DO NOT redirect /admin/* to /admin/login — there is no login page.
// Redirecting causes "too many redirects" because /admin/login is also matched.
//
// In production:
//   - Cloudflare Access blocks unauthenticated requests before they reach here.
//   - requireAdmin() returns 401/403 for any request that bypasses or lacks a valid JWT.
//
// In local development:
//   - Set DEV_ADMIN_EMAIL in .env.local.
//   - Pass x-dev-admin-email: <email> header to bypass CF Access verification.
//   - This bypass is disabled when NODE_ENV=production (enforced in admin-auth.ts).

export function middleware(_request: NextRequest) {
  // Pass all requests through to the application.
  // Admin API security is enforced server-side via requireAdmin().
  // Admin page security is enforced by Cloudflare Access at the edge.
  return NextResponse.next()
}

export const config = {
  // No middleware matching needed — CF Access handles /admin/* at the edge.
  matcher: [],
}
