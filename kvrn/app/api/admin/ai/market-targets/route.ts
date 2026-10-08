import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { validatePublicResearchUrl } from '@/lib/ai/integrations/web-research'

export const dynamic = 'force-dynamic'
const TYPES = new Set(['competitor','product','marketplace','category','creator'])

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0,160) : ''
}
function cleanMarketplace(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().slice(0,80) : ''
  return s || null
}
function priority(v: unknown): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 3
}
function strictPriority(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
}

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const rows = await sql`
      SELECT t.id::text,t.name,t.target_type,t.canonical_url,t.marketplace,t.active,t.priority,t.notes,t.updated_at,
        MAX(o.observed_at) AS last_observed_at,
        COUNT(o.id)::int AS observation_count
      FROM ai_market_targets t LEFT JOIN ai_market_observations o ON o.target_id=t.id
      GROUP BY t.id ORDER BY t.active DESC,t.priority ASC,t.name
    `
    return NextResponse.json({ targets: rows })
  } catch { return NextResponse.json({ error:'Failed to load market targets.' }, { status:500 }) }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body:any
  try { body=await req.json() } catch { return NextResponse.json({error:'Invalid JSON.'},{status:400}) }
  const name=cleanName(body?.name)
  const targetType=typeof body?.targetType==='string' && TYPES.has(body.targetType) ? body.targetType : 'competitor'
  const rawUrl=typeof body?.canonicalUrl==='string' ? body.canonicalUrl.trim() : ''
  if (!name || !rawUrl) return NextResponse.json({error:'Name and public HTTPS URL are required.'},{status:400})
  let canonicalUrl:string
  try { canonicalUrl=validatePublicResearchUrl(rawUrl).toString() } catch (e:any) { return NextResponse.json({error:String(e?.message||'Invalid research URL.')},{status:400}) }
  try {
    const rows=await sql`
      WITH created AS (
        INSERT INTO ai_market_targets(name,target_type,canonical_url,marketplace,priority,notes,active)
        VALUES (${name},${targetType},${canonicalUrl},${cleanMarketplace(body?.marketplace)},${priority(body?.priority)},${typeof body?.notes==='string'?body.notes.trim().slice(0,1000):null},TRUE)
        RETURNING id,name,target_type,canonical_url,marketplace,active,priority,notes,updated_at
      ), audited AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${identity.email},'ai_market_target_created','ai_market_target',id::text,${JSON.stringify({name,targetType,canonicalUrl})}::jsonb FROM created
        RETURNING 1
      )
      SELECT id::text,name,target_type,canonical_url,marketplace,active,priority,notes,updated_at FROM created
    ` as any[]
    return NextResponse.json({target:rows[0]},{status:201})
  } catch (e:any) {
    console.error('[admin-ai] create market target failed:',String(e?.message||e).slice(0,100))
    return NextResponse.json({error:'Failed to create market target.'},{status:500})
  }
}

export async function PATCH(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body:any
  try { body=await req.json() } catch { return NextResponse.json({error:'Invalid JSON.'},{status:400}) }
  const id=typeof body?.id==='string' ? body.id : ''
  if (!id) return NextResponse.json({error:'Target id is required.'},{status:400})
  const active=typeof body?.active==='boolean' ? body.active : null
  const p=body?.priority===undefined ? null : strictPriority(body.priority)
  if (body?.priority!==undefined && p===null) return NextResponse.json({error:'Priority must be a whole number from 1 to 5.'},{status:400})
  const name=body?.name===undefined ? null : cleanName(body.name)
  if (body?.name!==undefined && !name) return NextResponse.json({error:'Name cannot be empty.'},{status:400})
  let canonicalUrl:string|null=null
  if (body?.canonicalUrl!==undefined) {
    try { canonicalUrl=validatePublicResearchUrl(String(body.canonicalUrl||'')).toString() } catch (e:any) { return NextResponse.json({error:String(e?.message||'Invalid research URL.')},{status:400}) }
  }
  if (active===null && p===null && name===null && canonicalUrl===null) return NextResponse.json({error:'No valid change.'},{status:400})
  try {
    const rows=await sql`
      WITH changed AS (
        UPDATE ai_market_targets SET
          active=COALESCE(${active}::boolean,active), priority=COALESCE(${p}::smallint,priority),
          name=COALESCE(${name},name), canonical_url=COALESCE(${canonicalUrl},canonical_url)
        WHERE id=${id}::uuid
        RETURNING id,name,target_type,canonical_url,marketplace,active,priority,notes,updated_at
      ), audited AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${identity.email},'ai_market_target_changed','ai_market_target',id::text,${JSON.stringify({active,priority:p,name,canonicalUrl})}::jsonb FROM changed
        RETURNING 1
      )
      SELECT id::text,name,target_type,canonical_url,marketplace,active,priority,notes,updated_at FROM changed
    ` as any[]
    if (!rows[0]) return NextResponse.json({error:'Target not found.'},{status:404})
    return NextResponse.json({target:rows[0]})
  } catch { return NextResponse.json({error:'Failed to update market target.'},{status:500}) }
}
