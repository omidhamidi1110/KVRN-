/** KVRN admin near-live analytics. Read-only, consent-dependent, never PII.
 * Consent-only foreground heartbeats enrich recent session observations.
 * This is never an exact real-time connection list or identified visitor count.
 */
import { sql } from '@/lib/db'

export const LIVE_WINDOW_MINUTES = 5
export const LIVE_REFRESH_SECONDS = 30
export interface LiveAnalyticsSummary {
  asOf: string
  observationWindowMinutes: number
  limitations: string[]
  recentlyObservedSessions: number
  activeConsentingSessions: number
  cartSessions: number
  checkoutSessions: number
  productViewSessions: number
  purchasesLast30Minutes: number
  grossPaidTodayCents: number | null
  ordersPaidToday: number
  devices: { device: string; sessions: number }[]
  products: { name: string; views: number }[]
  sources: { source: string; sessions: number }[]
  purchaserRegions90d: { region: string; paidOrders: number }[]
  /** Same consenting session, actual event ordering, all stages in this window.
   * Not an all-traffic conversion rate; window edges and blocked analytics undercount.
   */
  observedSequentialFunnel30m: {
    viewedProductSessions:number
    thenAddedToCartSessions:number
    thenStartedCheckoutSessions:number
    thenPurchasedSessions:number
  }
  observedFunnel30m: {
    sessionsWithEvents:number
    productViewSessions:number
    addToCartSessions:number
    checkoutStartSessions:number
    authoritativePurchaseEvents:number
  }
}
const safeCount = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v)>=0 ? Number(v) : 0
/** Money must not silently become $0 if PostgreSQL returns corrupt/unsafe data. */
export function safeGrossCents(value:unknown):number|null{
  if(value===null||value===undefined)return null
  if(typeof value==='string' && !/^(0|[1-9][0-9]*)$/.test(value))return null
  const n=Number(value)
  return Number.isSafeInteger(n)&&n>=0?n:null
}
/** Refuse to reflect arbitrary visitor-supplied UTM strings containing email/
 * phone-like tokens, URLs or control characters into the Admin Live View. */
