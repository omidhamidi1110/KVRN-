// GET /api/analytics/config — PUBLIC runtime configuration for the browser GA4 loader.
//
// WHY THIS EXISTS: KVRN builds locally and the GA measurement id is a Cloudflare RUNTIME variable.
// A NEXT_PUBLIC_* reference in app code is inlined by `next build`, so a build shell without the
// variable would bake "GA off" into the browser bundle while the server (which reads the runtime
// variable per request) believes GA is configured. This route reads the variable at REQUEST time
// from the Worker environment and hands the browser just the public id.
//
// WHAT IT EXPOSES: exactly one value — the validated public measurement id (G-XXXX), or null.
// readPublicGaMeasurementId() can read only that one variable, so this route cannot return the
// Measurement Protocol secret, whether a secret exists, Cloudflare details or any other env value.
//
// WHEN IT IS CALLED: lib/ga-client calls it only after effective analytics consent exists
// (accepted AND no DNT AND no GPC). Before that, no request is made.
//
// The env is passed as a PARAMETER (never a literal `process.env.NEXT_PUBLIC_…` expression, which
// the bundler could inline at build time) — a regression test enforces both.
import { NextResponse } from 'next/server'
import { readPublicGaMeasurementId } from '@/lib/ga-common'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const measurementId = readPublicGaMeasurementId(process.env)
  return NextResponse.json(
    { measurementId },
    { headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' } },
  )
}
