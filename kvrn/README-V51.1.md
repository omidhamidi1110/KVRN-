# KVRN V51.1 — Transactional Order Email Foundation

## Files Changed / New

| File | Change |
|------|--------|
| `db/migrations/004_transactional_email_v51.sql` | New — `transactional_emails` outbox table + updated `finalize_paid_order` |
| `lib/email.ts` | Rewritten — USD formatter, V50 address shape, no GBP/pence/stale URLs |
| `lib/resend-adapter.ts` | New — injectable Resend adapter, deterministic idempotency key |
| `lib/transactional-email.ts` | New — outbox claiming, `processOneEmail`, `processPendingTransactionalEmails` |
| `app/api/stripe/webhook/route.ts` | Updated — attempt email after order creation, non-fatal failure |
| `lib/__tests__/reservations.test.ts` | Updated — 38 new V51.1 unit + integration tests |
| `README-V51.1.md` | This file |

## Migration 004

**Always test against TEST_DATABASE_URL first. Never use DATABASE_URL directly.**

```bash
# 1. Load local env
set -a && source .env.local && set +a

# 2. Apply to test database first (migration 002+003 must already be applied)
psql "$TEST_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f db/migrations/004_transactional_email_v51.sql

# 3. Run integration tests
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --runInBand

# 4. When tests pass — production only with PRODUCTION_MIGRATION_URL
psql "$PRODUCTION_MIGRATION_URL" \
  -v ON_ERROR_STOP=1 \
  -f db/migrations/004_transactional_email_v51.sql

# 5. Verify in production
psql "$PRODUCTION_MIGRATION_URL" -c "\d transactional_emails"
```

## Environment Variables

### Cloudflare Secrets (set as Worker secrets)

| Secret | Description |
|--------|-------------|
| `RESEND_API_KEY` | Resend API key (re_...) — required for email sending |

### Optional Cloudflare Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSACTIONAL_EMAIL_FROM` | `KVRN <orders@send.kvrn.shop>` | Visible sender address |
| `TRANSACTIONAL_EMAIL_REPLY_TO` | `support@kvrn.shop` | Reply-to address |

## Resend Setup Checklist

1. Create account at https://resend.com
2. Add domain `send.kvrn.shop` (or `kvrn.shop`) under Domains
3. Add DNS records as instructed (SPF, DKIM, DMARC)
4. Wait for domain verification (may take minutes to hours)
5. Create API key with Send permission only
6. Set `RESEND_API_KEY` as Cloudflare Worker secret:
   ```
   npx wrangler secret put RESEND_API_KEY
   ```
7. Optionally configure from/reply-to as Cloudflare variables

## Architecture

```
Stripe webhook
  → finalize_paid_order() PL/pgSQL   ← same DB transaction
  → transactional_emails INSERT
  → (transaction committed)
  → processOneEmail() (non-fatal)
    → SELECT FOR UPDATE SKIP LOCKED  ← prevents concurrent duplicate sends
    → loadOrderEmailData()           ← from Neon orders + order_items only
    → orderConfirmationHTML()        ← USD formatter, V50 address shape
    → resend-adapter.send()          ← deterministic idempotency key
    → UPDATE transactional_emails    ← sent or failed+retry
```

## Retry Schedule

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | +5 minutes |
| 3 | +30 minutes |
| 4 | +2 hours |
| 5 | +12 hours |

After 5 attempts, `next_attempt_at` becomes NULL (no further retries). Max attempt limit enforced in `processOneEmail`.

## Admin retry

```typescript
import { processPendingTransactionalEmails } from '@/lib/transactional-email'
import { getEmailProvider } from '@/lib/resend-adapter'
import { sql } from '@/lib/db'

await processPendingTransactionalEmails({ sql, provider: getEmailProvider(), limit: 50 })
```

No public retry endpoint. Use admin-authenticated endpoint when needed.

## Security

- No customer PII in operational logs
- No API keys in logs
- No secrets in source
- Email failure never affects order integrity
- Duplicate Stripe events cannot create duplicate email rows (UNIQUE constraint)
- Deterministic idempotency key reused across retries
- No List-Unsubscribe on transactional confirmation

## Deploy Path

1. Apply migration 004 to Neon (TEST then PRODUCTION_MIGRATION_URL)
2. Set `RESEND_API_KEY` as Cloudflare secret
3. Verify domain at Resend
4. Push to main → GitHub → Cloudflare pipeline deploys automatically
5. Do not overwrite `open-next.config.ts` or `wrangler.toml`
6. `ENABLE_STRIPE_TEST_CHECKOUT=false` remains default

## Honest Test Status

```
npm test -- --runInBand
  122 unit passed
   19 DB integration tests skipped — TEST_DATABASE_URL absent
    0 failed

npm run build
  ✓ Compiled — 36 static pages

Resend email delivery NOT tested — no sandbox delivery performed.
DB behavior (outbox creation, idempotency, retry) requires TEST_DATABASE_URL
with migration 004 applied to verify.
```

## NOT in V51.1

- Shipping confirmation email
- Review request email
- Waitlist email activation
- Admin orders dashboard
- Refund / cancellation email
- Scheduled Worker/cron for retry
- Public retry endpoint
