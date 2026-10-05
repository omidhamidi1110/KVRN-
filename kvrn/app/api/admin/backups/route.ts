// GET  /api/admin/backups — backup / restore-test / DR-drill readiness + bounded history
// POST /api/admin/backups — record metadata for a backup that was made OUTSIDE the app
//
// Admin-only. This route never creates a backup, reads a dump, or contacts Neon: it appends a
// metadata row to admin_audit_logs and reads such rows back. See lib/backup-records.ts.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, parseJsonBody, validateBackupInput } from '@/lib/backup-records'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const dashboard = await createBackupService(sql as any).getDashboard()
    return NextResponse.json(dashboard, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/backups GET]', String(err?.message ?? err).slice(0, 120))
    return NextResponse.json({ error: 'Could not load backup records.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const body = parseJsonBody(await req.text())
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 })
  const v = validateBackupInput(body.value, new Date())
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const { id } = await createBackupService(sql as any).recordBackup(v.value, identity!.email)
    return NextResponse.json({ id, recorded: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/backups POST]', String(err?.message ?? err).slice(0, 120))
    return NextResponse.json({ error: 'Could not record the backup.' }, { status: 500 })
  }
}
