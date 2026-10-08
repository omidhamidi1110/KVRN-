// Admin API for abandoned-checkout recovery: list + summary + settings, save settings, one safe retry.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { abandonedService } from '@/lib/abandoned-checkout-runtime'
import { RetryError } from '@/lib/abandoned-checkout'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const sp = req.nextUrl.searchParams
    const [rows, summary, cfg] = await Promise.all([
      abandonedService.listForAdmin({
        view: sp.get('view') ?? undefined,
        limit: Number(sp.get('limit') ?? 50) || 50,
        offset: Number(sp.get('offset') ?? 0) || 0,
      }),
      abandonedService.summary(30),
      abandonedService.getConfig(),
    ])
    return NextResponse.json({
      success: true,
      data: { rows, summary, config: cfg.config, revision: cfg.revision, readiness: abandonedService.deliveryReadiness() },
    }, { headers: NO_STORE })
  } catch (e: any) {
    console.error('[admin/abandoned] load failed:', String(e?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Failed to load abandoned checkouts.' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const revision = body?.revision
  if (!Number.isInteger(revision) || revision < 0) {
    return NextResponse.json({ error: 'A revision is required.' }, { status: 400 })
  }
  try {
    const r = await abandonedService.saveConfig(body?.config, revision, identity.email)
    if (!r.ok) return NextResponse.json({ error: 'Check the highlighted settings.', errors: r.errors }, { status: 400 })
    return NextResponse.json({ success: true, data: { config: r.config, revision: r.revision } }, { headers: NO_STORE })
  } catch (e: any) {
    if (e?.code === 'stale') {
      return NextResponse.json({ error: 'These settings were changed by someone else. Reload and try again.' }, { status: 409 })
    }
    console.error('[admin/abandoned] save failed:', String(e?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Failed to save settings.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  if (body?.action !== 'retry' || typeof body?.id !== 'string' || !UUID_RE.test(body.id)) {
    return NextResponse.json({ error: 'Unsupported request.' }, { status: 400 })
  }
  try {
    await abandonedService.manualRetry(body.id)
    // Audit: ids and the actor only — no email address, no token, no cart.
    await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
              VALUES (${identity.email}, 'abandoned.retry', 'abandoned_checkouts', ${body.id}, '{}'::jsonb)`
    return NextResponse.json({ success: true }, { headers: NO_STORE })
  } catch (e: any) {
    if (e instanceof RetryError) {
      const status = e.code === 'not_found' ? 404 : 409
      return NextResponse.json({ error: e.message, code: e.code }, { status })
    }
    console.error('[admin/abandoned] retry failed:', String(e?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Retry failed.' }, { status: 500 })
  }
}
