// Append-only metadata about backups that were created outside the website.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, LIMITS, parseJsonBody, validateBackupInput } from '@/lib/backup-records'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE })

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try { return respond(await createBackupService(sql).getDashboard()) }
  catch { return respond({ error: 'Backup records unavailable.' }, 503) }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  if (!identity) return respond({ error: 'Unauthorized.' }, 401)
  if (Number(req.headers.get('content-length') || 0) > LIMITS.bodyBytes) return respond({ error: 'Invalid input.' }, 400)
  let raw: string
  try { raw = await req.text() } catch { return respond({ error: 'Invalid input.' }, 400) }
  const parsed = parseJsonBody(raw)
  if (!parsed.ok) return respond({ error: 'Invalid input.' }, 400)
  const input = validateBackupInput(parsed.value, new Date())
  if (!input.ok) return respond({ error: 'Invalid backup metadata.' }, 400)
  try { return respond(await createBackupService(sql).recordBackup(input.value, identity.email), 201) }
  catch { return respond({ error: 'Backup record unavailable.' }, 503) }
}
