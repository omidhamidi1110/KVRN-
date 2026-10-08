// GET /api/admin/affiliates/settings — program settings + application readiness.
// PUT /api/admin/affiliates/settings — save settings (optimistic revision; audited as settings.update).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { SettingsStaleError } from '@/lib/site-settings'
import {
  getProgramSettings, saveProgramSettings, validateProgramSettingsInput, getApplicationReadiness,
} from '@/lib/affiliate-program'
import { programErrorResponse, readJsonBody, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [{ settings, revision }, readiness] = await Promise.all([getProgramSettings(sql), getApplicationReadiness(sql)])
    return NextResponse.json({ settings, revision, readiness }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/settings GET')
  }
}

export async function PUT(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const body = await readJsonBody(req)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  const v = validateProgramSettingsInput(body.settings)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE })
  const revision = Number(body.revision)
  if (!Number.isInteger(revision) || revision < 0) return NextResponse.json({ error: 'Reload the page and try again.' }, { status: 400, headers: NO_STORE })
  try {
    const saved = await saveProgramSettings(sql, v.value, revision, identity!.email)
    return NextResponse.json({ ok: true, revision: saved.revision, settings: v.value }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof SettingsStaleError) {
      return NextResponse.json({ error: 'Someone else changed these settings. Reload and try again.' }, { status: 409, headers: NO_STORE })
    }
    return programErrorResponse(err, 'admin/affiliates/settings PUT')
  }
}
