// GET /api/affiliate/payouts/{ref}/statement[?format=csv] — line-by-line explanation of ONE of my payouts.
// {ref} is the non-reversible payout reference; it is resolved only together with the session's affiliate id, so
// another affiliate's reference (or a raw UUID) is indistinguishable from "does not exist".
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAffiliate, jsonError, NO_STORE } from '@/lib/affiliate-auth-guard'
import { createAffiliatePortalService } from '@/lib/affiliate-portal'
import { buildStatement, statementToCsv } from '@/lib/affiliate-payout-statements'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ctx, error } = await requireAffiliate(req, { allowReadOnly: true })
  if (error) return error
  const { ref } = await params
  try {
    const own = await createAffiliatePortalService(sql).findOwnPayoutByRef(ctx!.affiliateId, String(ref ?? ''))
    if (!own) return jsonError(404, 'Statement not found.')
    const st = await buildStatement(sql, own.id, 'affiliate')
    if (!st) return jsonError(404, 'Statement not found.')
    await sql`INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
              VALUES (${ctx!.affiliateId}::uuid, 'statement_downloaded', ${JSON.stringify({ payoutRef: st.payoutRef })}::jsonb)`.catch(() => {})
    if (req.nextUrl.searchParams.get('format') === 'csv') {
      return new NextResponse(statementToCsv(st), {
        headers: {
          ...NO_STORE,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="kvrn-payout-${st.payoutRef ?? 'statement'}.csv"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    return portalJson({ statement: st })
  } catch (err: any) {
    console.error('[affiliate/statement]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load the statement.')
  }
}
