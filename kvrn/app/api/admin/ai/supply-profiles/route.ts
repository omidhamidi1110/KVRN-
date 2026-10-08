import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

function intOrNull(v: unknown, min: number, max: number): number | null {
  const n=Number(v); return Number.isInteger(n)&&n>=min&&n<=max?n:null
}

export async function GET(req: NextRequest) {
  const { error }=await requireAdmin(req); if(error)return error
  try {
    const rows=await sql`
      SELECT pv.id::text AS variant_id,p.name AS product_name,pv.sku,pv.color_name,pv.size,pv.active AS variant_active,
             sp.supplier_name,sp.lead_time_days,sp.safety_buffer_days,sp.target_cover_days,sp.moq_units,
             sp.planning_unit_quote_cents,sp.notes,COALESCE(sp.active,FALSE) AS profile_active,sp.updated_at
      FROM product_variants pv JOIN products p ON p.id=pv.product_id
      LEFT JOIN ai_supply_profiles sp ON sp.variant_id=pv.id
      WHERE pv.active=TRUE
      ORDER BY p.name,pv.color_name,pv.size_sort
    `
    return NextResponse.json({profiles:rows})
  } catch { return NextResponse.json({error:'Failed to load supply profiles.'},{status:500}) }
}

export async function PATCH(req: NextRequest) {
  const { identity,error }=await requireAdmin(req); if(error)return error
  let body:any; try{body=await req.json()}catch{return NextResponse.json({error:'Invalid JSON.'},{status:400})}
  const variantId=typeof body?.variantId==='string'?body.variantId:''
  if(!variantId)return NextResponse.json({error:'Variant is required.'},{status:400})
  const lead=intOrNull(body?.leadTimeDays,1,365)
  const buffer=intOrNull(body?.safetyBufferDays,0,180)
  const target=intOrNull(body?.targetCoverDays,7,365)
  const moq=intOrNull(body?.moqUnits,1,100000)
  if(lead===null||buffer===null||target===null||moq===null)return NextResponse.json({error:'Lead time, safety buffer, target cover, and MOQ must be valid whole numbers.'},{status:400})
  if(target<lead)return NextResponse.json({error:'Target cover must be at least the supplier lead time.'},{status:400})
  const quoteRaw=body?.planningUnitQuoteCents
  let quote:number|null=null
  if(quoteRaw!==null&&quoteRaw!==undefined&&quoteRaw!==''){
    const q=Number(quoteRaw)
    if(!Number.isFinite(q)||q<0||q>100_000_000)return NextResponse.json({error:'Planning unit quote must be a valid non-negative cent amount.'},{status:400})
    quote=Math.floor(q)
  }
  const supplier=typeof body?.supplierName==='string'?body.supplierName.trim().slice(0,160):null
  const notes=typeof body?.notes==='string'?body.notes.trim().slice(0,1000):null
  const active=typeof body?.active==='boolean'?body.active:null
  try{
    const rows=await sql`
      WITH changed AS (
        INSERT INTO ai_supply_profiles(variant_id,supplier_name,lead_time_days,safety_buffer_days,target_cover_days,moq_units,planning_unit_quote_cents,notes,active)
        VALUES (${variantId}::uuid,${supplier||null},${lead},${buffer},${target},${moq},${quote},${notes||null},COALESCE(${active}::boolean,TRUE))
        ON CONFLICT (variant_id) DO UPDATE SET supplier_name=EXCLUDED.supplier_name,lead_time_days=EXCLUDED.lead_time_days,
          safety_buffer_days=EXCLUDED.safety_buffer_days,target_cover_days=EXCLUDED.target_cover_days,moq_units=EXCLUDED.moq_units,
          planning_unit_quote_cents=EXCLUDED.planning_unit_quote_cents,notes=EXCLUDED.notes,active=COALESCE(${active}::boolean,ai_supply_profiles.active)
        RETURNING variant_id,supplier_name,lead_time_days,safety_buffer_days,target_cover_days,moq_units,planning_unit_quote_cents,notes,active,updated_at
      ), audited AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${identity.email},'ai_supply_profile_upserted','ai_supply_profile',variant_id::text,${JSON.stringify({supplier,lead,buffer,target,moq,quote,active})}::jsonb FROM changed
        RETURNING 1
      )
      SELECT variant_id::text,supplier_name,lead_time_days,safety_buffer_days,target_cover_days,moq_units,planning_unit_quote_cents,notes,active,updated_at FROM changed
    ` as any[]
    return NextResponse.json({profile:rows[0]})
  }catch{return NextResponse.json({error:'Failed to save supply profile.'},{status:500})}
}
