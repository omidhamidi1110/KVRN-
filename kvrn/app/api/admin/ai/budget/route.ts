import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getAiBudgetSnapshot } from '@/lib/ai/budget'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try { return NextResponse.json({ budget: await getAiBudgetSnapshot() }, { headers: NO_STORE }) }
  catch { return NextResponse.json({ error: 'Failed to load AI budget.' }, { status: 500, headers: NO_STORE }) }
}

/** Owner can manually lock/unlock AI. Dollar thresholds remain code/migration controlled. */
export async function PATCH(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400, headers: NO_STORE }) }
  if (typeof body?.manuallyLocked !== 'boolean') return NextResponse.json({ error: 'manuallyLocked must be boolean.' }, { status: 400, headers: NO_STORE })
  try {
    // Lock state and its audit record move atomically; a crash cannot create an
    // unaudited unlock or an audit entry for a change that never committed.
    await sql`
      WITH changed AS (
        INSERT INTO ai_budget_controls(id, manually_locked, updated_by)
        VALUES ('global', ${body.manuallyLocked}, ${identity.email})
        ON CONFLICT (id) DO UPDATE SET
          manually_locked=EXCLUDED.manually_locked,
          updated_by=EXCLUDED.updated_by
        RETURNING id
      )
      INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
      SELECT ${identity.email}, 'ai_budget_lock_changed', 'ai_budget', id,
             ${JSON.stringify({ manuallyLocked: body.manuallyLocked })}::jsonb
      FROM changed
    `
    return NextResponse.json({ budget: await getAiBudgetSnapshot() }, { headers: NO_STORE })
  } catch { return NextResponse.json({ error: 'Failed to update AI budget.' }, { status: 500, headers: NO_STORE }) }
}
