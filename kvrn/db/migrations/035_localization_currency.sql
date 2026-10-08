-- KVRN Migration 035 — Localization & currency safety net
--
-- Additive only. Nothing in 001-034 is altered, dropped or replaced. Idempotent
-- (CREATE OR REPLACE of THIS migration's own function). Re-applying is a no-op.
-- Run after 001-034. NOT applied to production by the implementation batch.
--
-- WHY THIS EXISTS
-- ---------------
-- Customers are charged in USD only (finalize_paid_order / reserve_inventory reject any other
-- currency, and those functions are frozen). Every Admin money aggregate adds amount_cents
-- WITHOUT a currency filter, which is only correct while every row is USD. This migration does
-- not change a single formula; it adds a READ-ONLY detector so a non-USD row — which should be
-- impossible, and is the first symptom of someone enabling a foreign currency before the audit in
-- lib/i18n/currency-policy.ts is satisfied — is surfaced instead of being silently summed as USD.
--
-- No order/presentment columns are added: presentment_currency / presentment_total_cents /
-- fx_rate_used belong to the foreign-currency checkout work plan (lib/i18n/currency-policy.ts
-- CURRENCY_BLOCKERS), which is intentionally NOT implemented. Adding them now would only invite
-- code that writes them before the rest of the path is safe.

BEGIN;

CREATE OR REPLACE FUNCTION i18n_currency_anomalies()
RETURNS TABLE (source TEXT, record_id TEXT, currency TEXT, amount_cents BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT 'orders'::text,                       o.id::text,   o.currency, o.total_cents::bigint
    FROM orders o                    WHERE lower(o.currency) <> 'usd'
  UNION ALL
  SELECT 'order_refunds'::text,                r.id::text,   r.currency, r.amount_cents::bigint
    FROM order_refunds r             WHERE lower(r.currency) <> 'usd'
  UNION ALL
  SELECT 'order_disputes'::text,               d.id::text,   d.currency, d.amount_cents::bigint
    FROM order_disputes d            WHERE lower(d.currency) <> 'usd'
  UNION ALL
  SELECT 'dispute_balance_transactions'::text, b.id::text,   b.currency, b.amount_cents::bigint
    FROM dispute_balance_transactions b WHERE lower(b.currency) <> 'usd'
  UNION ALL
  SELECT 'payment_exceptions'::text,           x.id::text,   x.currency, x.amount_cents::bigint
    FROM payment_exceptions x        WHERE lower(x.currency) <> 'usd'
  UNION ALL
  SELECT 'abandoned_checkouts'::text,          a.id::text,   a.currency, 0::bigint
    FROM abandoned_checkouts a       WHERE lower(a.currency) <> 'usd'
$$;

COMMENT ON FUNCTION i18n_currency_anomalies() IS
  'Rows in money tables whose currency is not usd. Expected to return zero rows; read-only; changes no formula.';

COMMIT;
