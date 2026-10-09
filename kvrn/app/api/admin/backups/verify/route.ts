// Record a restore test performed outside the site; never operates on backup bytes.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, LIMITS, parseJsonBody, validateVerificationInput } from '@/lib/backup-records'

export const dynamic = 'force-dynamic'
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  if (!identity) return respond({ error: 'Unauthorized.' }, 401)
  if (Number(req.headers.get('content-length') || 0) > LIMITS.bodyBytes) return respond({ error: 'Invalid input.' }, 400)
  let raw: string
  try { raw = await req.text() } catch { return respond({ error: 'Invalid input.' }, 400) }
  const parsed = parseJsonBody(raw)
  if (!parsed.ok) return respond({ error: 'Invalid input.' }, 400)
  const input = validateVerificationInput(parsed.value, new Date())
  if (!input.ok) return respond({ error: 'Invalid restore-test metadata.' }, 400)
  try {
    const out = await createBackupService(sql).recordVerification(input.value, identity.email)
    return out.ok ? respond(out, 201) : respond({ error: 'Backup not found or test predates it.' }, out.reason === 'not_found' ? 404 : 409)
  } catch { return respond({ error: 'Restore-test record unavailable.' }, 503) }
}
