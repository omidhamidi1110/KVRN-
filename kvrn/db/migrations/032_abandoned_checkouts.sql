-- KVRN Migration 032 — Abandoned-checkout recovery
--
-- Additive only. Nothing in 001–031 is altered, dropped or replaced.
-- Idempotent: CREATE ... IF NOT EXISTS / CREATE OR REPLACE of this file's OWN function /
-- guarded DO blocks. Re-applying is a no-op. Not applied to production by the batch.
--
-- WHAT THIS IS
-- ------------
-- A small record of checkouts that were STARTED (a Stripe Checkout session + reservation
-- existed) so that, when one is abandoned without a paid order, the store can send at most
-- ONE restrained reminder email with a signed link back to a rebuilt bag.
--
--   abandoned_checkouts          one row per started checkout session (opaque id)
--   abandoned_checkout_events    append-only history (created, abandoned, queued, sent, ...)
--   abandoned_checkout_suppressions
--                                addresses that unsubscribed from recovery emails
--
-- WHAT THIS IS NOT
-- ----------------
--   * It does not keep stock reserved. The original reservation is left to expire exactly as
--     before; on resume the unchanged checkout creates a FRESH reservation.
--   * It holds NO card/payment data, no shipping address, no phone number.
--   * The cart snapshot is a reminder, NOT commerce truth: the price recorded in it
--     ("seenUnitPriceCents") is only used to tell the customer honestly that a price changed.
--     SKU, price, stock and discounts are always re-read from the canonical tables on resume.
--   * It never writes to orders / reservations / inventory. A recovered order is a normal
--     order; recovered_order_id only LINKS to it (revenue is therefore counted once, in orders).
--
-- STATES
--   active          checkout started, outcome not known yet
--   abandoned       session/reservation ended without a paid order
--   recovery_queued the single recovery email is queued (idempotent send key assigned)
--   recovery_sent   the email was handed to the provider
--   recovered       a checkout started from the recovery link was paid (recovered_order_id set)
--   completed       the checkout itself was paid (nothing to recover)
--   expired         the recovery window passed without a send
--   ineligible      deliberately not emailed (ineligible_reason says why)
--   send_failed     provider failure; bounded retries, see recovery_attempts

BEGIN;

CREATE TABLE IF NOT EXISTS abandoned_checkouts (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_checkout_session_id  TEXT        NOT NULL,
  reservation_id              UUID        REFERENCES reservations(id) ON DELETE SET NULL,
  -- Normalised (trim + lower) address the customer typed at checkout. NULL when none.
  email                       TEXT,
  locale                      TEXT,
  -- Presentment currency of the checkout (text; USD only until multi-currency ships).
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  -- [{"sku","quantity","variantId","productName","size","color","seenUnitPriceCents"}]
  cart                        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  discount_code               TEXT,
  bundle_context              JSONB,
  affiliate_session_id        TEXT,
  -- Set when THIS checkout was started from another row's recovery link.
  recovery_source_id          UUID        REFERENCES abandoned_checkouts(id) ON DELETE SET NULL,
  state                       TEXT        NOT NULL DEFAULT 'active',
  ineligible_reason           TEXT,
  recovery_attempts           INTEGER     NOT NULL DEFAULT 0,
  manual_retries              INTEGER     NOT NULL DEFAULT 0,
  send_claimed_at             TIMESTAMPTZ,
  next_attempt_at             TIMESTAMPTZ,
  last_error                  TEXT,
  recovery_send_key           TEXT,
  provider_message_id         TEXT,
  recovery_clicked_at         TIMESTAMPTZ,
  recovery_click_count        INTEGER     NOT NULL DEFAULT 0,
  recovered_order_id          UUID        REFERENCES orders(id) ON DELETE SET NULL,
  -- Order total in the ORDER's currency, copied at link time (gross; refunds are not netted here).
  recovery_revenue_cents      INTEGER,
  recovery_revenue_currency   TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abandoned_at                TIMESTAMPTZ,
  recovery_queued_at          TIMESTAMPTZ,
  recovery_sent_at            TIMESTAMPTZ,
  recovered_at                TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ac_session_uq          UNIQUE (stripe_checkout_session_id),
  CONSTRAINT ac_state_chk
    CHECK (state IN ('active','abandoned','recovery_queued','recovery_sent','recovered',
                     'completed','expired','ineligible','send_failed')),
  CONSTRAINT ac_cart_array_chk      CHECK (jsonb_typeof(cart) = 'array'),
  CONSTRAINT ac_currency_chk        CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT ac_attempts_chk        CHECK (recovery_attempts >= 0),
  CONSTRAINT ac_manual_retries_chk  CHECK (manual_retries BETWEEN 0 AND 1),
  CONSTRAINT ac_click_count_chk     CHECK (recovery_click_count >= 0),
  CONSTRAINT ac_ineligible_reason_chk
    CHECK (state <> 'ineligible' OR ineligible_reason IS NOT NULL),
  CONSTRAINT ac_sent_at_chk
    CHECK (state <> 'recovery_sent' OR recovery_sent_at IS NOT NULL),
  CONSTRAINT ac_recovered_at_chk
    CHECK (state <> 'recovered' OR recovered_at IS NOT NULL),
  CONSTRAINT ac_revenue_chk
    CHECK (recovery_revenue_cents IS NULL
           OR (recovery_revenue_cents >= 0 AND recovery_revenue_currency IS NOT NULL))
);

