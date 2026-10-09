import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {validateAiNotificationSettings} from '@/lib/ai/admin-control-safety'
import { getAiRuntimeSettings, isValidAiBusinessTimezone, updateAiRuntimeSettings } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return NextResponse.json({ settings: await getAiRuntimeSettings() }, { headers: NO_STORE })
}

export async function PATCH(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const parsed=await readAdminMutationJson(req,4096)
  if(!parsed.ok)return NextResponse.json({error:'Invalid or unauthorized JSON request.'},{status:parsed.status,headers:NO_STORE})
  const body=parsed.value as Record<string,unknown>
  if(!validateAiNotificationSettings(body))return NextResponse.json({error:'Invalid AI notification settings.'},{status:400,headers:NO_STORE})
  const hour = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : null
  const limit = Number(body.noncriticalPushLimitDay)
  const timezone = String(body.businessTimezone ?? '').trim()
  // PostgreSQL performs the authoritative business-day/month calculations, so
  // validate against the same timezone catalog instead of trusting a browser/runtime alias.
  if (!(await isValidAiBusinessTimezone(timezone))) {
    return NextResponse.json({ error: 'Invalid timezone.' }, { status: 400, headers: NO_STORE })
  }
  const daily = hour(body.dailyBriefHourLocal)
  const quietStart = hour(body.quietHoursStartLocal)
  const quietEnd = hour(body.quietHoursEndLocal)
  if (daily === null || quietStart === null || quietEnd === null || !Number.isInteger(limit) || limit < 0 || limit > 50) {
    return NextResponse.json({ error: 'Invalid AI notification settings.' }, { status: 400, headers: NO_STORE })
  }
  const settings = await updateAiRuntimeSettings({
    businessTimezone: timezone,
    dailyBriefHourLocal: daily,
    quietHoursEnabled: body.quietHoursEnabled === true,
    quietHoursStartLocal: quietStart,
    quietHoursEndLocal: quietEnd,
    noncriticalPushLimitDay: limit,
    actorEmail: identity!.email,
  })
  return NextResponse.json({ settings }, { headers: NO_STORE })
}
