// POST /api/admin/backups/verify — append a restore-test result for a RECORDED backup
//
// Records that an admin restore-tested a backup somewhere else. It performs no restore and
// touches no database other than appending one audit row.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, parseJsonBody, validateVerificationInput } from '@/lib/backup-records'
import { notifyBackupFailure } from '@/lib/owner-notifications'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const body = parseJsonBody(await req.text())
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 })
  const v = validateVerificationInput(body.value, new Date())
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const r = await createBackupService(sql as any).recordVerification(v.value, identity!.email)
    if (!r.ok) {
      return r.reason === 'not_found'
        ? NextResponse.json({ error: 'No recorded backup has that id.' }, { status: 404 })
        : NextResponse.json({ error: 'verifiedAt cannot be earlier than the backup it verifies.' }, { status: 400 })
    }
    if (v.value.result === 'failed') await notifyBackupFailure('restore_verification')
    return NextResponse.json({ id: r.id, recorded: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/backups/verify POST]', String(err?.message ?? err).slice(0, 120))
    return NextResponse.json({ error: 'Could not record the restore verification.' }, { status: 500 })
  }
}