export function coarseCampaignLabel(value:unknown):string{
  const s=typeof value==='string'?value.trim():''
  if(!s)return 'Direct / unknown'
  if(s.length>40||/[@\/\\?&#:\r\n\t]/.test(s)||/\d{7,}/.test(s)||!/^[a-zA-Z0-9 _.-]+$/.test(s))return 'Other / withheld'
  return s
}
export async function getLiveAnalyticsSummary(): Promise<LiveAnalyticsSummary> {
  // Only touch new split-tender tables after explicit staging activation.
  // A paid order with a hold but no verified capture proof is UNKNOWN, never $0.
  const todayQuery = () => process.env.STORE_CREDIT_SPLIT_TENDER_ENABLED === 'true'
    ? sql`SELECT COUNT(*)::int AS orders,
        CASE WHEN COUNT(*) FILTER(WHERE h.reservation_id IS NOT NULL AND (
          p.id IS NULL OR p.cash_received_cents<>o.total_cents::bigint
          OR p.cash_received_cents+p.credit_captured_cents<>p.gross_order_cents
        ))>0 THEN NULL
        ELSE COALESCE(SUM(CASE WHEN h.reservation_id IS NULL THEN o.total_cents::bigint
          ELSE p.gross_order_cents END),0)::bigint END AS gross
        FROM orders o LEFT JOIN store_credit_checkout_holds h ON h.reservation_id=o.reservation_id
        LEFT JOIN store_credit_checkout_capture_proofs p ON p.order_id=o.id AND p.reservation_id=o.reservation_id
        WHERE o.paid_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'
          AND o.paid_at < (date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') + INTERVAL '1 day') AT TIME ZONE 'America/Los_Angeles'`
    : sql`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_cents),0)::bigint AS gross
        FROM orders WHERE paid_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'
          AND paid_at < (date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') + INTERVAL '1 day') AT TIME ZONE 'America/Los_Angeles'`
  const [counts, today, devices, products, sources, active, funnel, sequential, purchasers] = await Promise.all([
    sql`
      SELECT COUNT(DISTINCT session_id) FILTER (WHERE created_at > NOW() - INTERVAL '5 minutes')::int AS recent,
             COUNT(DISTINCT session_id) FILTER (WHERE event_name='product_viewed' AND created_at > NOW() - INTERVAL '5 minutes')::int AS products,
             COUNT(DISTINCT session_id) FILTER (WHERE event_name='add_to_cart' AND created_at > NOW() - INTERVAL '5 minutes')::int AS carts,
             COUNT(DISTINCT session_id) FILTER (WHERE event_name='checkout_started' AND created_at > NOW() - INTERVAL '5 minutes')::int AS checkouts,
             COUNT(DISTINCT order_id) FILTER (WHERE event_name='purchase_completed' AND created_at > NOW() - INTERVAL '30 minutes')::int AS purchases
      FROM analytics_events WHERE created_at > NOW() - INTERVAL '30 minutes'
    `,
    todayQuery(),
    sql`
      SELECT COALESCE(s.device_type,'unknown') AS device, COUNT(DISTINCT e.session_id)::int AS sessions
      FROM analytics_events e LEFT JOIN analytics_sessions s ON s.session_id=e.session_id
      WHERE e.created_at > NOW() - INTERVAL '5 minutes'
      GROUP BY 1 ORDER BY sessions DESC LIMIT 4
    `,
    sql`
      SELECT COALESCE(p.name,'Unavailable product') AS name, COUNT(*)::int AS views
      FROM analytics_events e LEFT JOIN products p ON p.id=e.product_id
      WHERE e.event_name='product_viewed' AND e.created_at > NOW() - INTERVAL '30 minutes'
      GROUP BY p.id,p.name ORDER BY views DESC LIMIT 8
    `,
    sql`
      SELECT COALESCE(NULLIF(LEFT(s.first_touch_utm->>'source',40),''),'Direct / unknown') AS source,
             COUNT(DISTINCT e.session_id)::int AS sessions
      FROM analytics_events e JOIN analytics_sessions s ON s.session_id=e.session_id
      WHERE e.created_at > NOW() - INTERVAL '30 minutes'
      GROUP BY 1 ORDER BY sessions DESC LIMIT 8
    `,
    sql`SELECT COUNT(*)::int AS n FROM analytics_sessions
        WHERE last_seen_at>NOW()-INTERVAL '90 seconds'
          AND first_seen_at>NOW()-INTERVAL '24 hours'`,
    sql`SELECT COUNT(DISTINCT session_id)::int AS session_events,
       COUNT(DISTINCT session_id) FILTER (WHERE event_name='product_viewed')::int AS product_views,
       COUNT(DISTINCT session_id) FILTER (WHERE event_name='add_to_cart')::int AS add_to_cart,
       COUNT(DISTINCT session_id) FILTER (WHERE event_name='checkout_started')::int AS checkout_starts,
       COUNT(DISTINCT order_id) FILTER (WHERE event_name='purchase_completed' AND order_id IS NOT NULL)::int AS purchases
       FROM analytics_events WHERE created_at>NOW()-INTERVAL '30 minutes'`,
    // Unlike independent stage counts, these counts use a single session and
    // timestamps in the correct sequence. Include purchases only from the
    // server's order-linked purchase_completed events.
    sql`WITH
      viewed AS (
        SELECT session_id, MIN(created_at) AS at
        FROM analytics_events WHERE event_name='product_viewed'
          AND session_id IS NOT NULL AND created_at>NOW()-INTERVAL '30 minutes'
        GROUP BY session_id
      ),
      carted AS (
        SELECT v.session_id,MIN(e.created_at) AS at FROM viewed v
        JOIN analytics_events e ON e.session_id=v.session_id
          AND e.event_name='add_to_cart' AND e.created_at>=v.at
          AND e.created_at>NOW()-INTERVAL '30 minutes'
        GROUP BY v.session_id
      ),
      checked_out AS (
        SELECT c.session_id,MIN(e.created_at) AS at FROM carted c
        JOIN analytics_events e ON e.session_id=c.session_id
          AND e.event_name='checkout_started' AND e.created_at>=c.at
          AND e.created_at>NOW()-INTERVAL '30 minutes'
        GROUP BY c.session_id
      ),
      purchased AS (
        SELECT c.session_id FROM checked_out c
        JOIN analytics_events e ON e.session_id=c.session_id
          AND e.event_name='purchase_completed' AND e.order_id IS NOT NULL
          AND e.created_at>=c.at AND e.created_at>NOW()-INTERVAL '30 minutes'
        GROUP BY c.session_id
      )
      SELECT (SELECT COUNT(*)::text FROM viewed) AS viewed,
             (SELECT COUNT(*)::text FROM carted) AS carted,
             (SELECT COUNT(*)::text FROM checked_out) AS checked_out,
             (SELECT COUNT(*)::text FROM purchased) AS purchased`,
    sql`WITH destinations AS (
      SELECT CASE
        WHEN UPPER(TRIM(shipping_address->>'country')) ~ '^[A-Z]{2}$'
        THEN UPPER(TRIM(shipping_address->>'country'))
        ELSE 'Unknown' END AS country,
        CASE WHEN UPPER(TRIM(shipping_address->>'state')) ~ '^[A-Z]{2}$'
        THEN UPPER(TRIM(shipping_address->>'state')) ELSE NULL END AS state
      FROM orders WHERE paid_at >= NOW() - INTERVAL '90 days' AND paid_at IS NOT NULL
    )
    SELECT CASE WHEN country='US' AND state IS NOT NULL THEN 'US · '||state
                ELSE country END AS region, COUNT(*)::int AS paid_orders
    FROM destinations GROUP BY 1 ORDER BY paid_orders DESC, region ASC LIMIT 10`,
  ])
  const a=counts[0] as Record<string, unknown> | undefined
  const b=today[0] as Record<string, unknown> | undefined
  const f=funnel[0] as Record<string, unknown> | undefined
  const seq=sequential[0] as Record<string,unknown>|undefined
  return {
    asOf:new Date().toISOString(), observationWindowMinutes: LIVE_WINDOW_MINUTES,
    limitations:[
      'Presence represents consented tabs seen within 90 seconds, not guaranteed active people or authenticated connections.',
      'Analytics includes only consenting sessions. Some browsers and blockers are excluded.',
      'Today uses America/Los_Angeles business time. Gross paid includes verified cash plus captured store credit where applicable, before refunds and expenses.',
      'No IP addresses, exact locations, customer details, or browser identifiers are returned.',
      'Purchaser regions use PAID orders in the last 90 days, grouped by shipping country and (for US orders) state. They are not live visitors or attributed marketing sources.',
      'The original funnel stages are independent unique-event counts, not a proven step-by-step conversion cohort.',
      'Sequential funnel counts are a same-session cohort, but require all stages to occur in the 30-minute window; truncated journeys and nonconsenting customers are excluded.',
      'Visitor-provided UTM labels with identifiers or malformed content are withheld.',
    ],
    recentlyObservedSessions:safeCount(a?.recent),activeConsentingSessions:safeCount(active[0]?.n),productViewSessions:safeCount(a?.products),
    cartSessions:safeCount(a?.carts),checkoutSessions:safeCount(a?.checkouts),
    purchasesLast30Minutes:safeCount(a?.purchases),grossPaidTodayCents:safeGrossCents(b?.gross),ordersPaidToday:safeCount(b?.orders),
    devices:devices.map(r=>({device:String(r.device),sessions:safeCount(r.sessions)})),
    products:products.map(r=>({name:String(r.name).slice(0,100),views:safeCount(r.views)})),
    purchaserRegions90d:purchasers.map(r=>({region:String(r.region),paidOrders:safeCount(r.paid_orders)})),
    sources:sources.map(r=>({source:coarseCampaignLabel(r.source),sessions:safeCount(r.sessions)})),
    observedSequentialFunnel30m:{viewedProductSessions:safeCount(seq?.viewed),
      thenAddedToCartSessions:safeCount(seq?.carted),thenStartedCheckoutSessions:safeCount(seq?.checked_out),
      thenPurchasedSessions:safeCount(seq?.purchased)},
    observedFunnel30m:{sessionsWithEvents:safeCount(f?.session_events),productViewSessions:safeCount(f?.product_views),
      addToCartSessions:safeCount(f?.add_to_cart),checkoutStartSessions:safeCount(f?.checkout_starts),
      authoritativePurchaseEvents:safeCount(f?.purchases)},
  }
}
