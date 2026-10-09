import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getLiveAnalyticsSummary } from '@/lib/live-analytics'
export const dynamic = 'force-dynamic'
export async function GET(req:NextRequest) {
  const {error}=await requireAdmin(req)
  if(error) return error
  try {
    return NextResponse.json(await getLiveAnalyticsSummary(),{
      headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'},
    })
  } catch {
    return NextResponse.json({error:'Analytics unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}})
  }
}
