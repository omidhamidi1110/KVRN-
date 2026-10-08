import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const AUTONOMY = new Set(['shadow','approval','limited','trusted'])

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const rows = await sql`
      SELECT ag.id, ag.name, ag.department, ag.description, ag.enabled, ag.autonomy_level, ag.model_role,
             ag.last_heartbeat_at, ag.config, ag.updated_at,
             CASE
               WHEN NOT ag.enabled THEN 'disabled'
               WHEN EXISTS (SELECT 1 FROM ai_events e WHERE e.source_agent_id=ag.id AND e.status='processing' AND e.available_at > NOW()) THEN 'active'
               WHEN EXISTS (SELECT 1 FROM ai_actions a WHERE a.agent_id=ag.id AND a.status='pending_approval') THEN 'waiting'
               WHEN EXISTS (SELECT 1 FROM ai_events e WHERE e.source_agent_id=ag.id AND e.status='discarded' AND e.processed_at >= NOW()-INTERVAL '24 hours') THEN 'error'
               ELSE 'idle'
             END AS status
      FROM ai_agents ag ORDER BY ag.department, ag.name
    `
    return NextResponse.json({ agents: rows })
  } catch { return NextResponse.json({ error: 'Failed to load agents.' }, { status: 500 }) }
}

export async function PATCH(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }) }
  const id = typeof body?.id === 'string' ? body.id : ''
  const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null
  const autonomy = typeof body?.autonomyLevel === 'string' && AUTONOMY.has(body.autonomyLevel) ? body.autonomyLevel : null
  if (!id || (enabled === null && autonomy === null)) return NextResponse.json({ error: 'No valid change.' }, { status: 400 })

  try {
    const rows = await sql`
      WITH changed AS (
        UPDATE ai_agents SET
          enabled=COALESCE(${enabled}, enabled),
          status=CASE
            WHEN ${enabled}::boolean IS FALSE THEN 'disabled'
            WHEN ${enabled}::boolean IS TRUE AND status='disabled' THEN 'idle'
            ELSE status
          END,
          autonomy_level=COALESCE(${autonomy}, autonomy_level),
          updated_by=${identity.email}
        WHERE id=${id}
        RETURNING id, name, enabled, autonomy_level, status
      ), audited AS (
        INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
        SELECT ${identity.email}, 'ai_agent_settings_changed', 'ai_agent', id,
               ${JSON.stringify({ enabled, autonomyLevel: autonomy })}::jsonb
        FROM changed
        RETURNING 1
      )
      SELECT id, name, enabled, autonomy_level, status FROM changed
    ` as any[]
    if (!rows[0]) return NextResponse.json({ error: 'Agent not found.' }, { status: 404 })
    return NextResponse.json({ agent: rows[0] })
  } catch { return NextResponse.json({ error: 'Failed to update agent.' }, { status: 500 }) }
}
