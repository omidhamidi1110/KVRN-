import { sql } from '@/lib/db'
import { createAiAction, markAiAction } from '../repository'

/**
 * Neutral review-growth eligibility monitor.
 *
 * Safety / integrity rules:
 * - Every otherwise-eligible delivered buyer is treated equally; sentiment is never used.
 * - Open support issues only DEFER outreach; they never permanently remove review access.
 * - This monitor never sends a customer message. The canonical review page/template must be
 *   established after the CMS merge before outbound review requests can be enabled.
 * - ai_review_requests stores only order references, never duplicate customer PII.
 */
export async function handleReviewGrowthMonitor(event: { id: string }): Promise<void> {
  const candidates = await sql`
    SELECT
      o.id AS order_id,
      o.order_number,
      o.updated_at,
      EXISTS (
        SELECT 1 FROM support_threads st
        WHERE st.customer_email IS NOT NULL
          AND o.customer_email IS NOT NULL
          AND lower(st.customer_email)=lower(o.customer_email)
          AND st.status='open'
      ) AS has_open_support
    FROM orders o
    WHERE o.payment_status='paid'
      AND o.fulfillment_status='delivered'
      AND o.customer_email IS NOT NULL
      AND o.updated_at <= NOW() - INTERVAL '2 days'
      AND NOT EXISTS (
        SELECT 1 FROM ai_review_requests rr WHERE rr.order_id=o.id
      )
    ORDER BY o.updated_at ASC
    LIMIT 200
  ` as any[]

  let eligible = 0
  let deferred = 0
  for (const row of candidates) {
    const hasOpenSupport = Boolean(row.has_open_support)
    const status = hasOpenSupport ? 'deferred' : 'eligible'
    const reason = hasOpenSupport ? 'OPEN_SUPPORT_THREAD' : null
    await sql`
      INSERT INTO ai_review_requests(order_id,status,eligible_at,next_attempt_at,deferred_reason)
      VALUES (
        ${String(row.order_id)}::uuid,
        ${status},
        NOW(),
        CASE WHEN ${hasOpenSupport} THEN NOW()+INTERVAL '3 days' ELSE NOW() END,
        ${reason}
      )
      ON CONFLICT (order_id) DO NOTHING
    `
    if (hasOpenSupport) deferred += 1
    else eligible += 1
  }

  // Re-check deferred requests. A resolved support issue makes the customer eligible again;
  // we do not require positive sentiment or a favorable support outcome.
  const released = await sql`
    WITH releasable AS (
      SELECT rr.order_id
      FROM ai_review_requests rr
      JOIN orders o ON o.id=rr.order_id
      WHERE rr.status='deferred'
        AND COALESCE(rr.next_attempt_at,NOW()) <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM support_threads st
          WHERE st.customer_email IS NOT NULL
            AND o.customer_email IS NOT NULL
            AND lower(st.customer_email)=lower(o.customer_email)
            AND st.status='open'
        )
      LIMIT 200
    )
    UPDATE ai_review_requests rr
       SET status='eligible', deferred_reason=NULL, next_attempt_at=NOW()
      FROM releasable r
     WHERE rr.order_id=r.order_id
    RETURNING rr.order_id
  ` as any[]

  const dueRows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status='eligible' AND COALESCE(next_attempt_at,NOW()) <= NOW())::int AS due,
      COUNT(*) FILTER (WHERE status='deferred')::int AS deferred,
      COUNT(*) FILTER (WHERE status='sent')::int AS sent,
      COUNT(*) FILTER (WHERE status='completed')::int AS completed
    FROM ai_review_requests
  ` as any[]
  const due = Number(dueRows[0]?.due ?? 0)

  const actionId = await createAiAction({
    agentId:'lifecycle', eventId:event.id, actionType:'review_growth_monitor',
    summary:'Checked neutral post-purchase review-request eligibility.',
    evidence:{
      newlyEligible:eligible,
      newlyDeferredForOpenSupport:deferred,
      releasedFromDeferral:released.length,
      due,
      totalDeferred:Number(dueRows[0]?.deferred ?? 0),
      sent:Number(dueRows[0]?.sent ?? 0),
      completed:Number(dueRows[0]?.completed ?? 0),
      eligibilityUsesSentiment:false,
      outboundEnabled:false,
    },
    riskLevel:'info', permissionLevel:'green', status:'succeeded', ownerVisible:false,
    idempotencyKey:`review-growth-monitor:${event.id}`,
  })
  await markAiAction({
    actionId, status:'succeeded', completed:true,
    outcome:{
      due,
      outboundSent:false,
      reason:'Review outreach remains disabled until the canonical review endpoint/template exists after merge.',
    },
  })
}
