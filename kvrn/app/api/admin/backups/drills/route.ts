// POST /api/admin/backups/drills — append a disaster-recovery drill that was run OUTSIDE the app
//
// Records the fact and the outcome only. It executes no recovery step.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createBackupService, parseJsonBody, validateDrillInput } from '@/lib/backup-records'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const body = parseJsonBody(await req.text())
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 })
  const v = validateDrillInput(body.value, new Date())
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const { id } = await createBackupService(sql as any).recordDrill(v.value, identity!.email)
    return NextResponse.json({ id, recorded: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    console.error('[admin/backups/drills POST]', String(err?.message ?? err).slice(0, 120))
    return NextResponse.json({ error: 'Could not record the drill.' }, { status: 500 })
  }
}
