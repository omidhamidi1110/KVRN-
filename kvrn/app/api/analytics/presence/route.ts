/** First-party active-session heartbeat. Consent checked in browser; minimal UUID input.
 * This is a best-effort signal, never evidence of identified visitors or geolocation.
 * UPDATE is throttled in Postgres without storing request metadata or PII.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isLikelyBot } from '@/lib/funnel-analytics'
import { readLimitedJson } from '@/lib/limited-json-request'
export const dynamic = 'force-dynamic'
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const noContent = () => new NextResponse(null, {status:204,headers:{'Cache-Control':'no-store'}})
export async function POST(req:NextRequest) {
  const origin=req.headers.get('origin')
  if (!origin) return new NextResponse(null,{status:403})
  try {
    const o=new URL(origin)
    const actual=req.nextUrl.host
    if ((o.protocol!=='https:' && o.hostname!=='localhost') || o.host!==actual)
      return new NextResponse(null,{status:403})
  } catch {return new NextResponse(null,{status:403})}
  if (isLikelyBot(req.headers.get('user-agent'))) return noContent()
  if (!(req.headers.get('content-type')||'').startsWith('application/json')) return new NextResponse(null,{status:415})
  // Reject oversized chunked bodies while reading, not after buffering them.
  const read=await readLimitedJson(req,128)
  if(!read.ok)return new NextResponse(null,{status:read.status})
  const value=read.value as Record<string,unknown>|null
  if(!value || Object.keys(value).length!==1 || typeof value.sid!=='string' || !SID.test(value.sid))return new NextResponse(null,{status:400})
  try {
    await sql`UPDATE analytics_sessions SET last_seen_at=NOW()
      WHERE session_id=${value.sid} AND first_seen_at>NOW()-INTERVAL '24 hours'
        AND last_seen_at<NOW()-INTERVAL '45 seconds'`
    return noContent()
  }catch{return new NextResponse(null,{status:503})}
}
