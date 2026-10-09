/** Static offline release guard: does not require provider secrets or contact data. */
import {readFileSync,existsSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
const cwd=process.cwd(), read=p=>readFileSync(resolve(cwd,p),'utf8')
const checks=[
  ['Product preview preserves selected viewport width',()=>{const s=read('app/admin/products/[id]/PreviewPane.tsx');assert.match(s,/mode === 'mobile' \? mobileWidth : desktopWidth/);assert.match(s,/frameGeometry\(\{ mode, paneWidth: paneSize\.w, paneHeight: paneSize\.h, deviceWidth \}\)/);assert.match(s,/width: g\.frameWidth/);assert.match(s,/transform: `scale\(\$\{g\.scale\}\)`/);assert.match(s,/overflow-hidden/)}],
  ['Public email history append-only and unsub cannot self-reactivate',()=>{assert.match(read('lib/marketing-subscribers.ts'),/marketing_email_consent_events/);assert.match(read('lib/marketing-subscribers.ts'),/status = marketing_subscribers.status/);assert.match(read('db/migrations/044_marketing_email_consent_events.sql'),/APPEND_ONLY/)}],
  ['Admin marketing writes require bounded same-origin JSON',()=>{assert.match(read('app/api/admin/marketing/campaigns/route.ts'),/readAdminMutationJson/);assert.match(read('lib/admin-mutation-safety.ts'),/sec-fetch-site/)}],
  ['Public unsubscribe requires signed token and POST',()=>{const s=read('app/api/marketing/unsubscribe/route.ts');assert.match(s,/verifyMarketingUnsubscribe/);assert.match(s,/revokeMarketingSubscriberById/);assert.match(read('lib/marketing-subscribers.ts'),/status='unsubscribed'/);assert.match(s,/export async function POST/);assert.match(s,/status:405/);assert.match(s,/readLimitedText\(req,1024\)/)}],
  ['Marketing one-click unsubscribe verifies signature, writes suppression only on POST',()=>{const s=read('app/api/marketing/one-click-unsubscribe/route.ts');assert.match(s,/verifyMarketingUnsubscribe/);assert.match(s,/revokeMarketingSubscriberById/);assert.match(s,/readLimitedText\(req,128\)/);assert.match(s,/export async function GET\(\)\{return reply\(405\)\}/);assert.match(read('lib/marketing-provider-one-shot-adapters.ts'),/List-Unsubscribe-Post/)}],
  ['Legacy unsub never accepts bare email or mutates on GET',()=>{const s=read('app/api/unsubscribe/route.ts');assert.match(s,/verifyMarketingUnsubscribe/);assert.match(s,/revokeMarketingSubscriberById/);assert.doesNotMatch(s,/console\.log/);assert.doesNotMatch(s,/searchParams\.get\('email'\)/)}],
  ['Public waitlist requires explicit email consent',()=>{for(const p of ['app/api/waitlist/route.ts','app/api/marketing/subscribe/route.ts']){assert.match(read(p),/validatePublicEmailConsent/);assert.doesNotMatch(read(p),/syncSubscribeToResend/)}}],
  ['Public email forms show consent checkbox',()=>{for(const p of ['components/homepage/WaitlistBlock.tsx','components/forms/WaitlistForm.tsx']){assert.match(read(p),/emailMarketingConsent/);assert.match(read(p),/type="checkbox"/)}}],
  ['Cron Resend sync requires explicit flag',()=>assert.match(read('app/api/internal/marketing-sync/route.ts'),/RESEND_MARKETING_CONTACT_SYNC_ENABLED !== 'true'/)],
  ['Presence endpoint requires same-origin and UUID',()=>{const s=read('app/api/analytics/presence/route.ts');assert.match(s,/req\.headers\.get\('origin'\)/);assert.match(s,/SID\.test\(value\.sid\)/)}],
  ['Presence endpoint rejects oversized chunked bodies',()=>assert.match(read('app/api/analytics/presence/route.ts'),/readLimitedJson\(req,128\)/)],
  ['Presence never initializes visitor identity',()=>assert.match(read('lib/funnel-client.ts'),/getExistingFunnelSessionIdIfConsented/)],
  ['STOP canonical suppression before pending clear',()=>{const s=read('app/api/twilio/incoming/route.ts');assert.ok(s.indexOf('suppressInboundSmsPhone(phone)') < s.indexOf('clearPendingKeyword(phone)'))}],
  ['Live endpoint authenticates',()=>assert.match(read('app/api/admin/analytics/live/route.ts'),/requireAdmin\(req\)/)],
  ['Live endpoint does not return customer PII',()=>{const s=read('lib/live-analytics.ts');assert.doesNotMatch(s,/(customer_email|phone_e164|shipping_address|ip_address)/)}],
  ['Live reports recent observations (not online)',()=>assert.match(read('lib/live-analytics.ts'),/recentlyObservedSessions/)],
  ['Marketing endpoint authenticates',()=>assert.match(read('app/api/admin/marketing/campaigns/route.ts'),/requireAdmin\(req\)/)],
  ['Marketing routes have no sending',()=>assert.doesNotMatch(read('app/api/admin/marketing/campaigns/route.ts'),/(sendSms|sendEmail|sendBroadcast|twilio\.messages\.create|resend\.emails\.send)/)],
  ['Marketing migration is later than 037',()=>assert.ok(existsSync(resolve(cwd,'db/migrations/038_marketing_suite_drafts.sql')))],
  ['Budget reservation remains disabled',()=>assert.match(read('db/migrations/039_marketing_budget_reservations.sql'),/RAISE EXCEPTION 'MARKETING_DISPATCH_DISABLED'/)],
  ['Utility tracking is not indexed',()=>assert.match(read('app/support/track/layout.tsx'),/index:false/)],
  ['Merchant Center feed is separately gated and never fabricates inventory',()=>{
    const s=read('app/feeds/google-products.xml/route.ts');
    assert.match(s,/KVRN_GOOGLE_MERCHANT_FEED_ENABLED/);
    assert.match(s,/CMS_PRODUCT_ROUTING/);
    assert.match(s,/listPublishedProducts\(\{includeUnlisted:false\}\)/);
    const core=read('lib/google-merchant-feed.ts');
    assert.match(core,/entry\.availability!=='InStock'/);
    assert.match(core,/entry\.availability!=='OutOfStock'/);
    assert.doesNotMatch(core,/customer_email|phone_e164|stripe_secret|ip_address/);
  }],
  ['Legacy coded PDP has canonical and verified-offer guard',()=>{
    const page=read('app/products/[slug]/page.tsx');
    assert.match(page,/alternates: \{ canonical: productPath\(product\.slug\) \}/);
    assert.match(page,/emitOffer: false/);
    assert.match(page,/product\.hidden \? \{ robots: \{ index: false, follow: true \} \}/);
    const schema=read('lib/product-seo.ts');
    assert.match(schema,/i\.emitOffer !== false/);
  }],
  ['Sitemap does not fabricate modification dates',()=>assert.doesNotMatch(read('app/sitemap.ts'),/lastModified:\s*new Date\(/)],
  ['Recipient-local quiet hours checked independently of send-wide boolean',()=>{
    const s=read('lib/marketing-dispatch-policy.ts');
    assert.match(s,/evaluateRecipientDeliveryWindow/);
    assert.match(s,/recipient_time_window_evidence_missing/);
  }],
  ['Browser smoke QA rejects production and blocks staging redirects to live site',()=>{
    for(const f of ['scripts/browser-smoke.mjs','scripts/browser-responsive-audit.mjs']){
      const s=read(f)
      assert.match(s,/kvrn\.shop/)
      assert.match(s,/route\.abort\('blockedbyclient'\)/)
    }
  }],
  ['Store-credit proposals never issue credit or merge cash settlements',()=>{
    const s=read('lib/store-credit-proposal.ts');
    assert.match(s,/assessDiscretionaryReturnCredit/);
    assert.match(s,/cash_refund_or_uncertain_status/);
    assert.match(s,/return_refund_allocation_or_unknown/);
    assert.match(s,/proposed_credit_exceeds_verified_merchandise/);
    assert.doesNotMatch(s,/\b(fetch\(|sql`|INSERT INTO|UPDATE\s+store_credit)/);
    const schema=read('db/migrations/041_store_credit_liability_foundation.sql');
    assert.match(schema,/idx_sc_terminal_hold[\s\S]*?event_type IN \('capture','release'\)/);
  }],
  ['Store-credit dashboard rejects unknown or inconsistent liabilities',()=>{
    const s=read('lib/store-credit-readiness.ts');
    assert.match(s,/inspectCreditLiabilityTotals/);
    assert.match(s,/integrity-warning/);
    assert.doesNotMatch(s,/Number\(r\.total_issued_cents\)/);
  }],
  ['Tracking not in coded sitemap',()=>assert.doesNotMatch(read('app/sitemap.ts'),/\{ url: `\$\{BASE\}\/support\/track`/)],
  ['Resend opt-in sync separately gated and audited',()=>{const s=read('app/api/internal/marketing-sync/route.ts');assert.match(s,/RESEND_MARKETING_OPT_IN_SYNC_ENABLED !== 'true'/);assert.match(s,/getVerifiedResendOptIn/);assert.match(read('lib/marketing-subscribers.ts'),/e.event_type = 'affirmative_checkbox'/)}],
  ['Resend provider suppression cannot be overwritten by contact upsert',()=>{const s=read('lib/resend-marketing.ts');assert.doesNotMatch(s,/unsubscribed: false/);assert.match(s,/Provider-suppressed contact requires reconciliation/)}],
  ['Resend missing IDs cannot falsely resolve suppression',()=>assert.match(read('lib/resend-marketing.ts'),/Provider contact ID missing; reconcile unsubscribe/)],
  ['Resend missing Topic config cannot falsely resolve suppression',()=>assert.match(read('lib/resend-marketing.ts'),/TOPIC_ID not configured; opt-out pending/)],
  ['Resend STOP outranks stale subscribe snapshots',()=>{const s=read('app/api/internal/marketing-sync/route.ts');assert.match(s,/getMarketingSyncState/);assert.match(s,/syncUnsubscribeFromResend/);assert.match(read('lib/marketing-subscribers.ts'),/status = 'unsubscribed' AND resend_contact_id IS NULL/)}],
  ['Marketing draft conflict never silently overwrites newer copy',()=>{const s=read('app/admin/marketing/MarketingClient.tsx');assert.match(s,/setStaleDraftId/);assert.match(s,/Your unsaved copy is preserved/);assert.match(s,/staleDraftId === selected.id/)}],
  ['Support email suppression requires Admin + confirmed same-origin request',()=>{const s=read('app/api/admin/marketing/suppress-email/route.ts');assert.match(s,/requireAdmin\(req\)/);assert.match(s,/readAdminMutationJson\(req,1024\)/);assert.match(s,/value.confirmed!==true/);assert.match(s,/suppressMarketingEmailFromSupport/)}],
  ['Unknown email support STOP records suppression without opt-in',()=>{const s=read('lib/marketing-subscribers.ts');assert.match(s,/INSERT INTO marketing_subscribers[\s\S]*?VALUES\(\$\{email\},'unsubscribed','manual_admin'/);assert.match(s,/recordUnsubscribeEvidence\(String\(rows\[0\]\.id\), 'support_staff'\)/)}],
  ['SMS message length displayed as estimate and not provider price',()=>{const s=read('app/admin/marketing/MarketingClient.tsx');assert.match(s,/composeMarketingSms/);assert.match(s,/not a carrier billing quote/);assert.match(read('lib/marketing-message-composer.ts'),/estimateSmsSegments\(text\)/);assert.match(read('lib/sms-segment-estimate.ts'),/estimatedOnly: true/)}],
  ['Resend suppression webhook rejects unsigned/unbounded requests',()=>{const r=read('app/api/resend/marketing-webhook/route.ts');assert.match(r,/verifyResendWebhook/);assert.match(r,/readLimitedText\(req,16_384\)/);assert.match(r,/RESEND_MARKETING_WEBHOOK_SUPPRESSION_ENABLED/);assert.match(r,/return json\(\{error:'Invalid webhook signature.'/);assert.match(read('lib/resend-webhook-suppression.ts'),/MAX_AGE_SECONDS=300/)}],
  ['Resend suppression writes are event-idempotent and append-only',()=>{const s=read('db/migrations/045_resend_webhook_suppression.sql');assert.match(s,/ON CONFLICT\(provider_event_id\) DO NOTHING/);assert.match(s,/marketing_email_consent_events/);assert.match(s,/RESEND_SUPPRESSION_EVENTS_APPEND_ONLY/)}],
  ['Resend webhook supports explicitly configured key rotation',()=>{const s=read('app/api/resend/marketing-webhook/route.ts');assert.match(s,/RESEND_MARKETING_WEBHOOK_PREVIOUS_SECRET/)}],
  ['Twilio webhooks cap request size and redact delivery-status logging',()=>{for(const p of ['app/api/twilio/incoming/route.ts','app/api/twilio/status/route.ts'])assert.match(read(p),/readLimitedText\(req,\s*4096\)/);const s=read('app/api/twilio/status/route.ts');assert.doesNotMatch(s,/console\.log\(.*sid/);assert.doesNotMatch(s,/err\?\.message/);assert.match(s,/status: 503/)}],
  ['Inbound STOP persistence failures are retryable',()=>{const s=read('app/api/twilio/incoming/route.ts');assert.ok(s.indexOf('if(KEYWORD_STOPS.has(keyword))')<s.indexOf('try{\n    if(keyword'));assert.match(s,/STOP persistence failed \(redacted\)/);assert.match(s,/status:503/);assert.doesNotMatch(read('lib/sms-signup-claims.ts'),/console\.error\(.*err\?\.message/)}],
  ['JOIN/YES DB failures are retryable not silently successful',()=>{const s=read('app/api/twilio/incoming/route.ts');assert.match(s,/Keyword consent persistence failed \(redacted\)/);assert.match(s,/return new NextResponse\('Temporary failure; retry required\.',\{status:503\}\)/)}],
  ['No general-purpose SMS consent upsert or resubscribe bypass',()=>{const s=read('lib/sms-subscribers.ts');assert.doesNotMatch(s,/export async function (upsertSmsSubscriber|resubscribeSmsPhone)\(/);assert.match(read('lib/sms-double-optin.ts'),/export async function confirmKeywordSms/)}],
  ['Resend opt-in requires authoritative GET contact status',()=>{const s=read('lib/resend-marketing.ts');assert.match(s,/contactState = await resendCall\('GET'/);assert.match(s,/providerRecord\?\.unsubscribed !== false/)}],
  ['SMS claim endpoints never print provider or database exception strings',()=>{for(const p of ['app/api/sms/claim/start/route.ts','app/api/sms/claim/resolve/route.ts']){const s=read(p);assert.doesNotMatch(s,/err\?\.message|console\.error\([^\n]*err/);assert.match(s,/redacted/)} }],
  ['New Admin marketing link',()=>assert.match(read('components/admin/AdminShell.tsx'),/href: '\/admin\/marketing'/)],
  ['New Admin live link',()=>assert.match(read('components/admin/AdminShell.tsx'),/href: '\/admin\/live'/)],
]
let passed=0
for(const [name,fn] of checks){try{fn();console.log('PASS',name);passed++}catch(e){console.error('FAIL',name,e.message);process.exitCode=1}}
console.log(`${passed}/${checks.length} development gates passed.`)
