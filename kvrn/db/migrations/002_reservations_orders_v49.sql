-- KVRN V49.4 Migration 002
-- Run ONCE: psql "$DATABASE_URL" -f db/migrations/002_reservations_orders_v49.sql
--
-- PREFLIGHT — run before migration to inspect existing relation names:
--   SELECT relname FROM pg_class WHERE relname IN (
--     'orders','order_items','shipments','inventory_reservations',
--     'orders_pkey','order_items_pkey','shipments_pkey',
--     'orders_stripe_payment_intent_id_key','orders_stripe_checkout_session_id_key'
--   ) ORDER BY relname;
--
-- POST-MIGRATION verify:
--   SELECT relname FROM pg_class WHERE relname IN (
--     'orders_legacy_v45','order_items_legacy_v45','shipments_legacy_v45',
--     'reservations','reservation_items','orders','order_items','shipments'
--   ) ORDER BY relname;

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 1: Safe rename of migration-001 placeholder tables + their indexes
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- shipments first (references orders)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='shipments')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='shipments_legacy_v45')
  THEN
    ALTER TABLE shipments RENAME TO shipments_legacy_v45;
    -- Rename PK so 'shipments_pkey' is free for the new table
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shipments_pkey')
    THEN ALTER TABLE shipments_legacy_v45 RENAME CONSTRAINT shipments_pkey TO shipments_legacy_v45_pkey; END IF;
    RAISE NOTICE 'Renamed shipments → shipments_legacy_v45';
  END IF;

  -- order_items before orders (FK dependency)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='order_items' AND column_name='product_name')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items_legacy_v45')
  THEN
    ALTER TABLE order_items RENAME TO order_items_legacy_v45;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_pkey')
    THEN ALTER TABLE order_items_legacy_v45 RENAME CONSTRAINT order_items_pkey TO order_items_legacy_v45_pkey; END IF;
    RAISE NOTICE 'Renamed order_items → order_items_legacy_v45';
  END IF;

  -- orders
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='orders')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='orders' AND column_name='fulfillment_status')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='orders_legacy_v45')
  THEN
    ALTER TABLE orders RENAME TO orders_legacy_v45;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_pkey')
    THEN ALTER TABLE orders_legacy_v45 RENAME CONSTRAINT orders_pkey TO orders_legacy_v45_pkey; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_stripe_payment_intent_id_key')
    THEN ALTER TABLE orders_legacy_v45 RENAME CONSTRAINT orders_stripe_payment_intent_id_key TO orders_legacy_v45_pi_key; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_stripe_checkout_session_id_key')
    THEN ALTER TABLE orders_legacy_v45 RENAME CONSTRAINT orders_stripe_checkout_session_id_key TO orders_legacy_v45_cs_key; END IF;
    RAISE NOTICE 'Renamed orders → orders_legacy_v45';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='inventory_reservations')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='inventory_reservations' AND column_name='status')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='inventory_reservations_legacy_v45')
  THEN
    ALTER TABLE inventory_reservations RENAME TO inventory_reservations_legacy_v45;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_reservations_pkey')
    THEN ALTER TABLE inventory_reservations_legacy_v45
         RENAME CONSTRAINT inventory_reservations_pkey TO inventory_reservations_legacy_v45_pkey; END IF;
    RAISE NOTICE 'Renamed inventory_reservations → inventory_reservations_legacy_v45';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='payments')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='payments_legacy_v45')
  THEN
    ALTER TABLE payments RENAME TO payments_legacy_v45;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_pkey')
    THEN ALTER TABLE payments_legacy_v45 RENAME CONSTRAINT payments_pkey TO payments_legacy_v45_pkey; END IF;
    RAISE NOTICE 'Renamed payments → payments_legacy_v45';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='checkout_sessions')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='checkout_sessions_legacy_v45')
  THEN
    ALTER TABLE checkout_sessions RENAME TO checkout_sessions_legacy_v45;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='checkout_sessions_pkey')
    THEN ALTER TABLE checkout_sessions_legacy_v45
         RENAME CONSTRAINT checkout_sessions_pkey TO checkout_sessions_legacy_v45_pkey; END IF;
    RAISE NOTICE 'Renamed checkout_sessions → checkout_sessions_legacy_v45';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 2: inventory_movements.reservation_id (safe nullable FK)
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='inventory_movements' AND column_name='reservation_id') THEN
    ALTER TABLE inventory_movements ADD COLUMN reservation_id UUID;
    RAISE NOTICE 'Added inventory_movements.reservation_id';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 3: Sequences