-- The idempotent send key: at most one row per key, and (by construction) one key per row.
CREATE UNIQUE INDEX IF NOT EXISTS ac_recovery_send_key_uq
  ON abandoned_checkouts (recovery_send_key) WHERE recovery_send_key IS NOT NULL;

-- One order can be linked to at most ONE abandoned checkout: recovered revenue is never
-- counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS ac_recovered_order_uq
  ON abandoned_checkouts (recovered_order_id) WHERE recovered_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ac_state_idx        ON abandoned_checkouts (state, abandoned_at);
CREATE INDEX IF NOT EXISTS ac_email_idx        ON abandoned_checkouts (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ac_reservation_idx  ON abandoned_checkouts (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ac_source_idx       ON abandoned_checkouts (recovery_source_id) WHERE recovery_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ac_created_idx      ON abandoned_checkouts (created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_abandoned_checkouts_updated_at') THEN
    CREATE TRIGGER set_abandoned_checkouts_updated_at BEFORE UPDATE ON abandoned_checkouts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── Append-only event history ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abandoned_checkout_events (
  id                    BIGSERIAL   PRIMARY KEY,
  abandoned_checkout_id UUID        NOT NULL REFERENCES abandoned_checkouts(id),
  event_type            TEXT        NOT NULL,
  -- Never holds secrets, tokens, addresses or card data. Short reason codes / counts only.
  detail                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ace_type_chk CHECK (event_type ~ '^[a-z_]{1,40}$')
);
CREATE INDEX IF NOT EXISTS ace_checkout_idx ON abandoned_checkout_events (abandoned_checkout_id, created_at);

CREATE OR REPLACE FUNCTION abandoned_checkout_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'abandoned_checkout_events is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_abandoned_checkout_events_append_only') THEN
    CREATE TRIGGER trg_abandoned_checkout_events_append_only
      BEFORE UPDATE OR DELETE ON abandoned_checkout_events
      FOR EACH ROW EXECUTE FUNCTION abandoned_checkout_events_append_only();
  END IF;
END $$;

-- ── Recovery-email suppression list ─────────────────────────────────────────
-- Addresses that used the unsubscribe link of a recovery email. Honoured in EVERY consent
-- mode. (An explicit later re-subscribe in marketing_subscribers lifts it — see the app.)
CREATE TABLE IF NOT EXISTS abandoned_checkout_suppressions (
  email                 TEXT        PRIMARY KEY,
  reason                TEXT        NOT NULL DEFAULT 'unsubscribed',
  abandoned_checkout_id UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acs_reason_chk CHECK (reason ~ '^[a-z_]{1,40}$')
);

-- ── Payment-state probe (read-only) ─────────────────────────────────────────
-- 'order'              a non-failed order exists for this checkout session / reservation
-- 'payment_exception'  money was captured for the session but needs manual handling
-- NULL                 nothing was paid.
-- Used inside the guarded UPDATEs of the sweep so a send can never race a conversion.
CREATE OR REPLACE FUNCTION abandoned_checkout_payment_state(p_session TEXT, p_reservation UUID)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM orders o
       WHERE (o.stripe_checkout_session_id = p_session
              OR (p_reservation IS NOT NULL AND o.reservation_id = p_reservation))
         AND o.payment_status <> 'failed'
    ) THEN 'order'
    WHEN EXISTS (
      SELECT 1 FROM payment_exceptions pe WHERE pe.stripe_checkout_session_id = p_session
    ) THEN 'payment_exception'
    ELSE NULL
  END
$$;

-- ── Queue the single recovery email (atomic, serialised) ─────────────────────
-- The ONLY place a row becomes 'recovery_queued'. A transaction-level advisory lock
-- serialises queueing, and the guarded UPDATE that follows takes a FRESH snapshot (READ
-- COMMITTED, new statement), so it always sees the previous queue's committed rows. That is
-- what makes the per-address cooldown race-free: two sweeps can never queue two reminders for
-- the same address. Returns TRUE when THIS call queued the row, FALSE when nothing changed
-- (already queued, paid, expired, in cooldown, ...). Never touches orders/reservations/stock.
CREATE OR REPLACE FUNCTION abandoned_checkout_queue(p_id UUID, p_now TIMESTAMPTZ, p_cooldown_days INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(727101);

  UPDATE abandoned_checkouts ac
     SET state = 'recovery_queued',
         recovery_queued_at = p_now,
         recovery_send_key = 'abandoned-recovery-v1:' || ac.id::text,
         next_attempt_at = p_now
   WHERE ac.id = p_id
     AND ac.state = 'abandoned'
     AND ac.recovery_send_key IS NULL
     AND ac.email IS NOT NULL
     AND ac.expires_at > p_now
     AND abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM abandoned_checkouts o
        WHERE o.email = ac.email AND o.id <> ac.id
          -- an email that is queued / out for delivery / failed, OR one that WAS sent and whose row has since
          -- moved on (recovered, completed by a late payment): the address was still mailed, so the
          -- cooldown must keep counting it
          AND (o.state IN ('recovery_queued','recovery_sent','send_failed') OR o.recovery_sent_at IS NOT NULL)
          AND o.recovery_queued_at > p_now - make_interval(days => p_cooldown_days))
  RETURNING ac.id INTO v_id;

  IF v_id IS NULL THEN RETURN FALSE; END IF;

  INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
  VALUES (v_id, 'queued', '{}'::jsonb);
  RETURN TRUE;
END;
$$;

COMMIT;

SELECT 'abandoned_checkouts' AS tbl, COUNT(*) FROM abandoned_checkouts;
