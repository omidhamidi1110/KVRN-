# KVRN consolidated development — checkpoint 02

Base: owner's **07ac61f** Codespaces source export (local synthetic baseline 83a2689). This document is a **source-development checkpoint, not a release**. All prior checkpoint-01/recovered changes are included in the cumulative patch ZIP; never apply multiple patches on top of each other.

## Additional work since recovered checkpoint (October 8)

- Marketing budget preflight now enforces proposed **email daily $2** as well as email monthly $10, SMS daily $3/monthly $15, and AI SMS monthly $5. A caller cannot raise owner maximums by passing customized limits; AI-initiated email dispatch explicitly prohibited. A valid preflight still permits *only a future attempt to reserve a budget*, not a send.
- Atomic budget SQL draft migration **046** now rejects reuse of previously settled/released budget reservations and of request keys reserved in earlier UTC days/months. Preserves idempotency for active same-day reservations. **046 remains unapplied**, and dispatch policy stays OFF.
- Added per-recipient quiet-hours checker requiring independently verified IANA timezone and jurisdictional rule approval, evaluated with date-specific DST. Conservative default 09:00-20:00 local, **not a legal compliance guarantee**. Marketing preflight now requires matching evidence for each recipient. This does not implement or enable any outbound delivery worker.
- Removed fabricated current timestamps from static sitemap last-modified fields. Product/CMS published-content timestamps are retained only where grounded.
- Added dependency-free budget/timezone/sitemap behavioral tests and expanded SQL/Jest source assertions.

## Verification / next steps

- Offline `node scripts/test-budget-and-sitemap-behavior.mjs`: 19/19 passed.
- Offline `node scripts/test-marketing-budget-reservations.mjs`: 12/12 passed.
- `node scripts/verify-new-syntax.mjs`: 105 changed TypeScript/TSX files, 0 syntax errors.
- Prior `npm run qa:consent-offline`: 41/41 static release gates passed.
- **NOT VERIFIED:** full Jest/TypeScript typechecking, production-style build, Playwright/WebKit, PostgreSQL migration/application/concurrency, actual provider send/billing, full CMS/SEO end-to-end behavior, Stripe credit checkout, security assessment and owner/counsel approval.

## Required isolation

No production write, Cloudflare deployment, Neon migration, paid Stripe test, Resend/Twilio broadcast, subscriber import, or AI external access has been authorized or performed. The consolidated package is for safe preservation and subsequent isolated staging review only.
