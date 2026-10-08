// POST /api/affiliate/auth/logout — end THIS session. Allowed for read-only (suspended / terminated) affiliates.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { buildClearCookies, createAffiliateAuthService, isSecureEnv } from '@/lib/affiliate-auth'
import { NO_STORE, requireAffiliate } from '@/lib/affiliate-auth-guard'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req, { allowReadOnly: true })
  if (error) return error
  try { await createAffiliateAuthService(sql).logout(ctx!.sessionId, ctx!.affiliateId) } catch { /* cookies are cleared regardless */ }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE })
  for (const c of buildClearCookies({ secure: isSecureEnv() })) res.headers.append('Set-Cookie', c)
  return res
}
