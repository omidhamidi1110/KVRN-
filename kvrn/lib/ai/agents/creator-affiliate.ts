import { sql } from '@/lib/db'
import { createAiAction, markAiAction, resolveAiAlertsByDedupePrefix, upsertAiAlert } from '../repository'

export async function handleCreatorAffiliateMonitor(event: { id: string }): Promise<void> {
  const [affiliateRows, prospectRows, programRows] = await Promise.all([
    sql`
      SELECT a.id, a.code, a.status, p.program_status,
             (SELECT COUNT(*)::int FROM affiliate_clicks ac
               WHERE ac.affiliate_id=a.id AND ac.occurred_at >= NOW()-INTERVAL '30 days') AS clicks_30d,
             (SELECT COUNT(DISTINCT oaa.order_id)::int FROM order_affiliate_attributions oaa
               WHERE oaa.affiliate_id=a.id AND oaa.attributed_at >= NOW()-INTERVAL '30 days') AS orders_30d
      FROM affiliates a
      LEFT JOIN affiliate_profiles p ON p.affiliate_id=a.id
      ORDER BY a.code
    `,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('qualified','contact_ready'))::int AS ready,
        COUNT(*) FILTER (WHERE status='contacted' AND next_followup_at IS NOT NULL AND next_followup_at <= NOW() AND NOT do_not_contact)::int AS followup_due,
        COUNT(*) FILTER (WHERE status='replied')::int AS replied,
        COUNT(*) FILTER (WHERE do_not_contact OR status='do_not_contact')::int AS dnc
      FROM ai_creator_prospects
    `,
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM affiliate_applications WHERE status IN ('pending','under_review','needs_info')) AS open_applications,
        (SELECT COUNT(*)::int FROM affiliate_profiles WHERE program_status='onboarding') AS onboarding,
        (SELECT COUNT(*)::int FROM affiliate_profiles WHERE program_status='active') AS active_profiles,
        (SELECT COUNT(*)::int FROM affiliate_profiles WHERE requires_reacceptance AND program_status='active') AS reacceptance_required,
        (SELECT COUNT(*)::int FROM affiliate_profiles
          WHERE program_status='active' AND (kyc_status<>'verified' OR tax_status<>'complete' OR payout_method_status<>'ready')) AS payout_setup_incomplete,
        (SELECT COUNT(*)::int FROM affiliate_email_outbox WHERE status='failed') AS failed_program_emails
    `,
  ]) as any[][]

  const active = affiliateRows.filter((r:any)=>r.status==='active' && (r.program_status == null || r.program_status==='active'))
  const withClicksNoOrders = active.filter((r:any)=>Number(r.clicks_30d ?? 0) >= 20 && Number(r.orders_30d ?? 0) === 0)
  const p = prospectRows[0] ?? {}
  const program = programRows[0] ?? {}
  const failedProgramEmails = Number(program.failed_program_emails ?? 0)

  const actionId = await createAiAction({
    agentId: 'creator_affiliate', eventId: event.id, actionType: 'creator_affiliate_monitor',
    summary: `Reviewed creator outreach plus canonical affiliate application/onboarding/performance health.`,
    evidence: {
      activeAffiliates: active.length,
      affiliatesWith20PlusClicksNoOrders: withClicksNoOrders.length,
      creatorReady: Number(p.ready ?? 0),
      creatorFollowupsDue: Number(p.followup_due ?? 0),
      creatorRepliesAwaitingHandling: Number(p.replied ?? 0),
      doNotContact: Number(p.dnc ?? 0),
      openAffiliateApplications: Number(program.open_applications ?? 0),
      affiliateOnboarding: Number(program.onboarding ?? 0),
      activeAffiliateProfiles: Number(program.active_profiles ?? 0),
      reacceptanceRequired: Number(program.reacceptance_required ?? 0),
      payoutSetupIncomplete: Number(program.payout_setup_incomplete ?? 0),
      failedProgramEmails,
      piiIncluded:false,
    },
    riskLevel: failedProgramEmails > 0 ? 'medium' : 'info', permissionLevel: 'green', status: 'succeeded',
    ownerVisible: Number(p.replied ?? 0) > 0 || Number(program.open_applications ?? 0) > 0 || failedProgramEmails > 0,
    idempotencyKey: `creator-affiliate-monitor:${event.id}`,
  })

  if (failedProgramEmails > 0) {
    await upsertAiAlert({
      sourceAgentId:'creator_affiliate', actionId, severity:'medium', category:'provider_failure',
      title:'Affiliate program emails are failing',
      summary:`${failedProgramEmails} affiliate-program email${failedProgramEmails===1?' is':'s are'} currently failed. Affiliate financial/accounting state is unchanged.`,
      dedupeKey:'creator-affiliate:email-outbox', metadata:{ requiresOwner:false, failedProgramEmails },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'creator_affiliate', prefix:'creator-affiliate:email-outbox', note:'Affiliate program email outbox is healthy again.',
    })
  }

  await markAiAction({ actionId, status: 'succeeded', completed: true, outcome: {
    weakConversionAffiliates: withClicksNoOrders.slice(0,10).map((r:any)=>({ id:r.id, code:r.code, clicks30d:Number(r.clicks_30d), orders30d:Number(r.orders_30d) })),
    openAffiliateApplications:Number(program.open_applications ?? 0),
    outboundSent: false,
    reason: 'Creator outreach remains connection- and permission-gated; canonical affiliate application/portal workflows remain authoritative.',
  } })
}
