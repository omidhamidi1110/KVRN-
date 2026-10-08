import { type NextRequest, NextResponse } from 'next/server'
import { runChiefCycle } from '@/lib/ai/chief'
import { enqueueScheduledAiEvents, processAiEvents } from '@/lib/ai/events'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

function timingSafeEqual(a: string, b: string): boolean {
  let result = a.length === b.length ? 0 : 1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    result |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0)
  }
  return result === 0
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret || (process.env.NODE_ENV === 'production' && secret.trim().length < 32)) return NextResponse.json({ error: 'AI Chief cron is not configured.' }, { status: 503, headers: NO_STORE })

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7), secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  // Keep the Chief gate/daily brief independent from monitor failures. A broken
  // monitor must not prevent owner notifications or the mandatory daily summary.
  const stageErrors: string[] = []
  let events = { processed: 0, failed: 0 }
  let chief: Awaited<ReturnType<typeof runChiefCycle>> | null = null

  try {
    // Paid inference never runs on a timer by itself. The timer only queues/claims actual work;
    // deterministic monitors are $0 and event handlers decide whether inference has earned its cost.
    await enqueueScheduledAiEvents()
  } catch (err: any) {
    stageErrors.push('enqueue')
    console.error('[ai-chief] enqueue failed:', String(err?.message ?? err).slice(0, 100))
  }

  try {
    events = await processAiEvents(10)
  } catch (err: any) {
    stageErrors.push('events')
    console.error('[ai-chief] event processing failed:', String(err?.message ?? err).slice(0, 100))
  }

  try {
    chief = await runChiefCycle()
  } catch (err: any) {
    stageErrors.push('chief')
    console.error('[ai-chief] Chief cycle failed:', String(err?.message ?? err).slice(0, 100))
  }

  if (!chief) {
    return NextResponse.json({ error: 'AI Chief cycle failed.', events, stageErrors }, { status: 500, headers: NO_STORE })
  }
  if (stageErrors.length) {
    return NextResponse.json({ events, ...chief, stageErrors }, { status: 500, headers: NO_STORE })
  }
  return NextResponse.json({ events, ...chief }, { headers: NO_STORE })
}
