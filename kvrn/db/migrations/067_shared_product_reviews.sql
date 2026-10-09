-- KVRN CP67 — brand-wide product reviews, moderated and clearly attributed.
-- IMPORTANT: apply after 066. No existing order or inventory data is modified.
BEGIN;
CREATE TABLE IF NOT EXISTS kvrn_product_reviews (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 70),
 item_label TEXT NOT NULL CHECK(item_label IN ('Hoodie','Sweatpants','Other KVRN item')),
 rating SMALLINT NOT NULL CHECK(rating BETWEEN 1 AND 5),
 headline TEXT NOT NULL CHECK(length(headline) BETWEEN 3 AND 120),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 20 AND 2000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 moderated_at TIMESTAMPTZ,
 moderated_by TEXT,
 CHECK ((status = 'pending' AND moderated_at IS NULL) OR status <> 'pending')
);
CREATE INDEX IF NOT EXISTS idx_kvrn_reviews_public ON kvrn_product_reviews(created_at DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_kvrn_reviews_queue ON kvrn_product_reviews(created_at DESC) WHERE status = 'pending';
COMMENT ON TABLE kvrn_product_reviews IS 'One KVRN-wide customer review stream across products. Reviews are non-verified unless independently verified; new submissions are never public until human approved.';
COMMIT;
