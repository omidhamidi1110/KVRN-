# KVRN — ChatGPT Backend Checkpoint 48 (cumulative development)

Checkpoint 48 contains CP41 through CP47 and this change; independent Claude frontend/CMS/SEO branch is NOT merged. No deployment, production migration, provider config change, customer messages or payment occurred.

## Added: manual, owner-reviewed marketing execution endpoint

`POST /api/admin/marketing/execute-approved-once` invokes the existing server-private `attemptTrustedMarketingDeliveryOnce` coordinator for one exact owner-approved recipient claim. This closes the backend transport wiring gap between reviewed recipient evidence and the previously completed single-attempt Resend/Twilio transport.

Explicit gates are `MARKETING_OWNER_EXECUTION_HTTP_ENABLED`, `MARKETING_OWNER_SEND_RELEASE_ENABLED`, `MARKETING_SEND_ENABLED`, `MARKETING_PROVIDER_DELIVERY_ENABLED`, `MARKETING_CLAIM_RESOLVER_ENABLED`, `MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED`, and `MARKETING_PROVIDER_RECEIPTS_ENABLED`, all equal to `true`; `KVRN_RUNTIME_ENV` must be `staging` or `production`; production additionally requires `KVRN_MARKETING_PRODUCTION_OWNER_APPROVED=true`. This is OFF by default; none of these were set by the development work.

The route requires Admin authentication, confirmed configured KVRN owner identity, same-origin bounded JSON, and the exact confirmation `I AUTHORIZE ONE APPROVED MARKETING MESSAGE`. Input is an opaque exact recipient claim with member/plan/evidence/approval/budget references, not a phone, email or direct message body. The execution coordinator rechecks authoritative SQL, atomically claims at most once before transport, and forbids automatic retries. The response records provider state as provisional/unresolved, not delivered or billed; no scheduling, batch send or automatic activation exists. This endpoint MUST NOT be enabled until user authorization and isolated migration, trusted provider callback, financial, legal and delivery integration QA.

## Verification

`npm run qa:consolidated-offline` passes. New owner execution tests 8/8 cover disabled, every environment gate, auth rejection, strict request, and a mocked single call with unresolved state. All prior tests (recipient evidence, marketing batch, credit checkout, refunds, AI insights, Live Analytics) also pass. These tests do not prove integration with Stripe, Neon or Twilio/Resend. Draft SQL 038–064 remains unapplied.

## Remaining requirements

- Isolated real PostgreSQL migration and concurrency tests for 038–064, especially credit+Stripe paid-order finalization and return restoration. Full Next build/Jest unavailable in current exported environment because key dependencies are not installed.
- Test-mode Stripe checkout, expiration, webhook, partial returns/cash refunds, and financial reconciliation against real test-mode provider records; never enable live financial processing before user approval.
- Signed Resend/Twilio sandbox callback integration; cost settlements and marketing suppression rechecks, Twilio A2P and authoritative opt-out/reassigned-number clearance, regional law review. Never send messages without the user's separate authorization.
- Final conflict-safe merge with Claude's current branch (relative to shared CP08); full application, browser, accessibility, Merchant, GA4 and deployment QA.
