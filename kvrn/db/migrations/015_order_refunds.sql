-- KVRN Migration 015 — Refund accounting
--
-- PRINCIPLE: a refund NEVER mutates or deletes the original sale.
-- The order keeps its full original financial history; refunds are additive rows.
-- Reports subtract refunds from recognised revenue rather than rewriting it.
--
-- Deliberately NOT assumed (these are separate real-world events KVRN does not yet track):
--   * that Stripe returned its processing fee   -> fee_refunded_cents defaults to NULL/unknown
--   * that the product was physically returned  -> no inventory movement is created here
--   * that outbound shipping cost was recovered -> shipment label cost is untouched
-- Any of those must be recorded explicitly if and when they actually happen.
--
-- Idempotency: UNIQUE(stripe_refund_id) plus record_order_refund() below.
-- Stripe retries the same refund event repeatedly; a retry must never double-count.
--
-- Run after 001-014.

BEGIN;

CREATE TABLE IF NOT EXISTS order_refunds (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  -- Stripe's refund object id. The idempotency key for the whole table.
  stripe_refund_id         TEXT        NOT NULL,
  stripe_charge_id         TEXT,

  -- Total refunded to the customer for this refund event.
  amount_cents             INTEGER     NOT NULL CHECK (amount_cents > 0),
  currency                 TEXT        NOT NULL DEFAULT 'usd',

  -- Optional decomposition. Stripe does not provide this, so it stays NULL unless
  -- an admin attributes it. Reports must not infer it.
  merchandise_refund_cents INTEGER     CHECK (merchandise_refund_cents IS NULL OR merchandise_refund_cents >= 0),
  shipping_refund_cents    INTEGER     CHECK (shipping_refund_cents    IS NULL OR shipping_refund_cents    >= 0),
  tax_refund_cents         INTEGER     CHECK (tax_refund_cents         IS NULL OR tax_refund_cents         >= 0),

  -- Processing fee returned by Stripe, if any. NULL = unknown, NOT zero.
  fee_refunded_cents       INTEGER     CHECK (fee_refunded_cents IS NULL OR fee_refunded_cents >= 0),

  -- Only 'succeeded' refunds reduce recognised revenue.
  status                   TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed','canceled')),

  reason                   TEXT,
  refunded_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_refunds_stripe_uq UNIQUE (stripe_refund_id)
);

CREATE INDEX IF NOT EXISTS idx_or_order        ON order_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_or_refunded_at  ON order_refunds(refunded_at DESC)
  WHERE status = 'succeeded';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_refunds_updated_at') THEN
    CREATE TRIGGER set_order_refunds_updated_at BEFORE UPDATE ON order_refunds
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── record_order_refund() — idempotent upsert from the Stripe webhook ────────
--
-- Safe to call any number of times with the same stripe_refund_id.
--   first call  -> inserts, returns 'recorded'
--   later calls -> updates status/amount only, returns 'updated'
--   unknown PI  -> returns 'no_order' without raising (webhook still 200s)
--
-- Also maintains orders.payment_status: an order becomes 'refunded' only when the
-- cumulative succeeded refund total reaches the amount the customer actually paid.
-- Partial refunds deliberately leave payment_status = 'paid'.
CREATE OR REPLACE FUNCTION record_order_refund(
  p_stripe_refund_id  TEXT,
  p_payment_intent_id TEXT,
  p_charge_id         TEXT,
  p_amount_cents      INTEGER,
  p_currency          TEXT,
  p_status            TEXT,
  p_reason            TEXT,
  p_fee_refunded      INTEGER,
  p_refunded_at       TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id       UUID;
  v_order_total    INTEGER;
  v_existing_id    UUID;
  v_refunded_total INTEGER;
  v_outcome        TEXT;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('outcome','ignored_zero_amount');
  END IF;

  -- Resolve the order from the payment intent, then lock it.
  SELECT id, total_cents INTO v_order_id, v_order_total
  FROM orders
  WHERE stripe_payment_intent_id = p_payment_intent_id
  FOR UPDATE;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('outcome','no_order');
  END IF;

  SELECT id INTO v_existing_id
  FROM order_refunds WHERE stripe_refund_id = p_stripe_refund_id;

  IF v_existing_id IS NULL THEN
    INSERT INTO order_refunds (
      order_id, stripe_refund_id, stripe_charge_id, amount_cents, currency,
      fee_refunded_cents, status, reason, refunded_at
    ) VALUES (
      v_order_id, p_stripe_refund_id, NULLIF(p_charge_id,''), p_amount_cents,
      COALESCE(NULLIF(p_currency,''),'usd'), p_fee_refunded,
      COALESCE(NULLIF(p_status,''),'pending'), NULLIF(p_reason,''),
      COALESCE(p_refunded_at, NOW())
    )
    ON CONFLICT (stripe_refund_id) DO NOTHING;
    v_outcome := 'recorded';
  ELSE
    -- Replay or lifecycle transition (pending -> succeeded). Never duplicates a row.
    UPDATE order_refunds
    SET status             = COALESCE(NULLIF(p_status,''), status),
        amount_cents       = p_amount_cents,
        fee_refunded_cents = COALESCE(p_fee_refunded, fee_refunded_cents),
        refunded_at        = COALESCE(p_refunded_at, refunded_at),
        updated_at         = NOW()
    WHERE id = v_existing_id;
    v_outcome := 'updated';
  END IF;

  -- Only succeeded refunds count toward the order's refunded total.
  SELECT COALESCE(SUM(amount_cents),0) INTO v_refunded_total
  FROM order_refunds
  WHERE order_id = v_order_id AND status = 'succeeded';

  UPDATE orders
  SET payment_status = CASE
        WHEN v_refunded_total >= v_order_total THEN 'refunded'
        ELSE payment_status
      END,
      updated_at = NOW()
  WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'outcome',        v_outcome,
    'order_id',       v_order_id,
    'refunded_total', v_refunded_total,
    'fully_refunded', v_refunded_total >= v_order_total
  );
END;
$$;

COMMIT;

SELECT 'order_refunds' AS tbl, COUNT(*) FROM order_refunds;
