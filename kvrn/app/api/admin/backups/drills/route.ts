// Store only an external disaster-recovery drill record, never run one here.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, LIMITS, parseJsonBody, validateDrillInput } from '@/lib/backup-records'

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
  const input = validateDrillInput(parsed.value, new Date())
  if (!input.ok) return respond({ error: 'Invalid drill metadata.' }, 400)
  try { return respond(await createBackupService(sql).recordDrill(input.value, identity.email), 201) }
  catch { return respond({ error: 'Drill record unavailable.' }, 503) }
}