-- ════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1000 INCREMENT 1;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 4: Production tables (explicit collision-free constraint names)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reservations (
  id                         UUID        CONSTRAINT reservations_v49_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  status                     TEXT        NOT NULL DEFAULT 'creating'
    CONSTRAINT reservations_v49_status_chk
    CHECK (status IN ('creating','open','awaiting_payment','completed','released','failed')),
  stripe_checkout_session_id TEXT        CONSTRAINT reservations_v49_session_uq UNIQUE,
  expires_at                 TIMESTAMPTZ NOT NULL,
  completed_at               TIMESTAMPTZ,
  released_at                TIMESTAMPTZ,
  release_reason             TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation_items (
  id                UUID        CONSTRAINT reservation_items_v49_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id    UUID        NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  variant_id        UUID        NOT NULL REFERENCES product_variants(id),
  sku               TEXT        NOT NULL,
  product_name      TEXT        NOT NULL,
  size              TEXT        NOT NULL,
  color             TEXT        NOT NULL,
  quantity          INTEGER     NOT NULL CHECK (quantity > 0),
  unit_price_cents  INTEGER     NOT NULL CHECK (unit_price_cents >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_items_v49_uq UNIQUE (reservation_id, sku)
);

CREATE TABLE IF NOT EXISTS orders (
  id                          UUID        CONSTRAINT orders_v49_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number                TEXT        CONSTRAINT orders_v49_num_uq    UNIQUE NOT NULL,
  stripe_checkout_session_id  TEXT        CONSTRAINT orders_v49_cs_uq     UNIQUE NOT NULL,
  stripe_payment_intent_id    TEXT        CONSTRAINT orders_v49_pi_uq     UNIQUE,
  reservation_id              UUID        CONSTRAINT orders_v49_resv_uq   UNIQUE REFERENCES reservations(id),
  payment_status              TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT orders_v49_payment_status_chk
    CHECK (payment_status IN ('pending','paid','failed','refunded')),
  fulfillment_status          TEXT        NOT NULL DEFAULT 'unfulfilled'
    CONSTRAINT orders_v49_fulfillment_status_chk
    CHECK (fulfillment_status IN ('unfulfilled','processing','shipped','delivered','cancelled')),
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  subtotal_cents              INTEGER     NOT NULL DEFAULT 0,
  shipping_cents              INTEGER     NOT NULL DEFAULT 0,
  tax_cents                   INTEGER     NOT NULL DEFAULT 0,
  discount_cents              INTEGER     NOT NULL DEFAULT 0,
  total_cents                 INTEGER     NOT NULL DEFAULT 0,
  customer_email              TEXT,
  customer_name               TEXT,
  customer_phone              TEXT,
  shipping_address            JSONB,
  paid_at                     TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id                UUID        CONSTRAINT order_items_v49_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id        UUID        REFERENCES product_variants(id) ON DELETE SET NULL,
  sku               TEXT        NOT NULL,
  product_name      TEXT        NOT NULL,
  size              TEXT        NOT NULL,
  color             TEXT        NOT NULL,
  quantity          INTEGER     NOT NULL CHECK (quantity > 0),
  unit_price_cents  INTEGER     NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents  INTEGER     NOT NULL CHECK (line_total_cents >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipments (
  id              UUID        CONSTRAINT shipments_v49_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id),
  tracking_number TEXT,
  carrier         TEXT,
  shipped_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK for inventory_movements.reservation_id (reservations table now exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='inventory_movements_reservation_id_fkey'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT inventory_movements_reservation_id_fkey
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;
    RAISE NOTICE 'Added FK inventory_movements.reservation_id → reservations.id';
  END IF;
END $$;

-- Upgrade webhook_events
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='webhook_events' AND column_name='processed_at') THEN
    ALTER TABLE webhook_events ADD COLUMN processed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='webhook_events' AND column_name='result') THEN
    ALTER TABLE webhook_events ADD COLUMN result TEXT;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 5: Indexes
-- ════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_reservations_v49_status     ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_v49_session_id ON reservations(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_reservations_v49_expires    ON reservations(expires_at)
  WHERE status IN ('creating','open','awaiting_payment');
CREATE INDEX IF NOT EXISTS idx_resv_items_v49_reservation  ON reservation_items(reservation_id);
CREATE INDEX IF NOT EXISTS idx_resv_items_v49_variant      ON reservation_items(variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_v49_session          ON orders(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_v49_payment_intent   ON orders(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_v49_statuses         ON orders(payment_status, fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_order_items_v49_order       ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_movements_reservation   ON inventory_movements(reservation_id);
CREATE INDEX IF NOT EXISTS idx_webhook_v49_processed       ON webhook_events(stripe_event_id, processed);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='set_reservations_updated_at') THEN
    CREATE TRIGGER set_reservations_updated_at BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='set_orders_updated_at') THEN
    CREATE TRIGGER set_orders_updated_at BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- STEP 6: PL/pgSQL functions
-- Error format: KVRN_RESERVATION|CODE|detail  (no stock quantities)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reserve_inventory(
  p_items      JSONB,
  p_expires_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_reservation_id UUID;
  v_item           JSONB;
  v_variant        RECORD;
  v_available      INTEGER;
  v_qty            INTEGER;
  v_sku            TEXT;
BEGIN
  -- Defensive JSON validation
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|ITEMS_EMPTY';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= NOW() THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|EXPIRES_IN_PAST';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|ITEM_NOT_OBJECT';
    END IF;
    v_sku := v_item->>'sku';
    IF v_sku IS NULL OR v_sku = '' OR v_sku NOT LIKE 'KVRN-%' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_SKU|%', COALESCE(v_sku,'null');
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity') !~ '^\d+$'
       OR (v_item->>'quantity')::INTEGER < 1 OR (v_item->>'quantity')::INTEGER > 10 THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_QUANTITY|%', v_sku;
    END IF;
  END LOOP;
  IF (SELECT COUNT(*) FROM (
        SELECT j->>'sku' AS s FROM jsonb_array_elements(p_items) j
        GROUP BY 1 HAVING COUNT(*) > 1
      ) t) > 0 THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|DUPLICATE_SKU|MULTIPLE';
  END IF;

  INSERT INTO reservations (status, expires_at)
  VALUES ('creating', p_expires_at)
  RETURNING id INTO v_reservation_id;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(p_items) ORDER BY value->>'sku'
  LOOP
    v_sku := v_item->>'sku';
    v_qty := (v_item->>'quantity')::INTEGER;

    SELECT pv.id, pv.sku, pv.active, pv.stock_on_hand, pv.reserved_quantity,
           p.name AS product_name, p.price_cents, p.currency,
           p.active AS product_active, pv.size, pv.color_name
    INTO v_variant
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.sku = v_sku
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_SKU|%', v_sku; END IF;
    IF NOT v_variant.product_active OR NOT v_variant.active THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INACTIVE_VARIANT|%', v_sku;
    END IF;
    IF v_variant.currency <> 'usd' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_NOT_SUPPORTED|%', v_sku;
    END IF;

    v_available := v_variant.stock_on_hand - v_variant.reserved_quantity;
    IF v_available < v_qty THEN
      IF v_available <= 0 THEN RAISE EXCEPTION 'KVRN_RESERVATION|OUT_OF_STOCK|%', v_sku;
      ELSE RAISE EXCEPTION 'KVRN_RESERVATION|INSUFFICIENT_STOCK|%', v_sku; END IF;
    END IF;

    UPDATE product_variants
    SET reserved_quantity = reserved_quantity + v_qty, updated_at = NOW()
    WHERE id = v_variant.id;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
    VALUES
      (v_variant.id, v_qty, 'RESERVE', 'checkout_reservation',
       'reservation:' || v_reservation_id, 'system@kvrn.internal', v_reservation_id);

    INSERT INTO reservation_items
      (reservation_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents)
    VALUES
      (v_reservation_id, v_variant.id, v_sku,
       v_variant.product_name, v_variant.size, v_variant.color_name,
       v_qty, v_variant.price_cents);
  END LOOP;

  UPDATE reservations SET status='open', updated_at=NOW() WHERE id=v_reservation_id;

  RETURN (
    SELECT jsonb_build_object(
      'reservation_id', v_reservation_id,
      'expires_at', p_expires_at,
      'items', jsonb_agg(
        jsonb_build_object(
          'variant_id',      ri.variant_id,
          'sku',             ri.sku,
          'product_name',    ri.product_name,
          'size',            ri.size,
          'color',           ri.color,
          'unit_price_cents', ri.unit_price_cents,
          'quantity',        ri.quantity
        ) ORDER BY ri.sku
      )
    )
    FROM reservation_items ri WHERE ri.reservation_id = v_reservation_id
  );
END;
$$;

-- ── attach_stripe_session ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION attach_stripe_session(
  p_reservation_id         UUID,
  p_stripe_session_id      TEXT,
  p_stripe_expires_at_unix BIGINT
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE reservations
  SET stripe_checkout_session_id = p_stripe_session_id,
      expires_at = to_timestamp(p_stripe_expires_at_unix),
      status = CASE WHEN status='creating' THEN 'open' ELSE status END,
      updated_at = NOW()
  WHERE id=p_reservation_id AND status IN ('creating','open');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|ATTACH_FAILED|%', p_reservation_id;
  END IF;
END;
$$;

-- ── release_reservation_for_event ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_reservation_for_event(
  p_stripe_session_id TEXT,
  p_event_id          TEXT,
  p_event_type        TEXT,
  p_reason            TEXT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_res RECORD; v_item RECORD;
BEGIN
  INSERT INTO webhook_events (stripe_event_id, event_type, payload, processed)
  VALUES (p_event_id, p_event_type, '{"auto":true}'::jsonb, false)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  PERFORM id FROM webhook_events WHERE stripe_event_id=p_event_id FOR UPDATE;
  IF (SELECT processed FROM webhook_events WHERE stripe_event_id=p_event_id) THEN
    RETURN 'already_processed';
  END IF;

  SELECT id, status INTO v_res FROM reservations
  WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_event_id;
    RETURN 'no_reservation';
  END IF;
  IF v_res.status IN ('completed','released','failed') THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='already_released'
    WHERE stripe_event_id=p_event_id;
    RETURN 'already_released';
  END IF;

  FOR v_item IN
    SELECT ri.variant_id, ri.quantity, ri.reservation_id
    FROM reservation_items ri
    JOIN product_variants pv ON pv.id=ri.variant_id
    WHERE ri.reservation_id=v_res.id
    ORDER BY pv.sku
  LOOP
    UPDATE product_variants
    SET reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVARIANT_VIOLATION|reserved_quantity < quantity for reservation %', v_res.id;
    END IF;
    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'RELEASE', p_reason,
            'reservation:' || v_res.id || ' event:' || p_event_id,
            'system@kvrn.internal', v_item.reservation_id);
  END LOOP;

  UPDATE reservations SET status='released', release_reason=p_reason,
    released_at=NOW(), updated_at=NOW() WHERE id=v_res.id;
  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='released'
  WHERE stripe_event_id=p_event_id;
  RETURN 'released';
END;
$$;

-- ── release_reservation_by_id ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_reservation_by_id(
  p_reservation_id UUID,
  p_reason         TEXT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_res RECORD; v_item RECORD;
BEGIN
  SELECT id, status INTO v_res FROM reservations WHERE id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_res.status IN ('completed','released','failed') THEN RETURN 'already_released'; END IF;

  FOR v_item IN
    SELECT ri.variant_id, ri.quantity
    FROM reservation_items ri
    JOIN product_variants pv ON pv.id=ri.variant_id
    WHERE ri.reservation_id=v_res.id ORDER BY pv.sku
  LOOP
    UPDATE product_variants
    SET reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVARIANT_VIOLATION|reserved_quantity < quantity for reservation %', p_reservation_id;
    END IF;
    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'RELEASE', p_reason,
            'reservation:' || v_res.id, 'system@kvrn.internal', v_res.id);
  END LOOP;

  UPDATE reservations SET status='failed', release_reason=p_reason,
    released_at=NOW(), updated_at=NOW() WHERE id=v_res.id;
  RETURN 'released';
END;
$$;

-- ── finalize_paid_order ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finalize_paid_order(
  p_stripe_session_id     TEXT,
  p_reservation_id_hint   UUID,
  p_stripe_payment_intent TEXT,
  p_stripe_event_id       TEXT,
  p_event_type            TEXT,
  p_expected_currency     TEXT,
  p_amount_total          INTEGER,
  p_customer_email        TEXT,
  p_customer_name         TEXT,
  p_customer_phone        TEXT,
  p_shipping_address      JSONB
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_res      RECORD;
  v_item     RECORD;
  v_order_id UUID;
  v_order_num TEXT;
  v_subtotal  INTEGER := 0;
BEGIN
  -- Claim event with row-lock
  INSERT INTO webhook_events (stripe_event_id, event_type, payload, processed)
  VALUES (p_stripe_event_id, p_event_type, '{"auto":true}'::jsonb, false)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  PERFORM id FROM webhook_events WHERE stripe_event_id=p_stripe_event_id FOR UPDATE;
  IF (SELECT processed FROM webhook_events WHERE stripe_event_id=p_stripe_event_id) THEN
    SELECT id, order_number INTO v_order_id, v_order_num
    FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
    RETURN jsonb_build_object('outcome','already_processed','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  -- Lock reservation FIRST, then check for existing order (prevents TOCTOU)
  SELECT id, status, stripe_checkout_session_id INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id INTO v_res
    FROM reservations WHERE id=p_reservation_id_hint FOR UPDATE;
    IF FOUND THEN
      IF v_res.stripe_checkout_session_id IS NOT NULL
         AND v_res.stripe_checkout_session_id <> p_stripe_session_id THEN
        v_res.id := NULL;
      ELSIF v_res.stripe_checkout_session_id IS NULL THEN
        UPDATE reservations SET stripe_checkout_session_id=p_stripe_session_id, updated_at=NOW()
        WHERE id=v_res.id;
      END IF;
    END IF;
  END IF;

  -- After holding reservation lock, re-check for existing order
  SELECT id, order_number INTO v_order_id, v_order_num
  FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
  IF FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='already_had_order'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','already_had_order','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  IF v_res.id IS NULL THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','no_reservation','already_processed',false);
  END IF;
  IF v_res.status NOT IN ('open','awaiting_payment','creating') THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='reservation_not_eligible'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','reservation_not_eligible','already_processed',false);
  END IF;

  -- Validate (retryable — raises so transaction rolls back)
  IF lower(p_expected_currency) <> 'usd' THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_MISMATCH|got:%', p_expected_currency;
  END IF;
  SELECT COALESCE(SUM(unit_price_cents*quantity),0) INTO v_subtotal
  FROM reservation_items WHERE reservation_id=v_res.id;
  IF p_amount_total <> v_subtotal THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|AMOUNT_MISMATCH|stripe:% expected:%', p_amount_total, v_subtotal;
  END IF;

  v_order_num := 'KVRN-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0');
  INSERT INTO orders (
    order_number, stripe_checkout_session_id, stripe_payment_intent_id,
    reservation_id, payment_status, currency, subtotal_cents, total_cents,
    customer_email, customer_name, customer_phone, shipping_address, paid_at
  ) VALUES (
    v_order_num, p_stripe_session_id, NULLIF(p_stripe_payment_intent,''),
    v_res.id, 'paid', 'usd', v_subtotal, p_amount_total,
    p_customer_email, p_customer_name, p_customer_phone, p_shipping_address, NOW()
  ) RETURNING id INTO v_order_id;

  FOR v_item IN
    SELECT ri.variant_id, ri.sku, ri.product_name, ri.size, ri.color,
           ri.quantity, ri.unit_price_cents
    FROM reservation_items ri WHERE ri.reservation_id=v_res.id
    ORDER BY ri.sku
  LOOP
    INSERT INTO order_items (
      order_id, variant_id, sku, product_name, size, color,
      quantity, unit_price_cents, line_total_cents
    ) VALUES (
      v_order_id, v_item.variant_id, v_item.sku, v_item.product_name,
      v_item.size, v_item.color, v_item.quantity, v_item.unit_price_cents,
      v_item.unit_price_cents * v_item.quantity
    );

    UPDATE product_variants
    SET stock_on_hand=stock_on_hand-v_item.quantity,
        reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id
      AND stock_on_hand>=v_item.quantity AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|DEDUCT_INVARIANT|%', v_item.sku;
    END IF;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, order_id, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'DEDUCT', 'paid_order',
            'order:' || v_order_id || ' reservation:' || v_res.id,
            'system@kvrn.internal', v_order_id, v_res.id);
  END LOOP;

  UPDATE reservations SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=v_res.id;
  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='order_created'
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false);
END;
$$;

-- ── mark_awaiting_payment ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_awaiting_payment(
  p_stripe_session_id TEXT,
  p_stripe_event_id   TEXT,
  p_event_type        TEXT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_res RECORD; v_updated INTEGER;
BEGIN
  INSERT INTO webhook_events (stripe_event_id, event_type, payload, processed)
  VALUES (p_stripe_event_id, p_event_type, '{"auto":true}'::jsonb, false)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  PERFORM id FROM webhook_events WHERE stripe_event_id=p_stripe_event_id FOR UPDATE;
  IF (SELECT processed FROM webhook_events WHERE stripe_event_id=p_stripe_event_id) THEN
    RETURN 'already_processed';
  END IF;

  SELECT id, status INTO v_res FROM reservations
  WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN 'no_reservation';
  END IF;
  IF v_res.status NOT IN ('open','creating') THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='reservation_not_eligible'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN 'reservation_not_eligible';
  END IF;

  UPDATE reservations SET status='awaiting_payment', updated_at=NOW() WHERE id=v_res.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_change'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN 'no_change';
  END IF;

  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='awaiting_payment'
  WHERE stripe_event_id=p_stripe_event_id;
  RETURN 'awaiting_payment';
END;
$$;

-- ── release_expired_reservations ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_expired_reservations() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_res RECORD; v_item RECORD; v_count INTEGER := 0;
BEGIN
  FOR v_res IN
    SELECT id FROM reservations
    WHERE status IN ('creating','open','awaiting_payment') AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT ri.variant_id, ri.quantity
      FROM reservation_items ri
      JOIN product_variants pv ON pv.id=ri.variant_id
      WHERE ri.reservation_id=v_res.id ORDER BY pv.sku
    LOOP
      UPDATE product_variants
      SET reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
      WHERE id=v_item.variant_id AND reserved_quantity>=v_item.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|INVARIANT_VIOLATION|cleanup reservation %', v_res.id;
      END IF;
      INSERT INTO inventory_movements
        (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
      VALUES (v_item.variant_id, -v_item.quantity, 'RELEASE', 'expired_cleanup',
              'reservation:' || v_res.id, 'system@kvrn.internal', v_res.id);
    END LOOP;
    UPDATE reservations SET status='released', release_reason='expired_cleanup',
      released_at=NOW(), updated_at=NOW() WHERE id=v_res.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

COMMIT;

-- Post-migration verify
SELECT relname FROM pg_class
WHERE relname IN (
  'orders_legacy_v45','order_items_legacy_v45','shipments_legacy_v45',
  'reservations','reservation_items','orders','order_items','shipments'
) ORDER BY relname;
